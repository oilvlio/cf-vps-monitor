package main

import (
	"flag"
	"io"
	"testing"
)

func TestDisableGPUPrecedence(t *testing.T) {
	previousFlags, previousDisable := flag.CommandLine, disableGPU
	t.Cleanup(func() {
		flag.CommandLine, disableGPU = previousFlags, previousDisable
	})
	t.Setenv("CF_MONITOR_TOKEN", "")
	t.Setenv("CF_MONITOR_SERVER", "")
	t.Setenv("CF_MONITOR_NAME", "")
	t.Setenv("CF_MONITOR_MODE", "")
	t.Setenv("CF_MONITOR_MOUNT_INCLUDE", "")
	t.Setenv("CF_MONITOR_MOUNT_EXCLUDE", "")
	t.Setenv("CF_MONITOR_NIC_INCLUDE", "")
	t.Setenv("CF_MONITOR_NIC_EXCLUDE", "")
	t.Setenv("CF_MONITOR_ALLOW_HOST_LOAD", "")
	t.Setenv("CF_MONITOR_HOST_CPU_CORES", "")
	t.Setenv("CF_MONITOR_TRAFFIC_RESET_DAY", "")

	for _, tt := range []struct {
		name, environment string
		args              []string
		want              bool
	}{
		{"explicit flag wins over environment on", "1", []string{"--disable-gpu=false"}, false},
		{"environment on", "true", nil, true},
		{"environment numeric on", "1", nil, true},
		{"environment off", "0", nil, false},
		{"default off", "", nil, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			flags := flag.NewFlagSet("disable-gpu", flag.ContinueOnError)
			flags.SetOutput(io.Discard)
			flags.BoolVar(&disableGPU, "disable-gpu", false, "")
			flag.CommandLine = flags
			t.Setenv("CF_MONITOR_DISABLE_GPU", tt.environment)
			if err := flags.Parse(tt.args); err != nil {
				t.Fatal(err)
			}
			applyEnvDefaults()
			if disableGPU != tt.want {
				t.Fatalf("disableGPU=%v, want %v", disableGPU, tt.want)
			}
		})
	}
}
