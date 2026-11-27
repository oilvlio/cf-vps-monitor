package main

import (
	"fmt"
	"log"
	"os"
	"strings"
	"sync/atomic"
)

// Log levels, from most to least verbose.
const (
	logLevelDebug int32 = iota
	logLevelInfo
	logLevelWarn
	logLevelError
)

var logLevelNames = [...]string{"DEBUG", "INFO", "WARN", "ERROR"}

// Routine per-report traffic (every "report sent" / "ack received") is DEBUG,
// so the default INFO level only records lifecycle events and problems.
var currentLogLevel atomic.Int32

var (
	// DEBUG and INFO go to stdout; WARN and ERROR go to stderr.
	stdoutLogger = log.New(os.Stdout, "", log.LstdFlags)
	stderrLogger = log.New(os.Stderr, "", log.LstdFlags)
)

func init() {
	currentLogLevel.Store(logLevelInfo)
}

// parseLogLevel accepts debug, info, warn/warning and error (case-insensitive).
func parseLogLevel(value string) (int32, error) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "debug":
		return logLevelDebug, nil
	case "", "info":
		return logLevelInfo, nil
	case "warn", "warning":
		return logLevelWarn, nil
	case "error":
		return logLevelError, nil
	}
	return logLevelInfo, fmt.Errorf("invalid log level %q, expected debug, info, warn or error", value)
}

func logAt(level int32, format string, args ...any) {
	if level < currentLogLevel.Load() {
		return
	}
	logger := stdoutLogger
	if level >= logLevelWarn {
		logger = stderrLogger
	}
	logger.Output(3, logLevelNames[level]+" "+fmt.Sprintf(format, args...))
}

func logDebugf(format string, args ...any) { logAt(logLevelDebug, format, args...) }
func logInfof(format string, args ...any)  { logAt(logLevelInfo, format, args...) }
func logWarnf(format string, args ...any)  { logAt(logLevelWarn, format, args...) }
func logErrorf(format string, args ...any) { logAt(logLevelError, format, args...) }

// logFatalf always logs (regardless of level) and exits with status 1.
func logFatalf(format string, args ...any) {
	stderrLogger.Output(2, logLevelNames[logLevelError]+" "+fmt.Sprintf(format, args...))
	os.Exit(1)
}
