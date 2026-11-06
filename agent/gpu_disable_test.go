package main

import (
	"flag"
	"io"
	"testing"
)

func TestEnableGPUPrecedence(t *testing.T) {
	previousFlags, previousEnable := flag.CommandLine, enableGPU
	t.Cleanup(func() {
		flag.CommandLine, enableGPU = previousFlags, previousEnable
	})
	for _, name := range []string{"TOKEN", "SERVER", "NAME", "MODE", "MOUNT_INCLUDE", "MOUNT_EXCLUDE", "NIC_INCLUDE", "NIC_EXCLUDE", "ALLOW_HOST_LOAD", "HOST_CPU_CORES", "LOG_LEVEL"} {
		t.Setenv("CF_MONITOR_"+name, "")
	}

	for _, tt := range []struct {
		name, environment string
		args              []string
		want              bool
	}{
		{"explicit flag wins over environment on", "1", []string{"--enable-gpu=false"}, false},
		{"explicit flag wins over environment off", "0", []string{"--enable-gpu"}, true},
		{"environment on", "true", nil, true},
		{"environment numeric on", "1", nil, true},
		{"environment off", "0", nil, false},
		{"default off", "", nil, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			flags := flag.NewFlagSet("enable-gpu", flag.ContinueOnError)
			flags.SetOutput(io.Discard)
			flags.BoolVar(&enableGPU, "enable-gpu", false, "")
			flag.CommandLine = flags
			t.Setenv("CF_MONITOR_ENABLE_GPU", tt.environment)
			if err := flags.Parse(tt.args); err != nil {
				t.Fatal(err)
			}
			applyEnvDefaults()
			if enableGPU != tt.want {
				t.Fatalf("enableGPU=%v, want %v", enableGPU, tt.want)
			}
		})
	}
}

func TestAllowHostLoadEnvironment(t *testing.T) {
	previousFlags, previousAllow := flag.CommandLine, allowHostLoad
	t.Cleanup(func() { flag.CommandLine, allowHostLoad = previousFlags, previousAllow })
	for _, name := range []string{"TOKEN", "SERVER", "NAME", "MODE", "MOUNT_INCLUDE", "MOUNT_EXCLUDE", "NIC_INCLUDE", "NIC_EXCLUDE", "HOST_CPU_CORES", "LOG_LEVEL", "ENABLE_GPU"} {
		t.Setenv("CF_MONITOR_"+name, "")
	}
	for _, tt := range []struct {
		name, environment string
		args              []string
		want              bool
	}{
		{"default on", "", nil, true},
		{"environment off", "0", nil, false},
		{"environment false", "false", nil, false},
		{"environment on", "1", nil, true},
		{"explicit flag wins over environment", "1", []string{"--allow-host-load=false"}, false},
	} {
		t.Run(tt.name, func(t *testing.T) {
			flags := flag.NewFlagSet("allow-host-load", flag.ContinueOnError)
			flags.SetOutput(io.Discard)
			flags.BoolVar(&allowHostLoad, "allow-host-load", true, "")
			flag.CommandLine = flags
			t.Setenv("CF_MONITOR_ALLOW_HOST_LOAD", tt.environment)
			if err := flags.Parse(tt.args); err != nil {
				t.Fatal(err)
			}
			applyEnvDefaults()
			if allowHostLoad != tt.want {
				t.Fatalf("allowHostLoad=%v, want %v", allowHostLoad, tt.want)
			}
		})
	}
}
