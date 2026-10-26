package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func dailyTrafficFixture(t *testing.T) (string, time.Time) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "traffic-state.json")
	t.Setenv("CF_MONITOR_TRAFFIC_STATE_FILE", path)
	return path, time.Date(2026, 8, 20, 0, 0, 0, 0, time.UTC)
}

func wantTraffic(t *testing.T, label string, up, down, wantUp, wantDown int64) {
	t.Helper()
	if up != wantUp || down != wantDown {
		t.Fatalf("%s: got %d/%d, want %d/%d", label, up, down, wantUp, wantDown)
	}
}

// 按天记增量，月度流量 = 周期内日桶之和；改重置日只换窗口，不清零。
func TestDailyBucketsMonthlyTotalFollowsResetDay(t *testing.T) {
	_, base := dailyTrafficFixture(t)
	boot := base.AddDate(0, -2, 0)
	tracker := newTrafficResetTracker(1, "token", "wan")
	counters := func(up, down uint64) map[string]interfaceCounters {
		return map[string]interfaceCounters{"eth0": {sent: up, recv: down}}
	}

	// 9/2 +100/+10、9/10 +200/+20、9/20 +400/+40（每天先起基线再记增量）。
	days := []struct {
		date     time.Time
		up, down uint64
	}{
		{time.Date(2026, 9, 2, 8, 0, 0, 0, time.UTC), 1000, 100},
		{time.Date(2026, 9, 10, 8, 0, 0, 0, time.UTC), 1100, 110},
		{time.Date(2026, 9, 20, 8, 0, 0, 0, time.UTC), 1300, 130},
	}
	tracker.adjustInterfacesSinceBoot(counters(900, 90), days[0].date.Add(-time.Hour), boot)
	var up, down int64
	for _, d := range days {
		up, down = tracker.adjustInterfacesSinceBoot(counters(d.up, d.down), d.date, boot)
	}
	// 9/2: 1000-900=100；9/10: +100；9/20: +200 ⇒ 400/40
	wantTraffic(t, "reset day 1", up, down, 400, 40)

	at := days[2].date.Add(time.Minute)
	steady := counters(1300, 130)
	for _, tc := range []struct {
		name         string
		day          int
		wantUp, want int64
	}{
		{"reset day 15 only keeps 9/20", 15, 200, 20},
		{"reset day 10 keeps 9/10 and 9/20", 10, 300, 30},
		{"reset day 20 keeps 9/20 only", 20, 200, 20},
		{"reset day 21 starts a new period (8/21), keeps everything after", 21, 400, 40},
		{"back to day 1 recovers the full month", 1, 400, 40},
	} {
		tracker.setResetDay(tc.day)
		up, down = tracker.adjustInterfacesSinceBoot(steady, at, boot)
		wantTraffic(t, tc.name, up, down, tc.wantUp, tc.want)
	}
}

// 到了新的计费周期，上个周期的日桶自然被排除在外，历史仍保留。
func TestDailyBucketsRotateWithoutLosingHistory(t *testing.T) {
	path, _ := dailyTrafficFixture(t)
	boot := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	tracker := newTrafficResetTracker(1, "token", "wan")
	c := func(v uint64) map[string]interfaceCounters {
		return map[string]interfaceCounters{"eth0": {sent: v, recv: v * 2}}
	}
	tracker.adjustInterfacesSinceBoot(c(0), time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC), boot)
	up, down := tracker.adjustInterfacesSinceBoot(c(500), time.Date(2026, 9, 30, 23, 0, 0, 0, time.UTC), boot)
	wantTraffic(t, "end of September", up, down, 500, 1000)
	up, down = tracker.adjustInterfacesSinceBoot(c(800), time.Date(2026, 10, 1, 9, 0, 0, 0, time.UTC), boot)
	wantTraffic(t, "new period starts from 10/1", up, down, 300, 600)

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var saved trafficResetState
	if err := json.Unmarshal(data, &saved); err != nil {
		t.Fatal(err)
	}
	if saved.CounterVersion != 2 || saved.Days["2026-09-30"].Up != 500 || saved.Days["2026-10-01"].Up != 300 {
		t.Fatalf("daily buckets were not persisted: %+v", saved)
	}
}

