package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/load"
	gnet "github.com/shirou/gopsutil/v4/net"
)

func TestNormalizeServerURL(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{name: "adds https", raw: "example.com/", want: "https://example.com"},
		{name: "keeps path", raw: "https://example.com/panel/?x=1#frag", want: "https://example.com/panel"},
		{name: "keeps localhost http", raw: "http://127.0.0.1:8787/", want: "http://127.0.0.1:8787"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizeServerURL(tc.raw)
			if err != nil {
				t.Fatalf("normalizeServerURL() error = %v", err)
			}
			if got != tc.want {
				t.Fatalf("normalizeServerURL() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestNormalizeServerURLRejectsInvalidInput(t *testing.T) {
	for _, raw := range []string{"", "ftp://example.com", "https:///missing-host", "http://example.com"} {
		if got, err := normalizeServerURL(raw); err == nil {
			t.Fatalf("normalizeServerURL(%q) = %q, want error", raw, got)
		}
	}
}

func TestWebSocketEndpoint(t *testing.T) {
	tests := []struct {
		server string
		want   string
	}{
		{server: "https://example.com", want: "wss://example.com/api/clients/report"},
		{server: "http://127.0.0.1:8787/base", want: "ws://127.0.0.1:8787/base/api/clients/report"},
	}

	for _, tc := range tests {
		got, err := webSocketEndpoint(tc.server, "token")
		if err != nil {
			t.Fatalf("webSocketEndpoint() error = %v", err)
		}
		if got != tc.want {
			t.Fatalf("webSocketEndpoint() = %q, want %q", got, tc.want)
		}
	}
}

func testWebSocketURL(httpURL string) string {
	return "ws" + strings.TrimPrefix(httpURL, "http")
}

func TestConnectWebSocketSendsBearerToken(t *testing.T) {
	upgrader := websocket.Upgrader{}
	authHeader := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		authHeader <- r.Header.Get("Authorization")
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade websocket: %v", err)
			return
		}
		_ = conn.Close()
	}))
	defer server.Close()

	conn, err := connectWebSocket(testWebSocketURL(server.URL), "agent-token")
	if err != nil {
		t.Fatalf("connectWebSocket() error = %v", err)
	}
	conn.Close()

	select {
	case got := <-authHeader:
		if got != "Bearer agent-token" {
			t.Fatalf("Authorization = %q, want Bearer agent-token", got)
		}
	case <-time.After(time.Second):
		t.Fatal("server did not receive websocket handshake")
	}
}

func TestWebSocketReconnectDelaySlowsAuthFailures(t *testing.T) {
	oldReconnectInterval := reconnectInterval
	reconnectInterval = 5
	defer func() { reconnectInterval = oldReconnectInterval }()

	if got := webSocketReconnectDelay(errors.New("401 Unauthorized")); got != 10*time.Minute {
		t.Fatalf("auth failure reconnect delay = %s, want 10m", got)
	}
	if got := webSocketReconnectDelay(errors.New("dial tcp timeout")); got != 5*time.Second {
		t.Fatalf("network failure reconnect delay = %s, want 5s", got)
	}
}

func TestReadWebSocketMessagesQueuesPoliciesOnly(t *testing.T) {
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade websocket: %v", err)
			return
		}
		defer conn.Close()

		_ = conn.WriteMessage(websocket.TextMessage, []byte("{bad-json"))
		_ = conn.WriteJSON(serverMessage{Type: "ack", Timestamp: 123})
		_ = conn.WriteJSON(serverMessage{Type: "policy", SampleIntervalSec: 3, ReportIntervalSec: 7, ReportNow: true})
		_ = conn.WriteJSON(serverMessage{Type: "notice"})
	}))
	defer server.Close()

	rawConn, _, err := websocket.DefaultDialer.Dial(testWebSocketURL(server.URL), nil)
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	conn := &safeWebSocketConn{conn: rawConn}
	defer conn.Close()

	done := make(chan error, 1)
	policies := make(chan serverMessage, 2)
	go readWebSocketMessages(conn, done, policies)

	select {
	case policy := <-policies:
		if policy.Type != "policy" || policy.SampleIntervalSec != 3 || policy.ReportIntervalSec != 7 || !policy.ReportNow {
			t.Fatalf("policy = %#v, want forwarded policy message", policy)
		}
	case <-time.After(time.Second):
		t.Fatal("policy message was not queued")
	}

	select {
	case <-policies:
		t.Fatal("non-policy websocket message was queued")
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("websocket reader did not stop after server close")
	}
}

func TestPolicyDecodesNumericAllClients(t *testing.T) {
	raw := []byte(`{"type":"policy","sample_interval_sec":120,"report_interval_sec":120,"ping_tasks":[{"id":1,"name":"tcp","type":"tcp","target":"example.com:80","interval_sec":120,"clients":[],"all_clients":1}]}`)
	var policy serverMessage
	if err := json.Unmarshal(raw, &policy); err != nil {
		t.Fatalf("decode policy with numeric all_clients: %v", err)
	}
	if len(policy.PingTasks) != 1 {
		t.Fatalf("decoded %d ping tasks, want 1", len(policy.PingTasks))
	}
	if !bool(policy.PingTasks[0].AllClients) {
		t.Fatal("numeric all_clients was not decoded as true")
	}
}

func TestDefaultIntervalsStartInBackgroundMode(t *testing.T) {
	if reportInterval != 120 {
		t.Fatalf("default report interval = %d, want 120 seconds", reportInterval)
	}
	if pingInterval != defaultPingIntervalSec {
		t.Fatalf("default ping interval = %d, want %d seconds", pingInterval, defaultPingIntervalSec)
	}
}

