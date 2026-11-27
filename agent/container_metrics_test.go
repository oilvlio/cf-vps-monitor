package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/sensors"
)

func TestContainerMetricsUnknownReportJSON(t *testing.T) {
	report := Report{
		CPU: 17, RAM: 46612480, RAMTotal: 128000000,
		BasicInfo: &BasicInfo{DiskTotal: 1055735824384, Uptime: 330000},
	}
	data, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"disk", "disk_total", "uptime"} {
		t.Run(name, func(t *testing.T) {
			if string(fields[name]) != "null" {
				t.Fatalf("unavailable %s = %s, want explicit JSON null", name, fields[name])
			}
		})
	}
	if string(fields["cpu"]) != "17" || string(fields["ram_total"]) != "128000000" {
		t.Fatal("known container metrics changed while encoding unavailable metrics")
	}
}

const independentContainerMount = "31 20 253:1 / / rw,relatime - ext4 /dev/mapper/vg-container rw\n"
const sharedContainerMount = "31 20 253:0 /containers/example/rootfs / rw,relatime,idmapped - ext4 /dev/bcache0 rw\n"
const lxcfsUptimeMount = "32 20 0:54 /proc/uptime /proc/uptime rw,nosuid,nodev - fuse.lxcfs lxcfs rw,allow_other\n"

func containerMetricFixture(t *testing.T, mountinfo string) nodeMetricSource {
	t.Helper()
	root := t.TempDir()
	writeFileTree(t, root, map[string]string{
		"run/systemd/container": "lxc\n",
		"proc/self/mountinfo":   mountinfo,
		"proc/uptime":           "123.45 456.78\n",
	})
	return nodeMetricSource{
		platform: "linux",
		root:     root,
		partitions: func(all bool) ([]disk.PartitionStat, error) {
			if !all {
				t.Fatal("disk selection must see the actual mount list")
			}
			return []disk.PartitionStat{{Device: "/dev/mapper/vg-container", Mountpoint: "/", Fstype: "ext4"}}, nil
		},
		diskUsage: func(name string) (*disk.UsageStat, error) {
			return &disk.UsageStat{Path: name, Total: 100, Used: 20}, nil
		},
		hostUptime: func() (uint64, error) { return 9000000, nil },
	}
}

func assertContainerMetricInt(t *testing.T, label string, got *int64, want int64) {
	t.Helper()
	if want < 0 {
		if got != nil {
			t.Errorf("%s = %d, want unavailable", label, *got)
		}
		return
	}
	if got == nil {
		t.Errorf("%s = unavailable, want %d", label, want)
	} else if *got != want {
		t.Errorf("%s = %d, want %d", label, *got, want)
	}
}

func TestContainerMetricsDiskFiltersAndAggregation(t *testing.T) {
	for _, tc := range []struct {
		name, include, exclude string
		used, total            int64
	}{
		{"default dedup keeps the larger filesystem", "", "", 900, 10000},
		{"exclude shared bind", "", "/shared", 20, 100},
		{"explicit root", "/", "", 20, 100},
		{"explicit shared bind", "/shared", "", 900, 10000},
		{"explicit mounts sum", "/,/shared", "", 920, 10100},
		{"exclude wins over include", "/", "/", 0, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source := containerMetricFixture(t, independentContainerMount+"32 20 253:1 /host/shared /shared rw - ext4 /dev/mapper/vg-container rw\n")
			source.partitions = func(bool) ([]disk.PartitionStat, error) {
				return []disk.PartitionStat{
					{Device: "/dev/mapper/vg-container", Mountpoint: "/", Fstype: "ext4"},
					{Device: "/dev/mapper/vg-container", Mountpoint: "/shared", Fstype: "ext4"},
					{Device: "tmpfs", Mountpoint: "/run", Fstype: "tmpfs"},
				}, nil
			}
			source.diskUsage = func(name string) (*disk.UsageStat, error) {
				switch name {
				case "/":
					return &disk.UsageStat{Path: name, Used: 20, Total: 100}, nil
				case "/shared":
					return &disk.UsageStat{Path: name, Used: 900, Total: 10000}, nil
				default:
					t.Fatalf("unexpected disk path %q", name)
					return nil, errors.New("unexpected disk path")
				}
			}
			used, total := source.diskUsageTotals(tc.include, tc.exclude)
			assertContainerMetricInt(t, "used", used, tc.used)
			assertContainerMetricInt(t, "total", total, tc.total)
		})
	}
}

