package main

import (
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// 旧版本 Agent 把流量按天存在本地的 traffic-state.json 里。流量统计搬到服务端后，
// 这份历史需要一次性交给服务端，否则升级当月的已有流量会丢。
//
// 流程：启动时只读地解析旧状态文件 → 把最近的日增量和上次的网卡读数随上报发给服务端 →
// 服务端确认入库（ack 里 traffic_imported）后，才把旧文件改名为 *.imported。
// 没收到确认之前不会动旧文件，重发是幂等的（服务端对同一天取较大值、只在尚无基线时采纳基线）。
// 导入完成后 Agent 本地不再有任何流量状态。

// TrafficDay 是旧版本地的一个日增量（本地自然日，YYYY-MM-DD）。
type TrafficDay struct {
	Date string `json:"date"`
	Up   int64  `json:"up"`
	Down int64  `json:"down"`
}

// TrafficBaseline 是旧版最后一次保存的网卡读数。新版第一次采样据此换算增量，
// 这样升级瞬间的那段流量不会漏记。
type TrafficBaseline struct {
	Scope      string                    `json:"scope"`
	Boot       int64                     `json:"boot,omitempty"`
	Interfaces map[string]TrafficCounter `json:"interfaces"`
}

// TrafficImport 是随上报发送的一次性导入包。
type TrafficImport struct {
	Days     []TrafficDay     `json:"days,omitempty"`
	Baseline *TrafficBaseline `json:"baseline,omitempty"`
}

const (
	// legacyImportMaxDays 只导入最近这么多天：计费周期最长约 31 天，更早的历史没有展示价值，
	// 同时让导入包保持在几 KB。
	legacyImportMaxDays = 100
	// legacyImportResendInterval 未收到确认时，最短多久把导入包再发一次。
	legacyImportResendInterval = 30 * time.Second
	// legacySupportedMaxVersion 是本文件能读懂的旧状态格式的最高版本（v2：逐日增量）。
	legacySupportedMaxVersion = 2
)

// legacyTrafficState 只声明导入需要的字段，其余旧字段（重置日、基线修复等）一律忽略。
type legacyTrafficState struct {
	Period         string `json:"period"`
	Scope          string `json:"scope"`
	PeriodUp       int64  `json:"period_up"`
	PeriodDown     int64  `json:"period_down"`
	LastBootUnix   int64  `json:"last_boot_unix"`
	CounterVersion int    `json:"counter_version"`
	Interfaces     map[string]struct {
		Sent uint64 `json:"sent"`
		Recv uint64 `json:"recv"`
	} `json:"interfaces"`
	Revision uint64 `json:"revision"`
	Days     map[string]struct {
		Up   int64 `json:"up"`
		Down int64 `json:"down"`
	} `json:"days"`
}

type legacyTrafficImport struct {
	mu       sync.Mutex
	payload  *TrafficImport
	files    []string
	lastSent time.Time
	done     bool
}

// legacyImport 为 nil 表示没有（或已经完成）旧历史导入。
var legacyImport *legacyTrafficImport

func trafficStatePath() string {
	if override := strings.TrimSpace(os.Getenv("CF_MONITOR_TRAFFIC_STATE_FILE")); override != "" {
		return override
	}
	if exePath, err := os.Executable(); err == nil {
		if dir := filepath.Dir(exePath); strings.TrimSpace(dir) != "" && dir != "." {
			return filepath.Join(dir, "traffic-state.json")
		}
	}
	baseDir, err := os.UserConfigDir()
	if err != nil || strings.TrimSpace(baseDir) == "" {
		baseDir = os.TempDir()
	}
	return filepath.Join(baseDir, "cf-vps-monitor-agent", "traffic-state.json")
}

// legacyStateCandidates 列出旧版可能留下的状态文件（主文件、备份、暂存），顺序即同版本时的优先级。
func legacyStateCandidates(path string) []string {
	paths := []string{path, path + ".bak", path + ".tmp"}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		return paths
	}
	base := filepath.Base(path)
	for _, entry := range entries {
		name := entry.Name()
		if !entry.IsDir() && (strings.HasPrefix(name, base+".tmp-") || strings.HasPrefix(name, base+".backup-")) {
			paths = append(paths, filepath.Join(filepath.Dir(path), name))
		}
	}
	return paths
}

