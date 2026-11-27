package main

import (
	"errors"
	"fmt"
	"net"
	"os/exec"
	"strconv"
	"time"
)

// icmpPingCommand 把任务超时翻译成各平台 ping 的等待时间；
// 外层 context 仍然是最终硬期限，超时后按丢包处理。
func icmpPingCommand(platform string, ip net.IP, timeout time.Duration) (string, []string, error) {
	if ip == nil {
		return "", nil, fmt.Errorf("ICMP requires a resolved IP address")
	}
	if timeout <= 0 {
		timeout = time.Duration(defaultPingTimeoutMS) * time.Millisecond
	}
	target := ip.String()
	family := "-6"
	if ip.To4() != nil {
		family = "-4"
	}
	timeoutMS := strconv.FormatInt(int64((timeout+time.Millisecond-1)/time.Millisecond), 10)
	timeoutSec := strconv.FormatInt(int64((timeout+time.Second-1)/time.Second), 10)
	switch platform {
	case "windows":
		return "ping", []string{family, "-n", "1", "-w", timeoutMS, target}, nil
	case "linux":
		return "ping", []string{family, "-n", "-c", "1", "-W", timeoutSec, target}, nil
	case "darwin":
		if family == "-6" {
			// Apple ping6 -W sends a Node Information query. Its common flags
			// have no per-packet timeout; the caller's context bounds the child.
			return "ping6", []string{"-n", "-c", "1", target}, nil
		}
		return "ping", []string{"-n", "-c", "1", "-W", timeoutMS, target}, nil
	case "freebsd":
		if family == "-6" {
			if _, err := exec.LookPath("ping6"); err == nil {
				// FreeBSD 12 ping6 and the newer ping6 alias share these flags.
				// Their timeout options differ, so the outer context remains the budget.
				return "ping6", []string{"-n", "-c", "1", target}, nil
			} else if !errors.Is(err, exec.ErrNotFound) {
				return "", nil, fmt.Errorf("find IPv6 ping: %w", err)
			}
			// Merged ping supports -6 on FreeBSD 13+. A system lacking both
			// forms fails as unavailable instead of probing a different address.
			return "ping", []string{"-6", "-n", "-c", "1", "-W", timeoutMS, target}, nil
		}
		return "ping", []string{"-n", "-c", "1", "-W", timeoutMS, target}, nil
	default:
		return "", nil, fmt.Errorf("ICMP command is unsupported on %s", platform)
	}
}