func TestReadCgroupMemoryUsesContainerLimits(t *testing.T) {
	root := t.TempDir()
	cgroupDir := filepath.Join(root, "lxc", "101")
	if err := os.MkdirAll(cgroupDir, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name string, value string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(cgroupDir, name), []byte(value), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("memory.max", "1073741824\n")
	write("memory.current", "268435456\n")
	write("memory.swap.max", "536870912\n")
	write("memory.swap.current", "134217728\n")

	procCgroup := filepath.Join(root, "self-cgroup")
	if err := os.WriteFile(procCgroup, []byte("0::/lxc/101\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	got := readCgroupMemory(root, procCgroup)
	if !got.hasRAM || got.ramTotal != 1073741824 || got.ramUsed != 268435456 {
		t.Fatalf("cgroup ram = %#v, want 1GiB total and 256MiB used", got)
	}
	if !got.hasSwap || got.swapTotal != 536870912 || got.swapUsed != 134217728 {
		t.Fatalf("cgroup swap = %#v, want 512MiB total and 128MiB used", got)
	}
}

func TestReadCgroupMemoryV1DerivesSwapFromMemsw(t *testing.T) {
	root := t.TempDir()
	cgroupDir := filepath.Join(root, "memory", "lxc", "101")
	if err := os.MkdirAll(cgroupDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string]string{
		"memory.limit_in_bytes":       "1073741824\n",
		"memory.usage_in_bytes":       "268435456\n",
		"memory.memsw.limit_in_bytes": "1610612736\n",
		"memory.memsw.usage_in_bytes": "402653184\n",
	} {
		if err := os.WriteFile(filepath.Join(cgroupDir, name), []byte(value), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	procCgroup := filepath.Join(root, "self-cgroup")
	if err := os.WriteFile(procCgroup, []byte("10:memory:/lxc/101\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	got := readCgroupMemory(root, procCgroup)
	if !got.hasSwap || got.swapTotal != 536870912 || got.swapUsed != 134217728 {
		t.Fatalf("cgroup v1 swap = %#v, want memsw minus memory", got)
	}
}

func TestParseProcMeminfoUsesKomariHtopLikeMemory(t *testing.T) {
	got := parseProcMeminfo(`MemTotal:       1000 kB
MemFree:         100 kB
Buffers:          50 kB
Cached:          200 kB
SwapCached:       25 kB
SwapTotal:       500 kB
SwapFree:        100 kB
Shmem:            10 kB
SReclaimable:     40 kB
`)

	if !got.hasRAM || got.ramTotal != 1000*1024 || got.ramUsed != 620*1024 {
		t.Fatalf("proc meminfo ram = %#v, want htop-like used memory", got)
	}
	if !got.hasSwap || got.swapTotal != 500*1024 || got.swapUsed != 375*1024 {
		t.Fatalf("proc meminfo swap = %#v, want total-free-cached", got)
	}
}

func TestMergeMemorySnapshotZerosContainerSwapWhenCgroupSwapMissing(t *testing.T) {
	procMem := parseProcMeminfo(`MemTotal:       65563288 kB
MemFree:        10000000 kB
Buffers:          100000 kB
Cached:          1000000 kB
SwapCached:            0 kB
SwapTotal:      65660924 kB
SwapFree:       60813916 kB
SReclaimable:     100000 kB
`)
	cgroup := memorySnapshot{
		ramUsed:  42 * 1024 * 1024,
		ramTotal: 512000000,
		hasRAM:   true,
	}

	got := mergeMemorySnapshot(procMem, cgroup, true)

	if !got.hasRAM || got.ramTotal != 512000000 || got.ramUsed != 42*1024*1024 {
		t.Fatalf("merged ram = %#v, want cgroup ram", got)
	}
	if !got.hasSwap || got.swapTotal != 0 || got.swapUsed != 0 {
		t.Fatalf("merged swap = %#v, want container swap cleared instead of host swap", got)
	}
}

func TestMergeMemorySnapshotZerosContainerSwapWhenCgroupMirrorsHostSwap(t *testing.T) {
	procMem := parseProcMeminfo(`MemTotal:       65563288 kB
MemFree:        10000000 kB
Buffers:          100000 kB
Cached:          1000000 kB
SwapCached:            0 kB
SwapTotal:      65660924 kB
SwapFree:       60813916 kB
SReclaimable:     100000 kB
`)
	cgroup := memorySnapshot{
		ramUsed:   42 * 1024 * 1024,
		ramTotal:  512000000,
		swapUsed:  procMem.swapUsed,
		swapTotal: procMem.swapTotal,
		hasRAM:    true,
		hasSwap:   true,
	}

	got := mergeMemorySnapshot(procMem, cgroup, true)

	if !got.hasSwap || got.swapTotal != 0 || got.swapUsed != 0 {
		t.Fatalf("merged swap = %#v, want host-sized cgroup swap cleared for LXC", got)
	}
}

func TestFormatMemoryBytesKeepsSubGiBReadable(t *testing.T) {
	if got := formatMemoryBytes(512000000); got != "488MiB" {
		t.Fatalf("formatMemoryBytes(512000000) = %q, want 488MiB", got)
	}
	if got := formatMemoryBytes(2 * 1024 * 1024 * 1024); got != "2.0GiB" {
		t.Fatalf("formatMemoryBytes(2GiB) = %q, want 2.0GiB", got)
	}
}

func TestKomariDiskPartitionsKeepRootAndDropVirtualMounts(t *testing.T) {
	parts := []disk.PartitionStat{
		{Device: "/dev/loop0", Mountpoint: "/", Fstype: "ext4"},
		{Device: "tmpfs", Mountpoint: "/run", Fstype: "tmpfs"},
		{Device: "overlay", Mountpoint: "/var/lib/docker/overlay2", Fstype: "overlay"},
		{Device: "/dev/sda1", Mountpoint: "/data", Fstype: "ext4"},
	}

	got := selectDiskPartitions(parts, "", "")
	if len(got) != 2 || got[0].Mountpoint != "/" || got[1].Mountpoint != "/data" {
		t.Fatalf("selected partitions = %#v, want root and physical data only", got)
	}
}

func TestProcNetConnectionsCountCountsIPv4AndIPv6Rows(t *testing.T) {
	root := t.TempDir()
	netDir := filepath.Join(root, "net")
	if err := os.MkdirAll(netDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{
		"tcp":  "header\nrow1\nrow2\n",
		"tcp6": "header\nrow3\n",
		"udp":  "header\nrow1\n",
		"udp6": "header\n",
	} {
		if err := os.WriteFile(filepath.Join(netDir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	tcp, udp, err := procNetConnectionsCount(root)
	if err != nil {
		t.Fatal(err)
	}
	if tcp != 3 || udp != 1 {
		t.Fatalf("proc net counts = tcp %d udp %d, want 3/1", tcp, udp)
	}
}

func TestLinuxOSNameReadsPrettyName(t *testing.T) {
	path := filepath.Join(t.TempDir(), "os-release")
	if err := os.WriteFile(path, []byte("NAME=Debian\nPRETTY_NAME=\"Debian GNU/Linux 12 (bookworm)\"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if got := linuxOSName(path); got != "Debian GNU/Linux 12 (bookworm)" {
		t.Fatalf("linuxOSName() = %q, want Debian pretty name", got)
	}
}

func TestDetectContainerFromCgroupFindsLXC(t *testing.T) {
	if got := detectContainerFromCgroup("0::/lxc/101\n"); got != "lxc" {
		t.Fatalf("detectContainerFromCgroup() = %q, want lxc", got)
	}
}

func TestPolicyDurationsKeepRealtimeAndBackgroundUploadsDistinct(t *testing.T) {
	realtimeSample, realtimeUpload := policyDurations(agentPolicy{
		Mode:              "active",
		SampleIntervalSec: 3,
		ReportIntervalSec: 3,
	}, 120*time.Second)
	if realtimeSample != 3*time.Second || realtimeUpload != 3*time.Second {
		t.Fatalf("realtime policy = sample %s upload %s, want 3s/3s", realtimeSample, realtimeUpload)
	}

	backgroundSample, backgroundUpload := policyDurations(agentPolicy{
		Mode:              "idle",
		SampleIntervalSec: 120,
		ReportIntervalSec: 120,
	}, 3*time.Second)
	if backgroundSample != 120*time.Second || backgroundUpload != 120*time.Second {
		t.Fatalf("background policy = sample %s upload %s, want 120s/120s", backgroundSample, backgroundUpload)
	}
}

func selectionForTest(counters []gnet.IOCountersStat, include, exclude string, defaultRoute []string) map[string]bool {
	names := make([]string, 0, len(counters))
	for _, counter := range counters {
		names = append(names, counter.Name)
	}
	return selectTrafficInterfaces(names, include, exclude, defaultRoute)
}

func TestSumNetworkCountersExcludesCommonVirtualInterfacesByDefault(t *testing.T) {
	counters := []gnet.IOCountersStat{
		{Name: "eth0", BytesSent: 100, BytesRecv: 200},
		{Name: "lo", BytesSent: 1000, BytesRecv: 2000},
		{Name: "Loopback Pseudo-Interface 1", BytesSent: 1000, BytesRecv: 2000},
		{Name: "docker0", BytesSent: 3000, BytesRecv: 4000},
		{Name: "vethabc", BytesSent: 5000, BytesRecv: 6000},
	}

	up, down := sumNetworkCounters(counters, selectionForTest(counters, "", "", nil))
	if up != 100 || down != 200 {
		t.Fatalf("network totals = %d/%d, want physical interface totals 100/200", up, down)
	}
}

// 隧道网卡与物理网卡承载同一份流量，同时统计会把同一份流量数两遍。
// demo 上日均 10~184 GiB 的离谱数值即由此而来。
func TestSumNetworkCountersExcludesTunnelInterfaces(t *testing.T) {
	counters := []gnet.IOCountersStat{
		{Name: "eth0", BytesSent: 1000, BytesRecv: 2000},
		{Name: "wg0", BytesSent: 900, BytesRecv: 1900},
		{Name: "tun0", BytesSent: 800, BytesRecv: 1800},
		{Name: "tailscale0", BytesSent: 700, BytesRecv: 1700},
		{Name: "warp0", BytesSent: 600, BytesRecv: 1600},
		{Name: "zt0abcdef", BytesSent: 500, BytesRecv: 1500},
	}

	up, down := sumNetworkCounters(counters, selectionForTest(counters, "", "", nil))
	if up != 1000 || down != 2000 {
		t.Fatalf("network totals = %d/%d, want physical-only 1000/2000 (tunnels double-count)", up, down)
	}
}

// 默认路由所在网卡才是商家计量的口；内网网卡上的内部流量不该计入。
func TestSelectTrafficInterfacesPrefersDefaultRouteInterface(t *testing.T) {
	counters := []gnet.IOCountersStat{
		{Name: "eth0", BytesSent: 1000, BytesRecv: 2000},
		{Name: "eth1", BytesSent: 5000, BytesRecv: 6000},
	}

	selected := selectionForTest(counters, "", "", []string{"eth0"})
	if !selected["eth0"] || selected["eth1"] || len(selected) != 1 {
		t.Fatalf("selected = %v, want only eth0", selected)
	}

	up, down := sumNetworkCounters(counters, selected)
	if up != 1000 || down != 2000 {
		t.Fatalf("network totals = %d/%d, want default-route interface totals 1000/2000", up, down)
	}
}

// 全流量走 VPN 的机器：默认路由落在被剔除的隧道上，此时不能得到空集，
// 必须退回物理网卡——流量终究要从物理口出去，那里仍是单份计量。
func TestSelectTrafficInterfacesFallsBackWhenDefaultRouteIsTunnel(t *testing.T) {
	counters := []gnet.IOCountersStat{
		{Name: "eth0", BytesSent: 1000, BytesRecv: 2000},
		{Name: "wg0", BytesSent: 900, BytesRecv: 1900},
	}

	selected := selectionForTest(counters, "", "", []string{"wg0"})
	if !selected["eth0"] || selected["wg0"] || len(selected) != 1 {
		t.Fatalf("selected = %v, want fallback to eth0 only", selected)
	}
}

// 手动 --nic-include 必须完全压过默认路由与内置排除表，
// 多公网口分走不同线路的机器要靠它。
func TestSelectTrafficInterfacesHonorsManualInclude(t *testing.T) {
	counters := []gnet.IOCountersStat{
		{Name: "eth0", BytesSent: 1000, BytesRecv: 2000},
		{Name: "eth1", BytesSent: 5000, BytesRecv: 6000},
		{Name: "wg0", BytesSent: 900, BytesRecv: 1900},
	}

	selected := selectionForTest(counters, "eth*", "", []string{"eth0"})
	if !selected["eth0"] || !selected["eth1"] || selected["wg0"] || len(selected) != 2 {
		t.Fatalf("selected = %v, want eth0+eth1", selected)
	}

	if tunnel := selectionForTest(counters, "wg*", "", []string{"eth0"}); !tunnel["wg0"] || len(tunnel) != 1 {
		t.Fatalf("selected = %v, want explicit include to override the built-in tunnel exclusion", tunnel)
	}
}

func TestSelectTrafficInterfacesAppliesExcludeLast(t *testing.T) {
	counters := []gnet.IOCountersStat{
		{Name: "eth0", BytesSent: 1000, BytesRecv: 2000},
		{Name: "eth1", BytesSent: 5000, BytesRecv: 6000},
	}

	if selected := selectionForTest(counters, "", "eth0", []string{"eth0"}); len(selected) != 0 {
		t.Fatalf("selected = %v, want empty after excluding the default-route interface", selected)
	}
	if selected := selectionForTest(counters, "eth*", "eth1", nil); !selected["eth0"] || selected["eth1"] {
		t.Fatalf("selected = %v, want include minus exclude", selected)
	}
}

// 回归锁：累计流量与实时速率必须基于同一个网卡集合。
// 两条路径若各自过滤，同一台机器上会出现「速率正常、总量翻倍」的自相矛盾。
func TestTrafficAndRateShareTheSameInterfaceSet(t *testing.T) {
	counters := []gnet.IOCountersStat{
		{Name: "eth0", BytesSent: 1000, BytesRecv: 2000},
		{Name: "eth1", BytesSent: 5000, BytesRecv: 6000},
		{Name: "wg0", BytesSent: 900, BytesRecv: 1900},
		{Name: "docker0", BytesSent: 300, BytesRecv: 400},
	}

	selected := selectionForTest(counters, "", "", []string{"eth0"})
	up, down := sumNetworkCounters(counters, selected)
	perInterface := collectPerInterfaceCounters(counters, selected)

	if len(perInterface) != len(selected) {
		t.Fatalf("per-interface set = %v, selected = %v", perInterface, selected)
	}
	var perUp, perDown int64
	for name, counter := range perInterface {
		if !selected[name] {
			t.Fatalf("per-interface set contains %s outside the selection", name)
		}
		perUp += int64(counter.sent)
		perDown += int64(counter.recv)
	}
	if perUp != up || perDown != down {
		t.Fatalf("rate basis %d/%d != traffic basis %d/%d", perUp, perDown, up, down)
	}
}

func TestParseIPv4DefaultRouteInterfaces(t *testing.T) {
	data := "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n" +
		"eth0\t00000000\t0102030A\t0003\t0\t0\t0\t00000000\t0\t0\t0\n" +
		"eth0\t0002030A\t00000000\t0001\t0\t0\t0\t00FFFFFF\t0\t0\t0\n" +
		"wg0\t00000000\t00000000\t0001\t0\t0\t50\t00000000\t0\t0\t0\n"

	names := parseIPv4DefaultRouteInterfaces(data)
	if len(names) != 2 || names[0] != "eth0" || names[1] != "wg0" {
		t.Fatalf("default route interfaces = %v, want [eth0 wg0]", names)
	}
}

func TestParseIPv6DefaultRouteInterfaces(t *testing.T) {
	data := "00000000000000000000000000000000 00 00000000000000000000000000000000 00 " +
		"fe800000000000000000000000000001 00000400 00000000 00000000 00000003 eth0\n" +
		"20010db8000000000000000000000000 40 00000000000000000000000000000000 00 " +
		"00000000000000000000000000000000 00000100 00000000 00000000 00000001 eth0\n" +
		"00000000000000000000000000000000 00 00000000000000000000000000000000 00 " +
		"00000000000000000000000000000000 ffffffff 00000001 00000000 00200200 lo\n"

	names := parseIPv6DefaultRouteInterfaces(data)
	if len(names) != 1 || names[0] != "eth0" {
		t.Fatalf("default route interfaces = %v, want [eth0] (lo must be dropped)", names)
	}
}

func TestProcDefaultRouteInterfacesReadsBothFamilies(t *testing.T) {
	root := t.TempDir()
	netDir := filepath.Join(root, "net")
	if err := os.MkdirAll(netDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	ipv4 := "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT\n" +
		"eth0\t00000000\t0102030A\t0003\t0\t0\t0\t00000000\t0\t0\t0\n"
	ipv6 := "00000000000000000000000000000000 00 00000000000000000000000000000000 00 " +
		"fe800000000000000000000000000001 00000400 00000000 00000000 00000003 ens3\n"
	if err := os.WriteFile(filepath.Join(netDir, "route"), []byte(ipv4), 0o644); err != nil {
		t.Fatalf("write route: %v", err)
	}
	if err := os.WriteFile(filepath.Join(netDir, "ipv6_route"), []byte(ipv6), 0o644); err != nil {
		t.Fatalf("write ipv6_route: %v", err)
	}

	names := procDefaultRouteInterfaces(root)
	if len(names) != 2 || names[0] != "eth0" || names[1] != "ens3" {
		t.Fatalf("default route interfaces = %v, want [eth0 ens3]", names)
	}
}

func TestProcDefaultRouteInterfacesMissingFilesIsEmpty(t *testing.T) {
	if names := procDefaultRouteInterfaces(t.TempDir()); len(names) != 0 {
		t.Fatalf("default route interfaces = %v, want empty", names)
	}
}

// ===== 负载可信度判定 =====
//
// test2-LXC 实测：1 核 LXC 容器上报负载 9.29，而 /proc/loadavg 的任务总数是 9500，
// 容器里只有 17 个进程——那个负载是宿主机的。lxcfs 挂了但没开 lxcfs.loadavg=1。

func TestLoadAverageTrustworthy(t *testing.T) {
	cases := []struct {
		name           string
		taskTotal      int
		visibleThreads int
		inContainer    bool
		want           bool
	}{
		{"物理机一律信任", 9500, 60, false, true},
		{"LXC 透传宿主机（实测数量级）", 9482, 60, true, false},
		{"容器内 lxcfs 已虚拟化", 55, 40, true, true},
		{"容器内多线程应用不算穿透", 500, 500, true, true},
		{"差额小于绝对门限不判穿透", 125, 30, true, true},
		{"读不到任务总数时按可信处理", 0, 60, true, true},
		{"数不到线程时按可信处理", 9482, 0, true, true},
	}
	for _, tc := range cases {
		if got := loadAverageTrustworthy(tc.taskTotal, tc.visibleThreads, tc.inContainer); got != tc.want {
			t.Fatalf("%s: loadAverageTrustworthy(%d, %d, %v) = %v, want %v",
				tc.name, tc.taskTotal, tc.visibleThreads, tc.inContainer, got, tc.want)
		}
	}
}

func TestParseLoadAverageTaskTotal(t *testing.T) {
	cases := map[string]int{
		"9.71 10.09 10.90 3/9482 3197878": 9482,
		"0.00 0.01 0.05 1/122 4242":       122,
		"0.00 0.01 0.05":                  0,
		"0.00 0.01 0.05 broken 4242":      0,
		"":                                0,
	}
	for input, want := range cases {
		if got := parseLoadAverageTaskTotal(input); got != want {
			t.Fatalf("parseLoadAverageTaskTotal(%q) = %d, want %d", input, got, want)
		}
	}
}

func TestContainerRuntimeName(t *testing.T) {
	t.Run("systemd container 标记", func(t *testing.T) {
		root := t.TempDir()
		writeFileTree(t, root, map[string]string{"run/systemd/container": "lxc\n"})
		if got := containerRuntimeName(root); got != "lxc" {
			t.Fatalf("containerRuntimeName = %q, want lxc", got)
		}
	})
	t.Run("docker 标记文件", func(t *testing.T) {
		root := t.TempDir()
		writeFileTree(t, root, map[string]string{".dockerenv": ""})
		if got := containerRuntimeName(root); got != "docker" {
			t.Fatalf("containerRuntimeName = %q, want docker", got)
		}
	})
	t.Run("lxcfs 挂载", func(t *testing.T) {
		root := t.TempDir()
		writeFileTree(t, root, map[string]string{
			"proc/mounts": "lxcfs /proc/loadavg fuse.lxcfs rw,nosuid,nodev,relatime 0 0\n",
		})
		if got := containerRuntimeName(root); got != "lxc" {
			t.Fatalf("containerRuntimeName = %q, want lxc", got)
		}
	})
	t.Run("物理机没有任何标记", func(t *testing.T) {
		root := t.TempDir()
		writeFileTree(t, root, map[string]string{
			"proc/mounts":   "/dev/vda1 / ext4 rw,relatime 0 0\n",
			"proc/1/cgroup": "0::/init.scope\n",
		})
		if got := containerRuntimeName(root); got != "" {
			t.Fatalf("containerRuntimeName = %q, want empty", got)
		}
	})
}

func TestCountVisibleThreads(t *testing.T) {
	root := t.TempDir()
	writeFileTree(t, root, map[string]string{
		"1/task/1/status":    "",
		"1/task/17/status":   "",
		"42/task/42/status":  "",
		"self/task/1/status": "",
		"uptime":             "1 2",
	})
	if got := countVisibleThreads(root); got != 3 {
		t.Fatalf("countVisibleThreads = %d, want 3 (非数字目录不计入)", got)
	}
}

// 端到端复刻 test2-LXC 的现场：lxcfs 挂载 + loadavg 报 9482 个任务，
// 而命名空间里只看得到寥寥几个线程。
func TestEvaluateLoadAverageTrustOnHostPassthroughContainer(t *testing.T) {
	root := t.TempDir()
	writeFileTree(t, root, map[string]string{
		"run/systemd/container":  "lxc\n",
		"proc/mounts":            "lxcfs /proc/loadavg fuse.lxcfs rw 0 0\n",
		"proc/loadavg":           "9.71 10.09 10.90 3/9482 3197878\n",
		"proc/1/task/1/status":   "",
		"proc/17/task/17/status": "",
	})

	trusted, detail := evaluateLoadAverageTrust(root)
	if trusted {
		t.Fatalf("expected host passthrough to be distrusted, detail=%q", detail)
	}
	if !strings.Contains(detail, "9482") {
		t.Fatalf("detail = %q, want it to carry the observed task total", detail)
	}
}

func TestEvaluateLoadAverageTrustOnBareMetal(t *testing.T) {
	root := t.TempDir()
	writeFileTree(t, root, map[string]string{
		"proc/mounts":  "/dev/vda1 / ext4 rw,relatime 0 0\n",
		"proc/loadavg": "9.71 10.09 10.90 3/9482 3197878\n",
	})

	trusted, _ := evaluateLoadAverageTrust(root)
	if !trusted {
		t.Fatal("bare metal must always trust /proc/loadavg (物理机零回归)")
	}
}

// 线路契约：不可信时序列化成 null，而不是 0。0 会被读成「空闲」，比错值更误导。
func TestReportSerializesUnavailableLoadAsNull(t *testing.T) {
	unavailable, err := json.Marshal(Report{})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(unavailable), `"load":null`) {
		t.Fatalf("payload = %s, want \"load\":null", unavailable)
	}

	value := 1.25
	available, err := json.Marshal(Report{Load: &value})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(available), `"load":1.25`) {
		t.Fatalf("payload = %s, want \"load\":1.25", available)
	}
}

// 负载三元组与 Load1 同门控：可信时三个值一起上报，不可信时全 nil（序列化成 null）。
func TestApplyLoadAverageTriple(t *testing.T) {
	stat := load.AvgStat{Load1: 1.25, Load5: 0.75, Load15: 0.5}

	trusted := Report{}
	applyLoadAverage(&trusted, stat, true)
	if trusted.Load == nil || trusted.Load5 == nil || trusted.Load15 == nil {
		t.Fatalf("trusted report = %+v, want all three loads set", trusted)
	}
	if *trusted.Load != 1.25 || *trusted.Load5 != 0.75 || *trusted.Load15 != 0.5 {
		t.Fatalf("trusted loads = %v/%v/%v, want 1.25/0.75/0.5",
			*trusted.Load, *trusted.Load5, *trusted.Load15)
	}

	distrusted := Report{}
	applyLoadAverage(&distrusted, stat, false)
	if distrusted.Load != nil || distrusted.Load5 != nil || distrusted.Load15 != nil {
		t.Fatalf("distrusted report = %+v, want all three loads nil", distrusted)
	}
	payload, err := json.Marshal(distrusted)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	for _, key := range []string{`"load":null`, `"load5":null`, `"load15":null`} {
		if !strings.Contains(string(payload), key) {
			t.Fatalf("payload = %s, want %s", payload, key)
		}
	}
}

func writeFileTree(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for name, content := range files {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", path, err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
	}
}

// 回归锁（扫源码）：采集点必须把同一个网卡集合同时喂给累计流量和实时速率。

// 纯逻辑测试挡不住这个回归——两个函数各自都对，只要调用点分别过滤一次，
// 就会重新出现「速率按一套网卡算、总量按另一套算」的自相矛盾，而所有单元测试仍全绿。
// 上一批修网速尖刺时只改了速率那条路径，总量仍走标量汇总，正是这个坑。
func TestTrafficAndRateCallSitesUseOneSelection(t *testing.T) {
	source, err := os.ReadFile("main.go")
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}

	secondArg := func(fn string) string {
		pattern := regexp.MustCompile(`\b` + fn + `\(`)
		for _, line := range strings.Split(string(source), "\n") {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "func ") {
				continue
			}
			loc := pattern.FindStringIndex(trimmed)
			if loc == nil {
				continue
			}
			// 手工扫到配对的右括号并按顶层逗号切分，避免嵌套调用把参数切错。
			depth := 0
			args := []string{""}
			for _, char := range trimmed[loc[1]-1:] {
				switch char {
				case '(':
					depth++
					if depth == 1 {
						continue
					}
				case ')':
					depth--
					if depth == 0 {
						goto done
					}
				case ',':
					if depth == 1 {
						args = append(args, "")
						continue
					}
				}
				args[len(args)-1] += string(char)
			}
		done:
			if len(args) < 2 {
				t.Fatalf("%s called with %d args at %q", fn, len(args), trimmed)
			}
			return strings.TrimSpace(args[1])
		}
		t.Fatalf("no call site found for %s", fn)
		return ""
	}

	trafficArg := secondArg("sumNetworkCounters")
	rateArg := secondArg("collectPerInterfaceCounters")
	if trafficArg != rateArg {
		t.Fatalf("traffic uses %q while rate uses %q; both must consume one selection", trafficArg, rateArg)
	}
	if trafficArg == "nicInclude" || trafficArg == "nicExclude" {
		t.Fatalf("call sites re-filter from %q instead of a shared selection", trafficArg)
	}
}

func TestPostJSONWithContextSendsBearerJSON(t *testing.T) {
	var received map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s, want POST", r.Method)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Fatalf("Content-Type = %q, want application/json", got)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer agent-token" {
			t.Fatalf("Authorization = %q, want Bearer token", got)
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()

	err := postJSONWithContext(context.Background(), server.URL, map[string]string{"status": "ok"}, "agent-token")
	if err != nil {
		t.Fatalf("postJSONWithContext() error = %v", err)
	}
	if received["status"] != "ok" {
		t.Fatalf("request body status = %q, want ok", received["status"])
	}
}

func TestPreparedReportDoesNotSerializeToken(t *testing.T) {
	oldToken := token
	token = "agent-secret"
	defer func() { token = oldToken }()

	report := (&reportPreparer{}).prepareReportForInterval(Report{Timestamp: 1000}, 3)
	report.hasRawNetTotals = true
	report.rawNetTotalUp = 123
	report.rawNetTotalDown = 456
	body, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("marshal report: %v", err)
	}
	bodyText := string(body)
	if strings.Contains(bodyText, "agent-secret") || strings.Contains(bodyText, `"token"`) ||
		strings.Contains(bodyText, "rawNet") || strings.Contains(bodyText, "hasRaw") {
		t.Fatalf("prepared report leaked internal fields in body: %s", body)
	}
}

func TestPreparedReportUsesRawCountersForNetworkSpeed(t *testing.T) {
	preparer := &reportPreparer{}
	preparer.prepareReportForInterval(Report{
		Timestamp:    1000,
		NetTotalUp:   5000,
		NetTotalDown: 8000,
	}, 10)

	report := preparer.prepareReportForInterval(Report{
		Timestamp:    11_000,
		NetTotalUp:   200,
		NetTotalDown: 300,
	}, 10)
	if report.NetOut != 0 || report.NetIn != 0 {
		t.Fatalf("speed without raw counters = %d/%d, want 0/0 after monthly total reset", report.NetOut, report.NetIn)
	}

	preparer = &reportPreparer{}
	preparer.prepareReportForInterval(Report{
		Timestamp:       1000,
		NetTotalUp:      5000,
		NetTotalDown:    8000,
		hasRawNetTotals: true,
		rawNetTotalUp:   50_000,
		rawNetTotalDown: 80_000,
	}, 10)

	report = preparer.prepareReportForInterval(Report{
		Timestamp:       11_000,
		NetTotalUp:      200,
		NetTotalDown:    300,
		hasRawNetTotals: true,
		rawNetTotalUp:   50_400,
		rawNetTotalDown: 80_900,
	}, 10)
	if report.NetOut != 40 || report.NetIn != 90 {
		t.Fatalf("speed from raw counters = %d/%d, want 40/90", report.NetOut, report.NetIn)
	}
}

func TestPostJSONWithContextReturnsHTTPError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "too large", http.StatusRequestEntityTooLarge)
	}))
	defer server.Close()

	err := postJSONWithContext(context.Background(), server.URL, map[string]string{"status": "ok"}, "agent-token")
	if err == nil || !strings.Contains(err.Error(), "HTTP 413") {
		t.Fatalf("postJSONWithContext() error = %v, want HTTP 413", err)
	}
}

func TestPostJSONWithContextTruncatesLargeHTTPErrorBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusRequestEntityTooLarge)
		_, _ = w.Write([]byte(strings.Repeat("x", maxHTTPErrorBodyBytes+2048)))
	}))
	defer server.Close()

	err := postJSONWithContext(context.Background(), server.URL, map[string]string{"status": "ok"}, "agent-token")
	if err == nil {
		t.Fatal("postJSONWithContext() error = nil, want HTTP error")
	}
	if got := err.Error(); !strings.Contains(got, "HTTP 413") || !strings.Contains(got, "truncated") {
		t.Fatalf("postJSONWithContext() error = %q, want truncated HTTP 413", got)
	}
	if len(err.Error()) > maxHTTPErrorBodyBytes+128 {
		t.Fatalf("postJSONWithContext() error length = %d, want bounded detail", len(err.Error()))
	}
}