func TestContainerMetricsDiskReadFailures(t *testing.T) {
	for _, tc := range []struct {
		name        string
		used, total int64
	}{
		{"partitions", 0, 0},
		{"missing mountinfo", 20, 100},
		{"usage", 0, 0},
		{"zero total", 0, 0},
		{"used exceeds total", 101, 100},
		{"overflow", 0, 0},
		{"partial multiple disks", 20, 100},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source := containerMetricFixture(t, independentContainerMount)
			switch tc.name {
			case "partitions":
				source.partitions = func(bool) ([]disk.PartitionStat, error) { return nil, errors.New("denied") }
			case "missing mountinfo":
				if err := os.Remove(filepath.Join(source.root, "proc", "self", "mountinfo")); err != nil {
					t.Fatal(err)
				}
			case "usage":
				source.diskUsage = func(string) (*disk.UsageStat, error) { return nil, errors.New("denied") }
			case "zero total":
				source.diskUsage = func(string) (*disk.UsageStat, error) { return &disk.UsageStat{}, nil }
			case "used exceeds total":
				source.diskUsage = func(string) (*disk.UsageStat, error) { return &disk.UsageStat{Used: 101, Total: 100}, nil }
			case "overflow":
				source.diskUsage = func(string) (*disk.UsageStat, error) { return &disk.UsageStat{Total: 1 << 63}, nil }
			case "partial multiple disks":
				source.partitions = func(bool) ([]disk.PartitionStat, error) {
					return []disk.PartitionStat{{Device: "/dev/mapper/vg-container", Mountpoint: "/", Fstype: "ext4"}, {Device: "/dev/vdb1", Mountpoint: "/data", Fstype: "xfs"}}, nil
				}
				source.diskUsage = func(name string) (*disk.UsageStat, error) {
					if name == "/data" {
						return nil, errors.New("denied")
					}
					return &disk.UsageStat{Used: 20, Total: 100}, nil
				}
			}
			used, total := source.diskUsageTotals("", "")
			assertContainerMetricInt(t, "used", used, tc.used)
			assertContainerMetricInt(t, "total", total, tc.total)
		})
	}
}

func TestContainerMetricsUptimeSource(t *testing.T) {
	for _, tc := range []struct {
		name, mountinfo, contents string
		want                      int64
	}{
		{"lxcfs seconds", lxcfsUptimeMount, "123.45 456.78\n", 123},
		{"measured zero", lxcfsUptimeMount, "0.00 0.00\n", 0},
		{"native proc is not container proof", "32 20 0:1 / /proc rw - proc proc rw\n", "9000000.00 0.00\n", -1},
		{"lxcfs elsewhere is not uptime proof", "32 20 0:54 /proc/stat /proc/stat rw - fuse.lxcfs lxcfs rw\n", "9000000.00 0.00\n", -1},
		{"missing mount", "", "9000000.00 0.00\n", -1},
		{"negative", lxcfsUptimeMount, "-1.00 0\n", -1},
		{"empty", lxcfsUptimeMount, "", -1},
		{"not a number", lxcfsUptimeMount, "NaN 0\n", -1},
		{"infinity", lxcfsUptimeMount, "+Inf 0\n", -1},
		{"overflow", lxcfsUptimeMount, "9223372036854775808 0\n", -1},
		{"nonnumeric", lxcfsUptimeMount, "oops 0\n", -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source := containerMetricFixture(t, independentContainerMount+tc.mountinfo)
			writeFileTree(t, source.root, map[string]string{"proc/uptime": tc.contents})
			var calls int
			source.hostUptime = func() (uint64, error) { calls++; return 9000000, nil }
			assertContainerMetricInt(t, "uptime", source.uptime(), tc.want)
			if calls != 0 {
				t.Errorf("container uptime fell back to host uptime %d times", calls)
			}
		})
	}
	t.Run("unreadable uptime", func(t *testing.T) {
		source := containerMetricFixture(t, independentContainerMount+lxcfsUptimeMount)
		if err := os.Remove(filepath.Join(source.root, "proc", "uptime")); err != nil {
			t.Fatal(err)
		}
		assertContainerMetricInt(t, "uptime", source.uptime(), -1)
	})
	for _, platform := range []string{"linux", "windows", "darwin", "freebsd"} {
		t.Run("original host uptime on "+platform, func(t *testing.T) {
			source := containerMetricFixture(t, "")
			source.platform, source.root = platform, t.TempDir()
			assertContainerMetricInt(t, "uptime", source.uptime(), 9000000)
			source.hostUptime = func() (uint64, error) { return 0, errors.New("unavailable") }
			assertContainerMetricInt(t, "failed host uptime", source.uptime(), -1)
		})
	}
}

