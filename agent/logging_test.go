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