func TestPingTargetIPBoundary(t *testing.T) {
	blocked := []string{
		"0.0.0.0",
		"10.0.0.1",
		"100.64.0.1",
		"127.0.0.1",
		"169.254.1.1",
		"172.16.0.1",
		"192.0.2.1",
		"192.168.1.1",
		"198.18.0.1",
		"198.51.100.1",
		"203.0.113.1",
		"224.0.0.1",
		"240.0.0.1",
		"255.255.255.255",
		"::1",
		"100::1",
		"2001:db8::1",
		"fc00::1",
		"fe80::1",
		"ff02::1",
	}
	for _, raw := range blocked {
		if !isBlockedTargetIP(net.ParseIP(raw)) {
			t.Fatalf("isBlockedTargetIP(%q) = false, want true", raw)
		}
	}
	for _, raw := range []string{"1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"} {
		if isBlockedTargetIP(net.ParseIP(raw)) {
			t.Fatalf("isBlockedTargetIP(%q) = true, want false", raw)
		}
	}
}

func TestResolvePublicIPsBlocksLocalTargets(t *testing.T) {
	for _, host := range []string{"localhost", "api.localhost", "metadata.google.internal", "127.0.0.1", "10.0.0.1", "[::1]"} {
		if ips, err := resolvePublicIPs(context.Background(), host); err == nil {
			t.Fatalf("resolvePublicIPs(%q) = %v, want error", host, ips)
		}
	}
}