func TestContainerMetricsTemperatureScope(t *testing.T) {
	previous := nodeTemperatureSampler
	t.Cleanup(func() { nodeTemperatureSampler = previous })
	for _, tc := range []struct {
		name, platform string
		files          map[string]string
		container      bool
	}{
		{"systemd lxc", "linux", map[string]string{"run/systemd/container": "lxc\n"}, true},
		{"lxcfs on Alpine", "linux", map[string]string{"proc/mounts": "lxcfs /proc/stat fuse.lxcfs rw 0 0\n"}, true},
		{"lxc boot marker", "linux", map[string]string{"dev/.lxc-boot-id": "fixture"}, true},
		{"cgroup self marker", "linux", map[string]string{"proc/self/cgroup": "0::/lxc/example\n"}, true},
		{"docker", "linux", map[string]string{".dockerenv": ""}, true},
		{"podman", "linux", map[string]string{"run/.containerenv": ""}, true},
		{"bare metal", "linux", map[string]string{"proc/mounts": "/dev/vda1 / ext4 rw 0 0\n"}, false},
		{"physical host running LXCFS", "linux", map[string]string{"proc/mounts": "lxcfs /var/lib/lxcfs fuse.lxcfs rw 0 0\n"}, false},
		{"non-Linux with incidental marker", "windows", map[string]string{".dockerenv": ""}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source := containerMetricFixture(t, "")
			source.root, source.platform = t.TempDir(), tc.platform
			writeFileTree(t, source.root, tc.files)
			var calls atomic.Int32
			nodeTemperatureSampler = newHostTemperatureSampler("linux", func(context.Context) ([]sensors.TemperatureStat, error) {
				calls.Add(1)
				return []sensors.TemperatureStat{{SensorKey: "coretemp_package_id_0", Temperature: 60}}, nil
			})
			value := source.temperature(context.Background())
			if tc.container {
				if value != nil || calls.Load() != 0 {
					t.Fatal("container reported or sampled a host hardware sensor")
				}
			} else if value == nil || *value != 60 || calls.Load() != 1 {
				t.Fatal("noncontainer host sensor behavior changed")
			}
		})
	}
}

func TestContainerMetricsCollectorWiring(t *testing.T) {
	for _, trustedUptime := range []bool{false, true} {
		t.Run(fmt.Sprintf("trusted uptime %t", trustedUptime), func(t *testing.T) {
			preparer, _ := basicInfoDeliveryFixture(t)
			previousSource, previousSampler := nodeMetrics, nodeTemperatureSampler
			previousInclude, previousExclude := mountInclude, mountExclude
			t.Cleanup(func() {
				nodeMetrics, nodeTemperatureSampler = previousSource, previousSampler
				mountInclude, mountExclude = previousInclude, previousExclude
			})
			mountinfo := sharedContainerMount
			if trustedUptime {
				mountinfo += lxcfsUptimeMount
			}
			nodeMetrics = containerMetricFixture(t, mountinfo)
			nodeMetrics.partitions = func(bool) ([]disk.PartitionStat, error) {
				return []disk.PartitionStat{{Device: "/dev/bcache0", Mountpoint: "/", Fstype: "ext4"}}, nil
			}
			nodeMetrics.diskUsage = func(string) (*disk.UsageStat, error) {
				return &disk.UsageStat{Used: 12951896064, Total: 1055735824384}, nil
			}
			var reads atomic.Int32
			nodeTemperatureSampler = newHostTemperatureSampler("linux", func(context.Context) ([]sensors.TemperatureStat, error) {
				reads.Add(1)
				return []sensors.TemperatureStat{{SensorKey: "coretemp", Temperature: 60}}, nil
			})
			mountInclude, mountExclude = "", ""
			gpuDetailsMu.Lock()
			globalGPUDetails = nil
			gpuDetailsMu.Unlock()
			// Avoid real GPU/virtualization subprocesses in this source fixture.
			t.Setenv("PATH", t.TempDir())
			report := collectReportWithInterval(3)
			preparer.attachBasicInfoIfDue(&report, time.Now())
			if report.BasicInfo == nil || report.BasicInfo.DiskTotal != 1055735824384 {
				t.Errorf("basic disk total did not come from statfs: %#v", report.BasicInfo)
			}
			wantUptime, wantBasicUptime := int64(-1), int64(0)
			if trustedUptime {
				wantUptime, wantBasicUptime = 123, 123
			}
			assertContainerMetricInt(t, "report uptime", report.Uptime, wantUptime)
			if report.BasicInfo != nil && report.BasicInfo.Uptime != wantBasicUptime {
				t.Errorf("basic uptime = %d, want %d", report.BasicInfo.Uptime, wantBasicUptime)
			}
			assertContainerMetricInt(t, "reported used", report.Disk, 12951896064)
			assertContainerMetricInt(t, "reported total", report.DiskTotal, 1055735824384)
			if report.Temp != nil || reads.Load() != 0 {
				t.Error("container report retained a host temperature reading")
			}
			data, err := json.Marshal(report)
			if err != nil {
				t.Fatal(err)
			}
			var fields map[string]json.RawMessage
			if err := json.Unmarshal(data, &fields); err != nil {
				t.Fatal(err)
			}
			if string(fields["disk"]) != "12951896064" || string(fields["temp"]) != "null" {
				t.Errorf("prepared report disk=%s temp=%s", fields["disk"], fields["temp"])
			}
			if report.ReportInterval != 3 || report.Timestamp <= 0 || report.RAMTotal <= 0 {
				t.Error("normal interval, timestamp or memory collection was lost")
			}
		})
	}
}

