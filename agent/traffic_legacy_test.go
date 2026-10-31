package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

var legacyNow = time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)

func writeLegacy(t *testing.T, name, content string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

const legacyV2 = `{"reset_day":1,"period":"2026-10-01","scope":"scope-a","last_raw_up":1100,"last_raw_down":2300,
 "period_up":900,"period_down":1500,"last_boot_unix":1780000000,"counter_version":2,"revision":9,
 "interfaces":{"eth0":{"sent":1100,"recv":2300}},
 "days":{"2026-10-01":{"up":700,"down":900},"2026-10-30":{"up":100,"down":200},"2026-10-31":{"up":100,"down":400},"2026-05-01":{"up":999,"down":999}}}`

// v2：逐日增量原样导入（超出 100 天的丢弃），并带上最后一次的网卡读数作为基线。
func TestLegacyV2HistoryAndBaselineAreImported(t *testing.T) {
	path := writeLegacy(t, "traffic-state.json", legacyV2)
	imported := loadLegacyTrafficImport(path, legacyNow)
	if imported == nil {
		t.Fatal("expected an import")
	}
	wantDays := []TrafficDay{{"2026-10-01", 700, 900}, {"2026-10-30", 100, 200}, {"2026-10-31", 100, 400}}
	if !reflect.DeepEqual(imported.payload.Days, wantDays) {
		t.Fatalf("days = %+v, want %+v（今天的部分也要导入；超过 100 天的不导入）", imported.payload.Days, wantDays)
	}
	wantBaseline := &TrafficBaseline{Scope: "scope-a", Boot: 1780000000, Interfaces: map[string]TrafficCounter{"eth0": {Up: 1100, Down: 2300}}}
	if !reflect.DeepEqual(imported.payload.Baseline, wantBaseline) {
		t.Fatalf("baseline = %+v, want %+v", imported.payload.Baseline, wantBaseline)
	}
	// 读取过程不改动旧文件。
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("legacy file must stay in place until the server confirms: %v", err)
	}
}

// v1：只有「当期累计」，整块记在周期起始日。
func TestLegacyV1PeriodTotalBecomesOneDay(t *testing.T) {
	path := writeLegacy(t, "traffic-state.json", `{"reset_day":15,"period":"2026-10-15","scope":"s","last_raw_up":5,"last_raw_down":6,
	 "period_up":700,"period_down":900,"counter_version":1,"interfaces":{"eth0":{"sent":5,"recv":6}}}`)
	imported := loadLegacyTrafficImport(path, legacyNow)
	if imported == nil || !reflect.DeepEqual(imported.payload.Days, []TrafficDay{{"2026-10-15", 700, 900}}) {
		t.Fatalf("v1 import = %+v", imported)
	}
	if imported.payload.Baseline == nil || imported.payload.Baseline.Interfaces["eth0"] != (TrafficCounter{Up: 5, Down: 6}) {
		t.Fatalf("v1 baseline = %+v", imported.payload.Baseline)
	}
}

// v0：没有逐网卡读数，只导入累计，不带基线（新版第一次采样自行起基线）。
func TestLegacyV0HasNoBaseline(t *testing.T) {
	path := writeLegacy(t, "traffic-state.json", `{"reset_day":1,"period":"2026-10-01","last_raw_up":5,"last_raw_down":6,"period_up":70,"period_down":90}`)
	imported := loadLegacyTrafficImport(path, legacyNow)
	if imported == nil || imported.payload.Baseline != nil || len(imported.payload.Days) != 1 {
		t.Fatalf("v0 import = %+v", imported)
	}
}