func TestExecuteICMPPingUsesResolvedPublicIP(t *testing.T) {
	dir := t.TempDir()
	argsFile := filepath.Join(dir, "ping-args.txt")
	var script string
	if runtime.GOOS == "windows" {
		script = filepath.Join(dir, "ping.bat")
		if err := os.WriteFile(script, []byte("@echo off\r\necho %* > \"%PING_ARGS_FILE%\"\r\nexit /b 0\r\n"), 0o755); err != nil {
			t.Fatalf("write fake ping: %v", err)
		}
	} else {
		script = filepath.Join(dir, "ping")
		if err := os.WriteFile(script, []byte("#!/bin/sh\nprintf '%s\\n' \"$*\" > \"$PING_ARGS_FILE\"\nexit 0\n"), 0o755); err != nil {
			t.Fatalf("write fake ping: %v", err)
		}
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(script, 0o755); err != nil {
			t.Fatalf("chmod fake ping: %v", err)
		}
	}
	t.Setenv("PING_ARGS_FILE", argsFile)
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))

	if elapsed := executeICMPPing("[2606:4700:4700::1111]"); elapsed < 0 {
		t.Fatalf("executeICMPPing() = %v, want successful fake ping", elapsed)
	}
	raw, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatalf("read fake ping args: %v", err)
	}
	args := strings.Fields(strings.TrimSpace(string(raw)))
	if len(args) == 0 {
		t.Fatalf("fake ping args = %q, want command arguments", raw)
	}
	if got, want := args[len(args)-1], "2606:4700:4700::1111"; got != want {
		t.Fatalf("ping target = %q, want resolved IP %q", got, want)
	}
}

