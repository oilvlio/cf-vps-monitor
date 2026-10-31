package main

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v3/host"
)

// 流量统计分工
//
//	Agent：只读取各网卡的内核累计计数器，原样上报（traffic_sample）。不保存「上次读数」，
//	       不算增量，不分日，也不知道流量重置日——本地没有任何流量状态文件。
//	服务端（Supabase）：保存各网卡的上次读数，据此换算增量（处理重启 / 计数器回绕 / 网卡增减），
//	       按 Agent 本地日期累计到 traffic_daily；月度流量 = [重置日, 今天] 的日增量之和，
//	       修改重置日只是换一个求和区间。
//
// 好处是 Agent 重装、容器无持久卷、状态目录没有写权限都不再影响流量统计。
// 代价见 README：月度总量的刷新节奏与 ping record 相近（约 2 分钟），而不是每次上报。

// TrafficCounter 是某块网卡自开机以来的累计字节数。
type TrafficCounter struct {
	Up   int64 `json:"up"`
	Down int64 `json:"down"`
}

// TrafficSample 是一次采样时各网卡的累计读数，服务端用它换算增量。
type TrafficSample struct {
	// Boot 是开机时间（Unix 秒），用来识别重启；取不到时为 0。
	Boot int64 `json:"boot,omitempty"`
	// Scope 是统计口径（参与统计的网卡集合的算法 + 用户的 nic 过滤）。口径变化时服务端重新起基线。
	Scope string `json:"scope"`
	// UTCOffset 是采样时本机相对 UTC 的偏移（秒）。服务端据此决定这次增量记在哪个本地日期，
	// 与旧版本「按 Agent 本地自然日」一致，且夏令时按每个样本各自的偏移处理。
	UTCOffset  int                       `json:"utc_offset"`
	Interfaces map[string]TrafficCounter `json:"interfaces"`
}

func shortHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])[:16]
}

func trafficCounterScope() string {
	// 统计口径的版本号。scope 一变，服务端丢弃各网卡的上次读数、按新口径重新起基线；
	// 已记录的日增量是各天的绝对量，与口径无关，原样保留。
	//
	// 因此**只要参与统计的网卡集合的算法变了，这里就必须跟着变**——
	// 不只是用户传的 --nic-include/--nic-exclude。v2 收敛到默认路由网卡、
	// 并把 wg/tun/ipip/warp 等隧道前缀加进内置排除表，raw 计数因此骤降；
	// 若沿用 v1 的 scope，旧基线会被当成有效值，负 delta 被当作计数器回绕处理，
	// 把整个物理网卡计数器再加一遍到当天（一次性虚增）。
	const counterBasisVersion = "v2-default-route"
	return shortHash(counterBasisVersion + "\n" + strings.TrimSpace(nicInclude) + "\n" + strings.TrimSpace(nicExclude))
}

// trafficBootUnix 返回开机时间（Unix 秒）。host.BootTime 在 Linux 上读 /proc/stat 的 btime，
// 并带缓存，开销远小于 host.Info。取不到返回 0（服务端此时只靠计数器回绕识别重启）。
func trafficBootUnix() int64 {
	boot, err := host.BootTime()
	if err != nil || boot == 0 {
		return 0
	}
	return int64(boot)
}

func counterToInt64(value uint64) int64 {
	const maxCounter = uint64(1) << 62
	if value > maxCounter {
		return int64(maxCounter)
	}
	return int64(value)
}

// buildTrafficSample 把各网卡读数整理成上报格式。没有网卡读数时返回 nil（此时不带 traffic_sample）。
func buildTrafficSample(perInterface map[string]interfaceCounters, now time.Time, bootUnix int64) *TrafficSample {
	if len(perInterface) == 0 {
		return nil
	}
	_, offset := now.Zone()
	sample := &TrafficSample{
		Boot:       bootUnix,
		Scope:      trafficCounterScope(),
		UTCOffset:  offset,
		Interfaces: make(map[string]TrafficCounter, len(perInterface)),
	}
	for name, counter := range perInterface {
		sample.Interfaces[name] = TrafficCounter{Up: counterToInt64(counter.sent), Down: counterToInt64(counter.recv)}
	}
	return sample
}

// normalizeTrafficResetDay 只用于解析已弃用的 --traffic-reset-day 参数：流量重置日现在只在服务端生效。
func normalizeTrafficResetDay(day int) int {
	if day < 1 {
		return 1
	}
	if day > 31 {
		return 31
	}
	return day
}