// 多份候选（主文件 / 备份）：取 revision 最大的可读版本；导入完成后全部改名。
func TestLegacyPicksNewestGenerationAndRenamesAllCandidates(t *testing.T) {
	path := writeLegacy(t, "traffic-state.json", `{"period":"2026-10-01","scope":"s","period_up":1,"counter_version":2,"reset_day":1,"revision":3,"days":{"2026-10-30":{"up":1,"down":1}}}`)
	if err := os.WriteFile(path+".bak", []byte(`{"period":"2026-10-01","scope":"s","counter_version":2,"reset_day":1,"revision":8,"days":{"2026-10-30":{"up":88,"down":88}}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	imported := loadLegacyTrafficImport(path, legacyNow)
	if imported == nil || imported.payload.Days[0].Up != 88 {
		t.Fatalf("expected the newest generation (revision 8), got %+v", imported)
	}
	imported.finish()
	for _, name := range []string{path, path + ".bak"} {
		if _, err := os.Stat(name); !os.IsNotExist(err) {
			t.Fatalf("%s must be renamed after import", filepath.Base(name))
		}
		if _, err := os.Stat(name + ".imported"); err != nil {
			t.Fatalf("%s.imported missing: %v", filepath.Base(name), err)
		}
	}
	if loadLegacyTrafficImport(path, legacyNow) != nil {
		t.Fatal("a finished import must never run again")
	}
}

func TestLegacyUnreadableOrNewerStatesAreLeftAloneAndNotImported(t *testing.T) {
	for name, content := range map[string]string{
		"corrupt": `{not json`,
		"newer":   `{"counter_version":99,"days":{"2026-10-30":{"up":1,"down":1}}}`,
	} {
		path := writeLegacy(t, "traffic-state.json", content)
		if loadLegacyTrafficImport(path, legacyNow) != nil {
			t.Fatalf("%s: must not import from a state it cannot understand", name)
		}
		if data, err := os.ReadFile(path); err != nil || string(data) != content {
			t.Fatalf("%s: the file must be left untouched", name)
		}
	}
	if loadLegacyTrafficImport(filepath.Join(t.TempDir(), "traffic-state.json"), legacyNow) != nil {
		t.Fatal("no state file → nothing to import")
	}
}

// 文件能读懂但没有任何可导入的内容：不必等服务端确认，直接改名，避免每次启动都检查。
func TestLegacyWithNothingToImportIsRetiredImmediately(t *testing.T) {
	path := writeLegacy(t, "traffic-state.json", `{"period":"","counter_version":2,"reset_day":1,"days":{"2020-01-01":{"up":5,"down":5}}}`)
	if loadLegacyTrafficImport(path, legacyNow) != nil {
		t.Fatal("expired-only history has nothing to import")
	}
	if _, err := os.Stat(path + ".imported"); err != nil {
		t.Fatalf("an empty legacy state should be retired: %v", err)
	}
}

func TestLegacyImportIsAttachedToTheFirstReportAndRateLimited(t *testing.T) {
	imported := loadLegacyTrafficImport(writeLegacy(t, "traffic-state.json", legacyV2), legacyNow)
	now := time.Now()
	first := imported.attach(make([]Report, 3), now)
	if first[0].TrafficImport == nil || first[1].TrafficImport != nil || first[2].TrafficImport != nil {
		t.Fatal("the import must ride on the first report of an envelope only")
	}
	if imported.attach(make([]Report, 1), now.Add(time.Second))[0].TrafficImport != nil {
		t.Fatal("must wait for the confirmation before resending")
	}
	if imported.attach(make([]Report, 1), now.Add(legacyImportResendInterval+time.Second))[0].TrafficImport == nil {
		t.Fatal("an unconfirmed import must be retried")
	}
	imported.finish()
	if imported.attach(make([]Report, 1), now.Add(time.Hour))[0].TrafficImport != nil {
		t.Fatal("nothing to send after the import completed")
	}
	var none *legacyTrafficImport
	if none.attach(make([]Report, 1), now)[0].TrafficImport != nil {
		t.Fatal("no legacy history → never attach")
	}
	none.finish() // 不能 panic
}

func withLegacyImport(t *testing.T, content string) (string, *legacyTrafficImport) {
	t.Helper()
	path := writeLegacy(t, "traffic-state.json", content)
	imported := loadLegacyTrafficImport(path, legacyNow)
	previous := legacyImport
	legacyImport = imported
	t.Cleanup(func() { legacyImport = previous })
	return path, imported
}

// HTTP：服务端响应里 traffic_imported 为真才改名；没有就保留，下次继续发。
func TestHTTPAcknowledgementRetiresTheLegacyStateOnlyWhenConfirmed(t *testing.T) {
	oldURL, oldToken := serverURL, token
	t.Cleanup(func() { serverURL, token = oldURL, oldToken })
	path, _ := withLegacyImport(t, legacyV2)

	var body string
	reply := `{"success":true,"persisted":false}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		body = string(raw)
		_, _ = io.WriteString(w, reply)
	}))
	defer server.Close()
	serverURL, token = server.URL, "synthetic-token"

	if err := sendHTTPReports(attachTrafficImport([]Report{{}})); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(body, `"traffic_import"`) || !strings.Contains(body, `"2026-10-30"`) {
		t.Fatalf("import not sent: %s", body)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal("an unconfirmed import must not retire the legacy file")
	}

	reply = `{"success":true,"persisted":false,"traffic_imported":true}`
	if err := sendHTTPReports([]Report{{}}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path + ".imported"); err != nil {
		t.Fatalf("a confirmed import must retire the legacy file: %v", err)
	}
}

func TestWebSocketAckRetiresTheLegacyState(t *testing.T) {
	path, _ := withLegacyImport(t, legacyV2)
	proceed := make(chan struct{})
	upgrader := websocket.Upgrader{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		defer conn.Close()
		_ = conn.WriteJSON(serverMessage{Type: "ack", Timestamp: 1})
		<-proceed // 等客户端检查完「没有确认就不改名」再发确认
		_ = conn.WriteJSON(serverMessage{Type: "ack", Timestamp: 2, TrafficImported: true})
	}))
	defer server.Close()
	rawConn, _, err := websocket.DefaultDialer.Dial(testWebSocketURL(server.URL), nil)
	if err != nil {
		t.Fatal(err)
	}
	conn := &safeWebSocketConn{conn: rawConn}
	defer conn.Close()
	acks := make(chan struct{}, 2)
	go readWebSocketMessages(conn, make(chan error, 1), make(chan serverMessage, 1), acks)
	<-acks
	if _, err := os.Stat(path); err != nil {
		t.Fatal("an ack without traffic_imported must leave the legacy file alone")
	}
	close(proceed)
	<-acks
	if _, err := os.Stat(path + ".imported"); err != nil {
		t.Fatalf("the confirming ack must retire the legacy file: %v", err)
	}
}