func TestUniversalInstallerAllowsIcmpPingCapability(t *testing.T) {
	raw, err := os.ReadFile("install.sh")
	if err != nil {
		t.Fatalf("read install.sh: %v", err)
	}
	unit := string(raw)
	for _, want := range []string{
		"AmbientCapabilities=CAP_NET_RAW",
		"CapabilityBoundingSet=CAP_NET_RAW",
		"NoNewPrivileges=true",
	} {
		if !strings.Contains(unit, want) {
			t.Fatalf("install.sh missing %s", want)
		}
	}
}

func TestUniversalInstallerSupportsOpenRCAndUserMode(t *testing.T) {
	raw, err := os.ReadFile("install.sh")
	if err != nil {
		t.Fatalf("read install.sh: %v", err)
	}
	script := string(raw)
	for _, want := range []string{
		"#!/bin/sh",
		"rc-update add",
		"rc-service",
		"nohup",
		"crontab",
		"cf-vps-monitor:",
		"freebsd",
		"install_mode",
	} {
		if !strings.Contains(script, want) {
			t.Fatalf("install.sh missing %s", want)
		}
	}
}

func TestAgentReleasePublishesUniversalInstallerAndFreeBSD(t *testing.T) {
	raw, err := os.ReadFile("../.github/workflows/release-agent.yml")
	if err != nil {
		t.Fatalf("read release-agent.yml: %v", err)
	}
	workflow := string(raw)
	for _, want := range []string{
		"build freebsd amd64 cf-vps-monitor-agent-freebsd-amd64",
		"cp install.sh dist/install.sh",
		"SHA256SUMS",
	} {
		if !strings.Contains(workflow, want) {
			t.Fatalf("release-agent.yml missing %s", want)
		}
	}
}

func TestExecuteTCPPingExcludesDNSResolutionTime(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen tcp: %v", err)
	}
	defer ln.Close()

	accepted := make(chan struct{})
	go func() {
		conn, err := ln.Accept()
		if err == nil {
			_ = conn.Close()
		}
		close(accepted)
	}()

	_, port, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatalf("split listener address: %v", err)
	}

	oldResolve := resolvePublicIPsForPing
	resolveDelay := 400 * time.Millisecond
	resolvePublicIPsForPing = func(context.Context, string) ([]net.IP, error) {
		time.Sleep(resolveDelay)
		return []net.IP{net.ParseIP("127.0.0.1")}, nil
	}
	t.Cleanup(func() { resolvePublicIPsForPing = oldResolve })

	elapsed := executeTCPPing(net.JoinHostPort("example.test", port))
	if elapsed < 0 {
		t.Fatalf("executeTCPPing() = %v, want successful TCP ping", elapsed)
	}
	select {
	case <-accepted:
	case <-time.After(time.Second):
		t.Fatal("tcp listener did not accept connection")
	}
	if elapsed >= float64(resolveDelay.Milliseconds()/2) {
		t.Fatalf("executeTCPPing() = %.0fms, want DNS resolution time excluded", elapsed)
	}
}

func TestNormalizePingTimeout(t *testing.T) {
	cases := []struct {
		name string
		in   int
		want time.Duration
	}{
		{name: "zero uses default", in: 0, want: time.Duration(defaultPingTimeoutMS) * time.Millisecond},
		{name: "below floor", in: 1, want: time.Duration(minPingTimeoutMS) * time.Millisecond},
		{name: "above ceiling", in: maxPingTimeoutMS + 1000, want: time.Duration(maxPingTimeoutMS) * time.Millisecond},
		{name: "in range", in: 1500, want: 1500 * time.Millisecond},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := normalizePingTimeout(tc.in); got != tc.want {
				t.Fatalf("normalizePingTimeout(%d) = %s, want %s", tc.in, got, tc.want)
			}
		})
	}
}

