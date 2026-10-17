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

func TestHostLoadScaleFactor(t *testing.T) {
	for _, tc := range []struct {
		name            string
		container, host int
		want            float64
	}{
		{"1 core container on 64 core host", 1, 64, 1.0 / 64},
		{"2 core container on 8 core host", 2, 8, 0.25},
		{"host not larger than container", 4, 4, 1},
		{"host smaller than container is a misconfiguration", 8, 4, 1},
		{"unknown host cores", 2, 0, 1},
		{"unknown container cores", 0, 8, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := hostLoadScaleFactor(tc.container, tc.host); got != tc.want {
				t.Fatalf("hostLoadScaleFactor(%d, %d) = %v, want %v", tc.container, tc.host, got, tc.want)
			}
		})
	}
}