func TestTemperatureUnknownReportJSON(t *testing.T) {
	body, err := json.Marshal(Report{})
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		t.Fatal(err)
	}
	if value := string(fields["temp"]); value != "null" {
		t.Fatalf("unmeasured host temperature = %s; want explicit JSON null", value)
	}
}

func assertTemperatureJSON(t *testing.T, report Report, want *float64) {
	t.Helper()
	body, err := json.Marshal(report)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(body, &fields); err != nil {
		t.Fatal(err)
	}
	value, present := fields["temp"]
	if !present {
		t.Fatal("temperature field is missing")
	}
	if want == nil {
		if string(value) != "null" {
			t.Fatalf("unavailable temperature = %s, want null", value)
		}
		return
	}
	if string(value) == "null" {
		t.Fatalf("measured temperature became null, want %v", *want)
	}
	var got float64
	if err := json.Unmarshal(value, &got); err != nil || got != *want {
		t.Fatalf("temperature = %s, want %v (decode error: %v)", value, *want, err)
	}
}

func TestTemperatureSensorContract(t *testing.T) {
	pointer := func(v float64) *float64 { return &v }
	for _, tc := range []struct {
		name    string
		sensors []sensors.TemperatureStat
		err     error
		want    *float64
	}{
		{
			name: "maximum identified CPU package and SoC, not GPU or disk",
			sensors: []sensors.TemperatureStat{
				{SensorKey: "coretemp_package_id_0", Temperature: 61.25},
				{SensorKey: "coretemp_core_1", Temperature: 58},
				{SensorKey: "cpu-thermal", Temperature: 72.125},
				{SensorKey: "amdgpu_edge", Temperature: 95},
				{SensorKey: "nvme_composite", Temperature: 110},
			},
			want: pointer(72.125),
		},
		{name: "real zero", sensors: []sensors.TemperatureStat{{SensorKey: "k10temp_tdie", Temperature: 0}}, want: pointer(0)},
		{name: "negative Celsius", sensors: []sensors.TemperatureStat{{SensorKey: "k8temp", Temperature: -7.5}}, want: pointer(-7.5)},
		{name: "lower bound", sensors: []sensors.TemperatureStat{{SensorKey: "soc_thermal", Temperature: -100}}, want: pointer(-100)},
		{name: "upper bound", sensors: []sensors.TemperatureStat{{SensorKey: "x86_pkg_temp", Temperature: 150}}, want: pointer(150)},
		{name: "unlabelled CPU driver", sensors: []sensors.TemperatureStat{{SensorKey: "coretemp", Temperature: 42}}, want: pointer(42)},
		{name: "explicit SoC driver", sensors: []sensors.TemperatureStat{{SensorKey: "bcm2835_thermal", Temperature: 38}}, want: pointer(38)},
		{name: "normalized known key", sensors: []sensors.TemperatureStat{{SensorKey: " Coretemp_Core_0 ", Temperature: 39}}, want: pointer(39)},
		{
			name: "invalid CPU readings do not hide valid measurements",
			sensors: []sensors.TemperatureStat{
				{SensorKey: "coretemp_core_0", Temperature: math.NaN()},
				{SensorKey: "coretemp_core_1", Temperature: math.Inf(1)},
				{SensorKey: "coretemp_core_2", Temperature: math.Inf(-1)},
				{SensorKey: "coretemp_core_3", Temperature: -100.1},
				{SensorKey: "coretemp_core_4", Temperature: 150.1},
				{SensorKey: "coretemp_core_5", Temperature: 31.5},
			},
			want: pointer(31.5),
		},
		{name: "only invalid", sensors: []sensors.TemperatureStat{{SensorKey: "coretemp", Temperature: math.NaN()}, {SensorKey: "cpu-thermal", Temperature: 1000}}},
		{name: "GPU only", sensors: []sensors.TemperatureStat{{SensorKey: "amdgpu_core", Temperature: 90}, {SensorKey: "nouveau_core", Temperature: 95}}},
		{name: "unknown ACPI and board sensors", sensors: []sensors.TemperatureStat{{SensorKey: `ACPI\ThermalZone\TZ00_0`, Temperature: 27}, {SensorKey: "acpitz", Temperature: 28}, {SensorKey: "board_cpu", Temperature: 80}, {SensorKey: "ambient", Temperature: 25}}},
		{name: "similar labels are not CPU proof", sensors: []sensors.TemperatureStat{{SensorKey: "coretemperature", Temperature: 75}, {SensorKey: "coretemp_gpu", Temperature: 85}, {SensorKey: "gpu_coretemp_core_1", Temperature: 90}, {SensorKey: "k10temp_tccd1_gpu", Temperature: 95}}},
		{name: "Tctl is not measured Celsius", sensors: []sensors.TemperatureStat{{SensorKey: "k10temp_tctl", Temperature: 95}, {SensorKey: "k10temp", Temperature: 85}}},
		{name: "Tdie and Tccd survive a hotter control value", sensors: []sensors.TemperatureStat{{SensorKey: "k10temp_tctl", Temperature: 100}, {SensorKey: "k10temp_tdie", Temperature: 45.25}, {SensorKey: "k10temp_tccd1", Temperature: 48.5}, {SensorKey: "k10temp_tccd2", Temperature: 47}}, want: pointer(48.5)},
		{name: "no devices"},
		{name: "read failed", err: errors.New("synthetic sensor read failed")},
		{name: "partial samples with read failure", sensors: []sensors.TemperatureStat{{SensorKey: "coretemp", Temperature: 42}}, err: errors.New("synthetic partial read")},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sampler := newHostTemperatureSampler("linux", func(ctx context.Context) ([]sensors.TemperatureStat, error) {
				return tc.sensors, tc.err
			})
			value := sampler.sample(context.Background())
			assertTemperatureJSON(t, Report{Temp: value, CPU: 17}, tc.want)
		})
	}
}

