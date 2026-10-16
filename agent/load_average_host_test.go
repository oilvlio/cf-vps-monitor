package main

import "testing"

// 运维显式开启 --allow-host-load / CF_MONITOR_ALLOW_HOST_LOAD 后，
// 即使容器内 /proc/loadavg 是宿主机口径，也必须继续上报。
func TestLoadAverageReportableAllowHostLoadOverridesTrustCheck(t *testing.T) {
	previous := allowHostLoad
	allowHostLoad = true
	t.Cleanup(func() { allowHostLoad = previous })
	if !loadAverageReportable() {
		t.Fatal("loadAverageReportable() = false with allowHostLoad enabled, want true")
	}
}