func TestFetchPublicIPFromURLsKeepsOnlyRequestedPublicFamily(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("10.0.0.2 203.0.113.10 8.8.8.8 fc00::1 2001:db8::1 2606:4700:4700::1111"))
	}))
	defer server.Close()

	if got := fetchPublicIPFromURLs(context.Background(), server.Client(), []string{server.URL}, false); got != "8.8.8.8" {
		t.Fatalf("fetchPublicIPFromURLs(v4) = %q, want 8.8.8.8", got)
	}
	if got := fetchPublicIPFromURLs(context.Background(), server.Client(), []string{server.URL}, true); got != "2606:4700:4700::1111" {
		t.Fatalf("fetchPublicIPFromURLs(v6) = %q, want 2606:4700:4700::1111", got)
	}
}

func TestNormalizeTCPTargetAddress(t *testing.T) {
	address, host, port, err := normalizeTCPTargetAddress("example.com")
	if err != nil {
		t.Fatalf("normalizeTCPTargetAddress() error = %v", err)
	}
	if address != "example.com:80" || host != "example.com" || port != "80" {
		t.Fatalf("normalizeTCPTargetAddress(example.com) = %q %q %q", address, host, port)
	}

	address, host, port, err = normalizeTCPTargetAddress("2606:4700:4700::1111")
	if err != nil {
		t.Fatalf("normalizeTCPTargetAddress(bare ipv6) error = %v", err)
	}
	if address != "[2606:4700:4700::1111]:80" || host != "2606:4700:4700::1111" || port != "80" {
		t.Fatalf("normalizeTCPTargetAddress(bare ipv6) = %q %q %q", address, host, port)
	}

	address, host, port, err = normalizeTCPTargetAddress("[2606:4700:4700::1111]:443")
	if err != nil {
		t.Fatalf("normalizeTCPTargetAddress(ipv6) error = %v", err)
	}
	if address != "[2606:4700:4700::1111]:443" || host != "2606:4700:4700::1111" || port != "443" {
		t.Fatalf("normalizeTCPTargetAddress(ipv6) = %q %q %q", address, host, port)
	}
}

// 速率必须按接口独立基线计算：汇总标量做差会在接口集合变化时
// 把新网卡的历史累计流量误算成一个采样周期内的增量（线上表现为几百 MB/s）。
func TestNetworkDeltaIgnoresNewlyAppearedInterface(t *testing.T) {
	previous := map[string]interfaceCounters{
		"eth0": {sent: 1_000, recv: 2_000},
	}
	// wg0 是新出现的隧道接口，已累计 30GB 历史流量
	current := map[string]interfaceCounters{
		"eth0": {sent: 1_500, recv: 2_400},
		"wg0":  {sent: 30 << 30, recv: 30 << 30},
	}

	up, down := networkDelta(previous, current)
	if up != 500 {
		t.Fatalf("up delta = %d, want 500 (只应计 eth0 的增量)", up)
	}
	if down != 400 {
		t.Fatalf("down delta = %d, want 400 (只应计 eth0 的增量)", down)
	}
}

// 新接口在下一轮就应正常参与统计（只有出现的那一轮计 0）。
func TestNetworkDeltaCountsInterfaceFromSecondSample(t *testing.T) {
	previous := map[string]interfaceCounters{
		"eth0": {sent: 1_500, recv: 2_400},
		"wg0":  {sent: 30 << 30, recv: 30 << 30},
	}
	current := map[string]interfaceCounters{
		"eth0": {sent: 1_600, recv: 2_500},
		"wg0":  {sent: (30 << 30) + 700, recv: (30 << 30) + 800},
	}

	up, down := networkDelta(previous, current)
	if up != 800 {
		t.Fatalf("up delta = %d, want 800 (eth0 100 + wg0 700)", up)
	}
	if down != 900 {
		t.Fatalf("down delta = %d, want 900 (eth0 100 + wg0 800)", down)
	}
}

// 单个接口计数器重置时只重建该接口基线，不影响同轮其他接口。
func TestNetworkDeltaHandlesPerInterfaceReset(t *testing.T) {
	previous := map[string]interfaceCounters{
		"eth0": {sent: 5_000, recv: 5_000},
		"eth1": {sent: 9_000, recv: 9_000},
	}
	// eth1 计数器被重置（新值小于旧值），eth0 正常增长
	current := map[string]interfaceCounters{
		"eth0": {sent: 5_300, recv: 5_200},
		"eth1": {sent: 10, recv: 20},
	}

	up, down := networkDelta(previous, current)
	if up != 300 {
		t.Fatalf("up delta = %d, want 300 (eth1 重置应计 0，不应拖累 eth0)", up)
	}
	if down != 200 {
		t.Fatalf("down delta = %d, want 200", down)
	}
}

// 接口消失不应产生负增量。
func TestNetworkDeltaHandlesDisappearedInterface(t *testing.T) {
	previous := map[string]interfaceCounters{
		"eth0": {sent: 1_000, recv: 1_000},
		"tun0": {sent: 8_000, recv: 8_000},
	}
	current := map[string]interfaceCounters{
		"eth0": {sent: 1_200, recv: 1_100},
	}

	up, down := networkDelta(previous, current)
	if up != 200 || down != 100 {
		t.Fatalf("delta = (%d, %d), want (200, 100)", up, down)
	}
}

// 空输入不应 panic，也不应产生增量。
func TestNetworkDeltaEmptyInputs(t *testing.T) {
	if up, down := networkDelta(nil, nil); up != 0 || down != 0 {
		t.Fatalf("nil/nil delta = (%d, %d), want (0, 0)", up, down)
	}
	if up, down := networkDelta(map[string]interfaceCounters{}, map[string]interfaceCounters{
		"eth0": {sent: 5, recv: 5},
	}); up != 0 || down != 0 {
		t.Fatalf("首轮 delta = (%d, %d), want (0, 0)", up, down)
	}
}

// 端到端：接口集合变化时，prepareReportForInterval 不应报出荒谬速率。
func TestPrepareReportDoesNotSpikeOnInterfaceAppearance(t *testing.T) {
	p := &reportPreparer{}

	first := Report{
		Timestamp:       1_000_000,
		hasRawNetTotals: true,
		rawNetTotalUp:   1_000,
		rawNetTotalDown: 1_000,
		netPerInterface: map[string]interfaceCounters{
			"eth0": {sent: 1_000, recv: 1_000},
		},
	}
	p.prepareReportForInterval(first, 120)

	// 120 秒后 wg0 出现，带着 30GB 历史累计
	second := Report{
		Timestamp:       1_120_000,
		hasRawNetTotals: true,
		rawNetTotalUp:   1_000 + 1_200 + (30 << 30),
		rawNetTotalDown: 1_000 + 2_400 + (30 << 30),
		netPerInterface: map[string]interfaceCounters{
			"eth0": {sent: 1_000 + 1_200, recv: 1_000 + 2_400},
			"wg0":  {sent: 30 << 30, recv: 30 << 30},
		},
	}
	out := p.prepareReportForInterval(second, 120)

	if out.NetOut != 10 {
		t.Fatalf("NetOut = %d, want 10 (1200 字节 / 120 秒)", out.NetOut)
	}
	if out.NetIn != 20 {
		t.Fatalf("NetIn = %d, want 20 (2400 字节 / 120 秒)", out.NetIn)
	}
}

// ===== 后台下发的流量重置日 =====

// 统计口径的版本必须进 scope 哈希。
// scope 是服务端判定「上次读数是否还有效」的唯一依据：口径变了而 scope 没变，
// 升级后 raw 骤降会被当成计数器回绕，把整块计数再加一遍到当天的流量上。
func TestTrafficCounterScopeIncludesBasisVersion(t *testing.T) {
	legacy := shortHash(strings.TrimSpace(nicInclude) + "\n" + strings.TrimSpace(nicExclude))
	if trafficCounterScope() == legacy {
		t.Fatal("trafficCounterScope 不得退回「只哈希 include/exclude」的旧公式——" +
			"内置排除表或默认路由收敛逻辑变更时它必须跟着变")
	}
}

func TestExplicitModePrecedence(t *testing.T) {
	previousFlags, previousMode := flag.CommandLine, reportMode
	previousToken, previousServer, previousName := token, serverURL, clientName
	previousMountInclude, previousMountExclude := mountInclude, mountExclude
	previousNICInclude, previousNICExclude := nicInclude, nicExclude
	t.Cleanup(func() {
		flag.CommandLine, reportMode = previousFlags, previousMode
		token, serverURL, clientName = previousToken, previousServer, previousName
		mountInclude, mountExclude = previousMountInclude, previousMountExclude
		nicInclude, nicExclude = previousNICInclude, previousNICExclude
	})
	for _, name := range []string{"TOKEN", "SERVER", "NAME", "MOUNT_INCLUDE", "MOUNT_EXCLUDE", "NIC_INCLUDE", "NIC_EXCLUDE"} {
		t.Setenv("CF_MONITOR_"+name, "")
	}
	for _, tt := range []struct {
		name, environment, want string
		args                    []string
	}{
		{"explicit websocket", "http", "websocket", []string{"--mode", "websocket"}},
		{"explicit HTTP", "websocket", "http", []string{"--mode", "http"}},
		{"equals syntax", "http", "websocket", []string{"--mode=websocket"}},
		{"last explicit flag wins", "http", "websocket", []string{"--mode=http", "--mode=websocket"}},
		{"explicit mode overrides invalid environment", "invalid", "websocket", []string{"--mode", "websocket"}},
		{"environment only", "http", "http", nil},
		{"default", "", "websocket", nil},
	} {
		t.Run(tt.name, func(t *testing.T) {
			flags := flag.NewFlagSet("reaudit-mode", flag.ContinueOnError)
			flags.SetOutput(io.Discard)
			flags.StringVar(&reportMode, "mode", "websocket", "")
			flag.CommandLine = flags
			t.Setenv("CF_MONITOR_MODE", tt.environment)
			if err := flags.Parse(tt.args); err != nil {
				t.Fatal(err)
			}
			applyEnvDefaults()
			if reportMode != tt.want {
				t.Fatalf("mode=%q, want %q (CLI=%q, env=%q)", reportMode, tt.want, tt.args, tt.environment)
			}
		})
	}
}

