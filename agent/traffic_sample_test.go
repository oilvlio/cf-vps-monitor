package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestBuildTrafficSampleCarriesRawCountersScopeBootAndLocalOffset(t *testing.T) {
	zone := time.FixedZone("UTC+8", 8*3600)
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, zone)
	sample := buildTrafficSample(map[string]interfaceCounters{
		"eth0": {sent: 1000, recv: 2000},
		"eth1": {sent: 5, recv: 6},
	}, now, 1_780_000_000)
	if sample == nil {
		t.Fatal("expected a sample")
	}
	if sample.Boot != 1_780_000_000 || sample.UTCOffset != 8*3600 || sample.Scope != trafficCounterScope() {
		t.Fatalf("sample metadata = %+v", sample)
	}
	want := map[string]TrafficCounter{"eth0": {Up: 1000, Down: 2000}, "eth1": {Up: 5, Down: 6}}
	if !reflect.DeepEqual(sample.Interfaces, want) {
		t.Fatalf("interfaces = %+v, want %+v（原样上报累计读数，不做任何增量 / 周期处理）", sample.Interfaces, want)
	}
}

// DST 切换：偏移取每个样本各自的值，而不是进程启动时的值。
func TestBuildTrafficSampleOffsetFollowsEachSamplesOwnClock(t *testing.T) {
	zone := time.FixedZone("EST", -5*3600)
	sample := buildTrafficSample(map[string]interfaceCounters{"eth0": {}}, time.Date(2026, 1, 15, 0, 0, 0, 0, zone), 0)
	if sample.UTCOffset != -5*3600 {
		t.Fatalf("offset = %d, want -18000", sample.UTCOffset)
	}
}

func TestBuildTrafficSampleIsNilWithoutInterfaces(t *testing.T) {
	if buildTrafficSample(nil, time.Now(), 0) != nil || buildTrafficSample(map[string]interfaceCounters{}, time.Now(), 0) != nil {
		t.Fatal("no interfaces → no sample, so the server never mistakes an empty read for a counter reset")
	}
}

func TestCounterToInt64ClampsInsteadOfWrapping(t *testing.T) {
	if got := counterToInt64(^uint64(0)); got <= 0 {
		t.Fatalf("a huge counter wrapped negative: %d", got)
	}
	if counterToInt64(123) != 123 {
		t.Fatal("ordinary values must pass through")
	}
}

// Agent 不再有任何本地流量状态：采样不会创建 traffic-state.json。
func TestSamplingNeverWritesLocalTrafficState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "traffic-state.json")
	t.Setenv("CF_MONITOR_TRAFFIC_STATE_FILE", path)
	buildTrafficSample(map[string]interfaceCounters{"eth0": {sent: 1, recv: 2}}, time.Now(), 1)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("sampling must not create a state file (stat err = %v)", err)
	}
}

func TestReportWireFormatCarriesSampleAndOmitsImportByDefault(t *testing.T) {
	report := Report{
		NetTotalUp: 7, NetTotalDown: 8,
		TrafficSample: &TrafficSample{Boot: 5, Scope: "s", UTCOffset: 3600, Interfaces: map[string]TrafficCounter{"eth0": {Up: 1, Down: 2}}},
	}
	encoded, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"boot": float64(5), "scope": "s", "utc_offset": float64(3600),
		"interfaces": map[string]any{"eth0": map[string]any{"up": float64(1), "down": float64(2)}}}
	if !reflect.DeepEqual(wire["traffic_sample"], want) {
		t.Fatalf("traffic_sample = %v, want %v", wire["traffic_sample"], want)
	}
	if _, present := wire["traffic_import"]; present {
		t.Fatal("traffic_import must only appear while a legacy import is pending")
	}
	empty, _ := json.Marshal(Report{})
	if strings.Contains(string(empty), "traffic_sample") || strings.Contains(string(empty), "traffic_import") {
		t.Fatalf("a report without NIC counters must not carry traffic fields: %s", empty)
	}
}