func TestTemperaturePlatformReadBoundary(t *testing.T) {
	for _, goos := range []string{"linux", "windows", "darwin", "freebsd", "unknown"} {
		t.Run(goos, func(t *testing.T) {
			var calls atomic.Int32
			sampler := newHostTemperatureSampler(goos, func(ctx context.Context) ([]sensors.TemperatureStat, error) {
				calls.Add(1)
				return []sensors.TemperatureStat{{SensorKey: "coretemp", Temperature: 23}}, nil
			})
			value := sampler.sample(context.Background())
			if goos == "linux" {
				if calls.Load() != 1 || value == nil || *value != 23 {
					t.Fatal("identified Linux source was not read")
				}
			} else if calls.Load() != 0 || value != nil {
				t.Fatalf("unsupported platform queried the sensor driver: calls=%d", calls.Load())
			}
		})
	}
}

func TestTemperatureCollectorWiring(t *testing.T) {
	previousSampler := nodeTemperatureSampler
	previousSource := nodeMetrics
	// This test exercises a supported physical host sensor regardless of
	// whether the CI process itself happens to run inside a container.
	nodeMetrics.root = t.TempDir()
	gpuDetailsMu.Lock()
	previousGPU := globalGPUDetails
	globalGPUDetails = nil
	gpuDetailsMu.Unlock()
	t.Cleanup(func() {
		nodeTemperatureSampler = previousSampler
		nodeMetrics = previousSource
		gpuDetailsMu.Lock()
		globalGPUDetails = previousGPU
		gpuDetailsMu.Unlock()
	})
	for _, tc := range []struct {
		name    string
		present bool
		value   float64
	}{
		{"missing", false, 0},
		{"measured zero", true, 0},
		{"measured negative", true, -2.75},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			nodeTemperatureSampler = newHostTemperatureSampler("linux", func(ctx context.Context) ([]sensors.TemperatureStat, error) {
				calls.Add(1)
				if !tc.present {
					return nil, nil
				}
				return []sensors.TemperatureStat{{SensorKey: "cpu-thermal", Temperature: tc.value}}, nil
			})
			report := collectReportWithInterval(3)
			if calls.Load() != 1 || report.ReportInterval != 3 || report.Timestamp <= 0 {
				t.Fatal("normal report collection did not include exactly one sensor sample")
			}
			var want *float64
			if tc.present {
				want = &tc.value
			}
			assertTemperatureJSON(t, report, want)
		})
	}
}