func TestExplicitModeRejectsInvalid(t *testing.T) {
	if os.Getenv("REAUDIT_MODE_MAIN") == "1" {
		flag.CommandLine = flag.NewFlagSet("reaudit-invalid-mode", flag.ExitOnError)
		flag.StringVar(&reportMode, "mode", "websocket", "")
		flag.StringVar(&serverURL, "server", "http://127.0.0.1:1", "")
		flag.StringVar(&token, "token", "synthetic-token", "")
		os.Args = []string{"reaudit-agent"}
		if selected := os.Getenv("REAUDIT_CLI_MODE"); selected != "" {
			os.Args = append(os.Args, "--mode", selected)
		}
		main()
		return
	}
	for _, cli := range []string{"invalid", ""} {
		t.Run("CLI="+cli, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestExplicitModeRejectsInvalid$")
			command.Env = append(os.Environ(), "REAUDIT_MODE_MAIN=1", "REAUDIT_CLI_MODE="+cli, "CF_MONITOR_MODE=invalid",
				"CF_MONITOR_TRAFFIC_STATE_FILE="+filepath.Join(t.TempDir(), "traffic-state.json"),
				"CF_MONITOR_NAME=synthetic", "CF_MONITOR_MOUNT_INCLUDE=", "CF_MONITOR_MOUNT_EXCLUDE=",
				"CF_MONITOR_NIC_INCLUDE=", "CF_MONITOR_NIC_EXCLUDE=")
			output, err := command.CombinedOutput()
			if ctx.Err() != nil || err == nil || !strings.Contains(string(output), `unsupported mode "invalid"`) {
				t.Fatalf("invalid selected mode did not fail at validation: err=%v deadline=%v output=%s", err, ctx.Err(), output)
			}
		})
	}
}

func writeCgroupFixture(t *testing.T, root, name, value string) {
	t.Helper()
	file := filepath.Join(root, filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(value), 0600); err != nil {
		t.Fatal(err)
	}
}

func TestCgroupAncestorScope(t *testing.T) {
	for _, tc := range []struct {
		name, leafMax, leafCurrent, parentMax, parentCurrent string
		wantTotal, wantUsed                                  uint64
		wantRAM                                              bool
	}{
		{"unlimited leaf", "max", "134217728", "536870912", "402653184", 536870912, 402653184, true},
		{"looser leaf", "2147483648", "134217728", "536870912", "402653184", 536870912, 402653184, true},
		{"tighter leaf", "268435456", "67108864", "536870912", "402653184", 268435456, 67108864, true},
		{"equal limit includes parent usage", "536870912", "134217728", "536870912", "402653184", 536870912, 402653184, true},
		{"all unlimited", "max", "134217728", "max", "402653184", 0, 0, false},
		{"missing binding usage", "max", "134217728", "536870912", "", 0, 0, false},
		{"zero limit is real", "0", "0", "536870912", "402653184", 0, 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			writeCgroupFixture(t, root, "memory.max", tc.parentMax)
			if tc.parentCurrent != "" {
				writeCgroupFixture(t, root, "memory.current", tc.parentCurrent)
			}
			writeCgroupFixture(t, root, "system.slice/memory.max", "max")
			writeCgroupFixture(t, root, "system.slice/agent.service/memory.max", tc.leafMax)
			writeCgroupFixture(t, root, "system.slice/agent.service/memory.current", tc.leafCurrent)
			writeCgroupFixture(t, root, "self-cgroup", "0::/system.slice/agent.service\n")
			got := readCgroupMemory(root, filepath.Join(root, "self-cgroup"))
			if got.hasRAM != tc.wantRAM || got.ramTotal != tc.wantTotal || got.ramUsed != tc.wantUsed {
				t.Fatalf("effective group RAM = %+v; want available=%t total=%d used=%d", got, tc.wantRAM, tc.wantTotal, tc.wantUsed)
			}
		})
	}
}

func TestCgroupV1AncestorRAMAndSwapUseSameScope(t *testing.T) {
	root := t.TempDir()
	for name, value := range map[string]string{
		"memory/memory.limit_in_bytes":               "536870912",
		"memory/memory.usage_in_bytes":               "402653184",
		"memory/memory.memsw.limit_in_bytes":         "805306368",
		"memory/memory.memsw.usage_in_bytes":         "469762048",
		"memory/memory.use_hierarchy":                "1",
		"memory/service/memory.limit_in_bytes":       "2147483648",
		"memory/service/memory.usage_in_bytes":       "134217728",
		"memory/service/memory.memsw.limit_in_bytes": "3221225472",
		"memory/service/memory.memsw.usage_in_bytes": "167772160",
		"self-cgroup": "5:memory:/service\n",
	} {
		writeCgroupFixture(t, root, name, value)
	}
	got := readCgroupMemory(root, filepath.Join(root, "self-cgroup"))
	if !got.hasRAM || got.ramTotal != 536870912 || got.ramUsed != 402653184 || !got.hasSwap || got.swapTotal != 268435456 || got.swapUsed != 67108864 {
		t.Fatalf("v1 effective parent RAM/swap = %+v", got)
	}
}

func TestCgroupMountRootMappingAndBoundary(t *testing.T) {
	for _, processPath := range []string{"/tenant/service", "/tenant/../other/service"} {
		t.Run(processPath, func(t *testing.T) {
			base := t.TempDir()
			mount := filepath.Join(base, "mounted tree")
			writeCgroupFixture(t, base, "memory.max", "1")
			writeCgroupFixture(t, base, "memory.current", "1")
			writeCgroupFixture(t, mount, "memory.max", "536870912")
			writeCgroupFixture(t, mount, "memory.current", "402653184")
			writeCgroupFixture(t, mount, "service/memory.max", "max")
			writeCgroupFixture(t, mount, "service/memory.current", "134217728")
			writeCgroupFixture(t, base, "cgroup", "0::"+processPath+"\n")
			mountField := strings.ReplaceAll(filepath.ToSlash(mount), " ", `\040`)
			writeCgroupFixture(t, base, "mountinfo", fmt.Sprintf("29 23 0:26 /tenant %s rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup rw\n", mountField))
			got := readCgroupMemory(base, filepath.Join(base, "cgroup"))
			if processPath == "/tenant/service" {
				if !got.hasRAM || got.ramTotal != 536870912 || got.ramUsed != 402653184 {
					t.Fatalf("mounted subtree mapping escaped or missed parent: %+v", got)
				}
			} else if got.hasRAM {
				t.Fatalf("out-of-namespace path must not use an unrelated mount: %+v", got)
			}
		})
	}
}

func TestCgroupUnreadableUsageFallsBackToProc(t *testing.T) {
	root := t.TempDir()
	writeCgroupFixture(t, root, "memory.max", "536870912")
	writeCgroupFixture(t, root, "service/memory.max", "2147483648")
	writeCgroupFixture(t, root, "service/memory.current", "134217728")
	writeCgroupFixture(t, root, "self-cgroup", "0::/service\n")
	if err := os.Mkdir(filepath.Join(root, "memory.current"), 0700); err != nil {
		t.Fatal(err)
	}
	cgroup := readCgroupMemory(root, filepath.Join(root, "self-cgroup"))
	if cgroup.hasRAM {
		t.Fatalf("unreadable binding usage must not become zero or leaf usage: %+v", cgroup)
	}
	proc := parseProcMeminfo("MemTotal: 1024 kB\nMemFree: 256 kB\n")
	got := mergeMemorySnapshot(proc, cgroup, false)
	if !got.hasRAM || got.ramTotal != 1048576 || got.ramUsed != 786432 {
		t.Fatalf("unavailable cgroup must preserve proc fallback: %+v", got)
	}
}