func decodeLegacyState(data []byte) (legacyTrafficState, error) {
	var state legacyTrafficState
	if err := json.Unmarshal(data, &state); err != nil {
		return state, err
	}
	if state.CounterVersion < 0 || state.CounterVersion > legacySupportedMaxVersion {
		return state, errors.New("unsupported traffic state version")
	}
	return state, nil
}

// buildLegacyImport 把旧状态折算成导入包：v2 直接取逐日增量；v0/v1 只有「当期累计」，整块记在周期起始日。
func buildLegacyImport(state legacyTrafficState, now time.Time) *TrafficImport {
	cutoff := now.AddDate(0, 0, -legacyImportMaxDays).Format(time.DateOnly)
	days := make(map[string]TrafficDay)
	add := func(date string, up, down int64) {
		if up < 0 || down < 0 || (up == 0 && down == 0) || date < cutoff {
			return
		}
		if _, err := time.Parse(time.DateOnly, date); err != nil {
			return
		}
		entry := days[date]
		entry.Date = date
		entry.Up += up
		entry.Down += down
		days[date] = entry
	}
	if state.CounterVersion >= 2 {
		for date, entry := range state.Days {
			add(date, entry.Up, entry.Down)
		}
	} else if state.Period != "" {
		add(state.Period, state.PeriodUp, state.PeriodDown)
	}
	result := &TrafficImport{}
	for _, day := range days {
		result.Days = append(result.Days, day)
	}
	sort.Slice(result.Days, func(i, j int) bool { return result.Days[i].Date < result.Days[j].Date })
	if state.CounterVersion >= 1 && state.Scope != "" && len(state.Interfaces) > 0 {
		baseline := &TrafficBaseline{Scope: state.Scope, Boot: state.LastBootUnix, Interfaces: make(map[string]TrafficCounter, len(state.Interfaces))}
		for name, counter := range state.Interfaces {
			baseline.Interfaces[name] = TrafficCounter{Up: counterToInt64(counter.Sent), Down: counterToInt64(counter.Recv)}
		}
		result.Baseline = baseline
	}
	if len(result.Days) == 0 && result.Baseline == nil {
		return nil
	}
	return result
}

// loadLegacyTrafficImport 读取旧状态文件并准备导入包；没有旧文件、读不懂或无内容可导入时返回 nil。
// 它从不修改、删除旧文件（导入确认后才由 finish 改名）。
func loadLegacyTrafficImport(path string, now time.Time) *legacyTrafficImport {
	var best legacyTrafficState
	var existing []string
	found := false
	for _, candidate := range legacyStateCandidates(path) {
		data, err := os.ReadFile(candidate)
		if err != nil {
			continue
		}
		existing = append(existing, candidate)
		state, err := decodeLegacyState(data)
		if err != nil {
			log.Printf("legacy traffic state %s ignored: %v", filepath.Base(candidate), err)
			continue
		}
		if !found || state.Revision > best.Revision {
			best, found = state, true
		}
	}
	if len(existing) == 0 {
		return nil
	}
	imported := &legacyTrafficImport{files: existing}
	if found {
		imported.payload = buildLegacyImport(best, now)
	}
	if imported.payload == nil {
		// 没有可导入的内容（空文件 / 全部读不懂 / 只有过期数据）：不必等服务端确认。
		if found {
			imported.finish()
		}
		return nil
	}
	log.Printf("legacy traffic history found: %d day(s) will be imported to the server", len(imported.payload.Days))
	return imported
}

// attach 把导入包挂到这一批 report 的第一份上；未确认期间最多每 legacyImportResendInterval 重发一次。
func (l *legacyTrafficImport) attach(reports []Report, now time.Time) []Report {
	if l == nil || len(reports) == 0 {
		return reports
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.done || l.payload == nil || (!l.lastSent.IsZero() && now.Sub(l.lastSent) < legacyImportResendInterval) {
		return reports
	}
	l.lastSent = now
	reports[0].TrafficImport = l.payload
	return reports
}

// finish 在服务端确认导入后调用：把旧状态文件全部改名为 *.imported，之后不会再被读取。
func (l *legacyTrafficImport) finish() {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.done {
		return
	}
	l.done = true
	for _, file := range l.files {
		if err := os.Rename(file, file+".imported"); err != nil && !errors.Is(err, os.ErrNotExist) {
			log.Printf("legacy traffic state %s could not be renamed after import: %v", filepath.Base(file), err)
		}
	}
	log.Printf("legacy traffic history imported; old state files renamed to *.imported")
}

func attachTrafficImport(reports []Report) []Report {
	return legacyImport.attach(reports, time.Now())
}