func TestTemperatureSlowReadBudgetAndSingleFlight(t *testing.T) {
	started, release, readerReturned := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	var calls atomic.Int32
	sampler := newHostTemperatureSampler("linux", func(ctx context.Context) ([]sensors.TemperatureStat, error) {
		if calls.Add(1) == 1 {
			close(started)
			<-release // Model an OS read that does not observe ctx cancellation.
			close(readerReturned)
			return []sensors.TemperatureStat{{SensorKey: "coretemp", Temperature: 88}}, nil
		}
		return []sensors.TemperatureStat{{SensorKey: "coretemp", Temperature: 37}}, nil
	})
	firstResult := make(chan *float64, 1)
	start := time.Now()
	go func() { firstResult <- sampler.sample(context.Background()) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("sensor read did not start")
	}
	select {
	case value := <-firstResult:
		if value != nil {
			t.Fatal("unresponsive sensor reported a value")
		}
	case <-time.After(time.Second):
		t.Fatal("sensor read blocked the report beyond its budget")
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("temperature timeout took %s, budget is %s", elapsed, hostTemperatureReadBudget)
	}

	var retries sync.WaitGroup
	for range 100 {
		retries.Go(func() {
			if value := sampler.sample(context.Background()); value != nil {
				t.Error("blocked reader produced a later sample")
			}
		})
	}
	retries.Wait()
	if count := calls.Load(); count != 1 {
		t.Fatalf("timed-out OS read accumulated %d sensor calls, want 1", count)
	}
	unblock()
	select {
	case <-readerReturned:
	case <-time.After(time.Second):
		t.Fatal("synthetic reader was not released")
	}
	deadline := time.Now().Add(time.Second)
	for {
		value := sampler.sample(context.Background())
		if value != nil {
			if *value != 37 || calls.Load() != 2 {
				t.Fatalf("late sample was reused or retries leaked: value=%v, calls=%d", *value, calls.Load())
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("sampler did not recover after the old OS read returned")
		}
		time.Sleep(time.Millisecond)
	}
}

func TestTemperatureCancelledReadKeepsGateUntilReturn(t *testing.T) {
	started, release, readerReturned := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	var calls atomic.Int32
	sampler := newHostTemperatureSampler("linux", func(ctx context.Context) ([]sensors.TemperatureStat, error) {
		calls.Add(1)
		close(started)
		<-release
		close(readerReturned)
		return []sensors.TemperatureStat{{SensorKey: "coretemp", Temperature: 20}}, nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan *float64, 1)
	go func() { result <- sampler.sample(ctx) }()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("sensor read did not start")
	}
	cancel()
	select {
	case value := <-result:
		if value != nil {
			t.Fatal("cancelled reading became a measurement")
		}
	case <-time.After(time.Second):
		t.Fatal("caller cancellation did not release reporting")
	}
	for range 10 {
		if value := sampler.sample(context.Background()); value != nil {
			t.Fatal("cancelled but unfinished read became a later measurement")
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("cancelled OS read accumulated %d calls", calls.Load())
	}
	unblock()
	select {
	case <-readerReturned:
	case <-time.After(time.Second):
		t.Fatal("synthetic reader was not released")
	}
}

func TestTemperatureAlreadyCancelledDoesNotRead(t *testing.T) {
	var calls atomic.Int32
	sampler := newHostTemperatureSampler("linux", func(ctx context.Context) ([]sensors.TemperatureStat, error) {
		calls.Add(1)
		return nil, nil
	})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if sampler.sample(ctx) != nil || calls.Load() != 0 {
		t.Fatal("a previously cancelled sample still queried sensors")
	}
}