func TestCgroupV2InheritedSwapScope(t *testing.T) {
	root := t.TempDir()
	for name, value := range map[string]string{
		"memory.swap.max": "268435456", "memory.swap.current": "67108864",
		"service/memory.max": "536870912", "service/memory.current": "134217728",
		"service/memory.swap.max": "max", "service/memory.swap.current": "16777216",
		"self-cgroup": "0::/service\n",
	} {
		writeCgroupFixture(t, root, name, value)
	}
	got := readCgroupMemory(root, filepath.Join(root, "self-cgroup"))
	if !got.hasSwap || got.swapTotal != 268435456 || got.swapUsed != 67108864 {
		t.Fatalf("swap must use its binding parent scope: %+v", got)
	}
}

func TestCgroupV1DisabledLegacyHierarchyDoesNotBindDescendants(t *testing.T) {
	root := t.TempDir()
	for name, value := range map[string]string{
		"memory/memory.limit_in_bytes": "536870912", "memory/memory.usage_in_bytes": "402653184",
		"memory/memory.use_hierarchy":          "0",
		"memory/service/memory.limit_in_bytes": "2147483648", "memory/service/memory.usage_in_bytes": "134217728",
		"self-cgroup": "5:memory:/service\n",
	} {
		writeCgroupFixture(t, root, name, value)
	}
	got := readCgroupMemory(root, filepath.Join(root, "self-cgroup"))
	if !got.hasRAM || got.ramTotal != 2147483648 || got.ramUsed != 134217728 {
		t.Fatalf("nonhierarchical legacy ancestor cannot constrain the child: %+v", got)
	}
}

// Only ping-platform.test.mjs replaces runtime.GOOS within the existing ICMP
// function. No other platform-sensitive collection or process code is replaced.
var reauditPingPlatform = runtime.GOOS

func TestICMPPlatform(t *testing.T) {
	if os.Getenv("REAUDIT_PING_OVERLAY") != "1" {
		t.Skip("run the real command matrix with node --test agent/ping-platform.test.mjs")
	}
	fixture, err := os.ReadFile(os.Getenv("REAUDIT_PING_FIXTURE"))
	if err != nil {
		t.Fatal(err)
	}
	prepare := func(t *testing.T, programs ...string) string {
		t.Helper()
		dir := t.TempDir()
		for _, name := range programs {
			if runtime.GOOS == "windows" {
				name += ".exe"
			}
			if err := os.WriteFile(filepath.Join(dir, name), fixture, 0700); err != nil {
				t.Fatal(err)
			}
		}
		t.Setenv("PATH", dir)
		t.Setenv("REAUDIT_PING_ARGS", filepath.Join(dir, "args.json"))
		t.Setenv("REAUDIT_PING_DELAY_MS", "0")
		return dir
	}
	const ip4 = "8.8.8.8"
	const ip6 = "2606:4700:4700::1111"
	tests := []struct {
		name, platform, target, program string
		args                            []string
		withoutAlias                    bool
	}{
		{"windows4", "windows", ip4, "ping", []string{"-4", "-n", "1", "-w", "2000", ip4}, false},
		{"windows6", "windows", "[" + ip6 + "]", "ping", []string{"-6", "-n", "1", "-w", "2000", ip6}, false},
		{"linux4", "linux", ip4, "ping", []string{"-4", "-n", "-c", "1", "-W", "2", ip4}, false},
		{"linux6", "linux", ip6, "ping", []string{"-6", "-n", "-c", "1", "-W", "2", ip6}, false},
		{"darwin4", "darwin", ip4, "ping", []string{"-n", "-c", "1", "-W", "2000", ip4}, false},
		{"darwin6", "darwin", ip6, "ping6", []string{"-n", "-c", "1", ip6}, false},
		{"freebsd4", "freebsd", ip4, "ping", []string{"-n", "-c", "1", "-W", "2000", ip4}, false},
		{"freebsd6-old-or-alias", "freebsd", ip6, "ping6", []string{"-n", "-c", "1", ip6}, false},
		{"freebsd6-merged-without-alias", "freebsd", ip6, "ping", []string{"-6", "-n", "-c", "1", "-W", "2000", ip6}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			programs := []string{"ping", "ping6"}
			if tt.withoutAlias {
				programs = []string{"ping"}
			}
			prepare(t, programs...)
			reauditPingPlatform = tt.platform
			if result := executeICMPPingWithContext(context.Background(), tt.target, 2000); result < 0 {
				t.Fatalf("fake command was not successfully called: %v", result)
			}
			raw, err := os.ReadFile(os.Getenv("REAUDIT_PING_ARGS"))
			if err != nil {
				t.Fatal(err)
			}
			var command struct {
				Name string   `json:"name"`
				Args []string `json:"args"`
			}
			if err := json.Unmarshal(raw, &command); err != nil {
				t.Fatal(err)
			}
			if command.Name != tt.program || !reflect.DeepEqual(command.Args, tt.args) {
				t.Fatalf("executed %s %q; want %s %q", command.Name, command.Args, tt.program, tt.args)
			}
		})
	}
	t.Run("darwin IPv6 tool unavailable", func(t *testing.T) {
		prepare(t, "ping")
		reauditPingPlatform = "darwin"
		if got := executeICMPPingWithContext(context.Background(), ip6, 2000); got != -1 {
			t.Fatalf("missing ping6 must be unavailable, got %v", got)
		}
		if _, err := os.Stat(os.Getenv("REAUDIT_PING_ARGS")); !os.IsNotExist(err) {
			t.Fatal("the IPv4-only command must not run as an IPv6 fallback")
		}
	})
	t.Run("unknown platform unavailable", func(t *testing.T) {
		prepare(t, "ping", "ping6")
		reauditPingPlatform = "unsupported"
		if got := executeICMPPingWithContext(context.Background(), ip4, 2000); got != -1 {
			t.Fatalf("unknown platform must be unavailable, got %v", got)
		}
	})
	t.Run("response beyond two milliseconds", func(t *testing.T) {
		prepare(t, "ping")
		reauditPingPlatform = "darwin"
		t.Setenv("REAUDIT_PING_DELAY_MS", "120")
		if got := executeICMPPingWithContext(context.Background(), ip4, 2000); got < 100 {
			t.Fatalf("valid delayed child response must not be unavailable: %v", got)
		}
	})
	t.Run("cancel an actual child", func(t *testing.T) {
		prepare(t, "ping")
		reauditPingPlatform = "windows"
		t.Setenv("REAUDIT_PING_DELAY_MS", "5000")
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		done := make(chan float64, 1)
		go func() { done <- executeICMPPingWithContext(ctx, ip4, 2000) }()
		readyBy := time.Now().Add(time.Second)
		for {
			if _, err := os.Stat(os.Getenv("REAUDIT_PING_ARGS")); err == nil {
				break
			}
			if time.Now().After(readyBy) {
				t.Fatal("child failed to reach the deterministic start barrier")
			}
			time.Sleep(5 * time.Millisecond)
		}
		cancel()
		select {
		case result := <-done:
			if result != -1 {
				t.Fatalf("cancelled child result = %v", result)
			}
		case <-time.After(500 * time.Millisecond):
			t.Fatal("ICMP command ignored parent cancellation")
		}
	})
	t.Run("total two-second budget", func(t *testing.T) {
		prepare(t, "ping6")
		reauditPingPlatform = "darwin"
		t.Setenv("REAUDIT_PING_DELAY_MS", "5000")
		started := time.Now()
		got := executeICMPPingWithContext(context.Background(), ip6, 2000)
		elapsed := time.Since(started)
		if got != -1 || elapsed < 1500*time.Millisecond || elapsed > 2500*time.Millisecond {
			t.Fatalf("no-response child result=%v elapsed=%v; want unavailable within two seconds", got, elapsed)
		}
	})
}

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

func TestWaitForContextHonorsCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	started := time.Now()
	if waitForContext(ctx, time.Hour) {
		t.Fatal("waitForContext() = true, want false after cancellation")
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("waitForContext() took %s after cancellation, want prompt return", elapsed)
	}
}

func TestWaitForContextWaitsForDuration(t *testing.T) {
	if !waitForContext(context.Background(), 10*time.Millisecond) {
		t.Fatal("waitForContext() = false, want true when the context stays live")
	}
}

func TestAgentServerHTTPClientIsSharedAndConfigured(t *testing.T) {
	transport, ok := agentServerHTTPClient.Transport.(*http.Transport)
	if !ok || transport == nil {
		t.Fatalf("agentServerHTTPClient.Transport = %T, want *http.Transport", agentServerHTTPClient.Transport)
	}
	if transport.MaxIdleConns == 0 || transport.MaxIdleConnsPerHost == 0 || transport.IdleConnTimeout == 0 {
		t.Fatalf("shared transport has no idle pool limits: %+v", transport)
	}
	if transport.TLSHandshakeTimeout == 0 {
		t.Fatal("shared transport has no TLS handshake timeout")
	}
	if agentServerHTTPClient.Timeout != agentServerRequestTimeout {
		t.Fatalf("client timeout = %s, want %s", agentServerHTTPClient.Timeout, agentServerRequestTimeout)
	}
}
