package main

import (
	"bytes"
	"log"
	"strings"
	"testing"
)

func TestParseLogLevel(t *testing.T) {
	for input, want := range map[string]int32{
		"": logLevelInfo, "info": logLevelInfo, " DEBUG ": logLevelDebug,
		"warn": logLevelWarn, "Warning": logLevelWarn, "error": logLevelError,
	} {
		got, err := parseLogLevel(input)
		if err != nil || got != want {
			t.Fatalf("parseLogLevel(%q) = %d, %v; want %d", input, got, err, want)
		}
	}
	if _, err := parseLogLevel("verbose"); err == nil {
		t.Fatal("unknown level must be rejected")
	}
}

func TestLogLevelsFilterAndRoute(t *testing.T) {
	var out, errOut bytes.Buffer
	prevOut, prevErr, prevLevel := stdoutLogger, stderrLogger, currentLogLevel.Load()
	stdoutLogger, stderrLogger = log.New(&out, "", 0), log.New(&errOut, "", 0)
	t.Cleanup(func() { stdoutLogger, stderrLogger = prevOut, prevErr; currentLogLevel.Store(prevLevel) })

	currentLogLevel.Store(logLevelInfo)
	logDebugf("routine %d", 1)
	logInfof("started")
	logWarnf("slow")
	logErrorf("broken")
	if got := out.String(); got != "INFO started\n" {
		t.Fatalf("stdout = %q; want only the INFO line", got)
	}
	if got := errOut.String(); got != "WARN slow\nERROR broken\n" {
		t.Fatalf("stderr = %q; want WARN and ERROR lines", got)
	}

	out.Reset()
	currentLogLevel.Store(logLevelDebug)
	logDebugf("routine %d", 2)
	if !strings.Contains(out.String(), "DEBUG routine 2") {
		t.Fatalf("debug level must emit debug lines on stdout, got %q", out.String())
	}

	out.Reset()
	errOut.Reset()
	currentLogLevel.Store(logLevelError)
	logInfof("hidden")
	logWarnf("hidden")
	logErrorf("shown")
	if out.Len() != 0 || errOut.String() != "ERROR shown\n" {
		t.Fatalf("error level leaked lines: stdout=%q stderr=%q", out.String(), errOut.String())
	}
}

func TestPolicyLogsOnlyWhenPingConfigurationChanges(t *testing.T) {
	var out bytes.Buffer
	previousLogger, previousLevel := stdoutLogger, currentLogLevel.Load()
	stdoutLogger = log.New(&out, "", 0)
	currentLogLevel.Store(logLevelInfo)
	t.Cleanup(func() { stdoutLogger = previousLogger; currentLogLevel.Store(previousLevel) })

	// No scheduler goroutine is needed to check policy application and logging.
	state := &pingReportState{intervalSec: defaultPingIntervalSec, scheduler: newPingTaskScheduler()}
	policy := agentPolicy{
		PingIntervalSec:   120,
		PingPolicyVersion: "v1",
		PingTasks:         []PingTask{{ID: 1, Type: "tcp", Target: "example.com:443"}},
	}
	check := func(name string, wantLog bool) {
		t.Helper()
		out.Reset()
		state.applyPolicy(policy)
		wantCount := 0
		if wantLog {
			wantCount = 1
		}
		if count := strings.Count(out.String(), "INFO policy updated:"); count != wantCount {
			t.Fatalf("%s: policy log = %q, want log=%t", name, out.String(), wantLog)
		}
	}

	check("initial tasks", true)
	check("identical refresh", false)
	policy.PingTasks[0].IntervalSec = 120
	policy.PingTasks[0].TimeoutMS = int(normalizePingTimeout(0).Milliseconds())
	check("equivalent normalized tasks", false)
	policy.PingPolicyVersion = "v2"
	check("version change", true)
	policy.PingIntervalSec = 180
	check("interval change", true)
	policy.PingTasks[0].Target = "example.com:80"
	check("task change", true)
	policy.PingTasks = nil
	check("clear tasks", true)
	if !strings.Contains(out.String(), "0 ping task(s)") {
		t.Fatalf("clearing tasks must be visible, got %q", out.String())
	}
	check("repeated empty policy", false)
}