// 重启进程后日桶仍在，改重置日也不受影响。
func TestDailyBucketsSurviveRestartAndResetDayChange(t *testing.T) {
	dailyTrafficFixture(t)
	boot := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	c := func(v uint64) map[string]interfaceCounters {
		return map[string]interfaceCounters{"eth0": {sent: v, recv: v}}
	}
	first := newTrafficResetTracker(1, "token", "wan")
	first.adjustInterfacesSinceBoot(c(100), time.Date(2026, 9, 3, 8, 0, 0, 0, time.UTC), boot)
	first.adjustInterfacesSinceBoot(c(400), time.Date(2026, 9, 3, 9, 0, 0, 0, time.UTC), boot)

	second := newTrafficResetTracker(5, "token", "wan") // 重启时换了本地重置日
	up, down := second.adjustInterfacesSinceBoot(c(450), time.Date(2026, 9, 12, 9, 0, 0, 0, time.UTC), boot)
	// 重置日 5：周期自 9/5，9/3 的 300 被排除，只剩 9/12 的 50。
	wantTraffic(t, "after restart with reset day 5", up, down, 50, 50)
	second.setResetDay(1)
	up, down = second.adjustInterfacesSinceBoot(c(450), time.Date(2026, 9, 12, 9, 1, 0, 0, time.UTC), boot)
	wantTraffic(t, "back to reset day 1", up, down, 350, 350)
}

// 统计口径（网卡集合）变化时按新口径重新起算：不沿用旧口径的日桶，也不会把整个计数器再加一遍。
func TestDailyBucketsScopeChangeRestartsWithoutInflating(t *testing.T) {
	dailyTrafficFixture(t)
	boot := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	old := newTrafficResetTracker(1, "token", "scope-a")
	old.adjustInterfacesSinceBoot(map[string]interfaceCounters{"eth0": {sent: 1000, recv: 1000}}, now, boot)
	up, down := old.adjustInterfacesSinceBoot(map[string]interfaceCounters{"eth0": {sent: 1500, recv: 1500}}, now.Add(time.Minute), boot)
	wantTraffic(t, "old scope", up, down, 500, 500)

	changed := newTrafficResetTracker(1, "token", "scope-b")
	huge := map[string]interfaceCounters{"eth0": {sent: 1500, recv: 1500}, "wg0": {sent: 9_000_000, recv: 9_000_000}}
	up, down = changed.adjustInterfacesSinceBoot(huge, now.Add(2*time.Minute), boot)
	wantTraffic(t, "scope change round", up, down, 0, 0)
	huge["wg0"] = interfaceCounters{sent: 9_000_100, recv: 9_000_100}
	up, down = changed.adjustInterfacesSinceBoot(huge, now.Add(3*time.Minute), boot)
	wantTraffic(t, "next round counts only deltas", up, down, 100, 100)
}

// 日桶只保留一年，更早的被清掉，避免状态文件无限增长。
func TestDailyBucketsArePruned(t *testing.T) {
	dailyTrafficFixture(t)
	boot := time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)
	tracker := newTrafficResetTracker(1, "token", "wan")
	c := func(v uint64) map[string]interfaceCounters {
		return map[string]interfaceCounters{"eth0": {sent: v, recv: v}}
	}
	old := time.Date(2025, 1, 10, 8, 0, 0, 0, time.UTC)
	tracker.adjustInterfacesSinceBoot(c(0), old.Add(-time.Hour), boot)
	tracker.adjustInterfacesSinceBoot(c(10), old, boot)
	recent := old.AddDate(0, 0, trafficDayRetentionDays+5)
	tracker.adjustInterfacesSinceBoot(c(20), recent, boot)
	if _, kept := tracker.state.Days["2025-01-10"]; kept {
		t.Fatal("bucket older than the retention window was not pruned")
	}
	if got := tracker.state.Days[recent.Format(time.DateOnly)].Up; got != 10 {
		t.Fatalf("recent bucket = %d, want 10", got)
	}
}

// v1（当期累计）状态升级到日桶：当期总量保持不变，之后正常累加。
func TestDailyBucketsMigrateFromPeriodTotals(t *testing.T) {
	path, _ := dailyTrafficFixture(t)
	legacy := `{"reset_day":1,"period":"2026-09-01","scope":"wan","last_raw_up":1000,"last_raw_down":2000,` +
		`"period_up":700,"period_down":900,"counter_version":1,"interfaces":{"eth0":{"sent":1000,"recv":2000}},"reset_day_source":"local","revision":3}`
	if err := os.WriteFile(path, []byte(legacy), 0600); err != nil {
		t.Fatal(err)
	}
	boot := time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC)
	now := time.Date(2026, 9, 6, 12, 0, 0, 0, time.UTC)
	tracker := newTrafficResetTracker(1, "token", "wan")
	up, down := tracker.adjustInterfacesSinceBoot(map[string]interfaceCounters{"eth0": {sent: 1100, recv: 2300}}, now, boot)
	wantTraffic(t, "first round after upgrade", up, down, 800, 1200)

	// 升级后改重置日：旧累计落在 9/1，新周期起点早于它时仍然保留。
	tracker.setResetDay(28)
	up, down = tracker.adjustInterfacesSinceBoot(map[string]interfaceCounters{"eth0": {sent: 1100, recv: 2300}}, now.Add(time.Minute), boot)
	wantTraffic(t, "reset day 28 (period 8/28)", up, down, 800, 1200)
}
