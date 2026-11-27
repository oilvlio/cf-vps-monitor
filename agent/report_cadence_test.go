package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestReportDeadlineKeepsPhaseAndSkipsMissedSlots(t *testing.T) {
	base := time.Unix(100, 0)
	for _, tc := range []struct {
		name      string
		now, want time.Duration
	}{
		{"not due", 2 * time.Second, 3 * time.Second},
		{"collection cost", 4 * time.Second, 6 * time.Second},
		{"exact boundary", 6 * time.Second, 9 * time.Second},
		{"multiple missed slots", 13 * time.Second, 15 * time.Second},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := nextReportDeadline(base.Add(3*time.Second), 3*time.Second, base.Add(tc.now))
			if !got.Equal(base.Add(tc.want)) {
				t.Fatalf("deadline = %s, want %s", got.Sub(base), tc.want)
			}
		})
	}
}

func TestWebSocketReportCadence(t *testing.T) {
	previousInterval := reportInterval
	t.Cleanup(func() { reportInterval = previousInterval })
	for _, tc := range []struct {
		name        string
		cost        time.Duration
		policyEvery time.Duration
		uploadSec   int
	}{
		{"collection does not extend sample period", time.Second, 0, 3},
		{"unchanged policies do not postpone sampling", 0, 200 * time.Millisecond, 3},
		{"unchanged policies do not postpone batch upload", 0, 200 * time.Millisecond, 6},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reports := make(chan []Report, 16)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				peer, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
				if err != nil {
					return
				}
				defer peer.Close()
				if tc.policyEvery > 0 {
					// One writer handles policy ticks and ACKs, as Gorilla requires.
					ack := make(chan struct{}, 16)
					stopped := make(chan struct{})
					defer close(stopped)
					go func() {
						ticker := time.NewTicker(tc.policyEvery)
						defer ticker.Stop()
						for {
							var message serverMessage
							select {
							case <-stopped:
								return
							case <-ack:
								message.Type = "ack"
							case <-ticker.C:
								message = serverMessage{Type: "policy", SampleIntervalSec: 3, ReportIntervalSec: tc.uploadSec}
							}
							if peer.WriteJSON(message) != nil {
								return
							}
						}
					}()
					for {
						_, raw, err := peer.ReadMessage()
						if err != nil {
							return
						}
						rows, err := decodeWireReports(raw)
						if err != nil {
							return
						}
						reports <- rows
						ack <- struct{}{}
					}
				}
				for {
					_, raw, err := peer.ReadMessage()
					if err != nil {
						return
					}
					rows, err := decodeWireReports(raw)
					if err != nil {
						return
					}
					reports <- rows
					if peer.WriteJSON(serverMessage{Type: "ack"}) != nil {
						return
					}
				}
			}))
			defer server.Close()
			endpoint, _ := webSocketEndpoint(server.URL, "fixture")
			conn, err := connectWebSocket(endpoint, "fixture")
			if err != nil {
				t.Fatal(err)
			}
			state := newPingReportState()
			defer state.close()
			preparer := &reportPreparer{lastBasicInfoAt: time.Now(), collect: func(interval int) Report {
				at := time.Now().UnixMilli()
				time.Sleep(tc.cost)
				return Report{CPU: 42, Timestamp: at, ReportInterval: interval, Version: "fixture"}
			}}
			done := make(chan error, 1)
			go func() {
				done <- runWebSocketSession(context.Background(), conn, preparer, state, 3*time.Second, time.Second)
			}()
			defer func() {
				conn.Close()
				select {
				case <-done:
				case <-time.After(3 * time.Second):
					t.Error("session did not stop")
				}
			}()
			receive := func() []Report {
				t.Helper()
				select {
				case rows := <-reports:
					if len(rows) == 0 {
						t.Fatal("empty report batch")
					}
					return rows
				case <-time.After(8 * time.Second):
					t.Fatal("periodic reports starved")
					return nil
				}
			}
			first := receive()[0]
			second := receive()
			gap := time.Duration(second[0].Timestamp-first.Timestamp) * time.Millisecond
			if gap < 2700*time.Millisecond || gap > 3500*time.Millisecond {
				t.Fatalf("sample gap = %s, want approximately 3s", gap)
			}
			if tc.uploadSec == 6 {
				if len(second) < 2 {
					second = append(second, receive()...)
				}
				gap = time.Duration(second[1].Timestamp-second[0].Timestamp) * time.Millisecond
				if gap < 2700*time.Millisecond || gap > 3500*time.Millisecond {
					t.Fatalf("batched sample gap = %s", gap)
				}
			} else {
				third := receive()[0]
				gap = time.Duration(third.Timestamp-second[0].Timestamp) * time.Millisecond
				if gap < 2700*time.Millisecond || gap > 3500*time.Millisecond {
					t.Fatalf("subsequent sample gap = %s, want approximately 3s", gap)
				}
			}
			t.Logf("first periodic sample gap: %s", time.Duration(second[0].Timestamp-first.Timestamp)*time.Millisecond)
		})
	}
}

func TestHTTPReportCadenceIncludesCollectionAndDelivery(t *testing.T) {
	oldURL, oldInterval := serverURL, reportInterval
	t.Cleanup(func() { serverURL, reportInterval = oldURL, oldInterval })
	reportInterval = 3
	reports := make(chan int64, 8)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/clients/policy" {
			_ = json.NewEncoder(w).Encode(agentPolicy{Type: "policy", Mode: "active", SampleIntervalSec: 3, ReportIntervalSec: 3, ReportNow: true})
			return
		}
		var report Report
		if err := json.NewDecoder(r.Body).Decode(&report); err != nil {
			t.Error(err)
			return
		}
		time.Sleep(300 * time.Millisecond)
		reports <- report.Timestamp
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer server.Close()
	serverURL = server.URL
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	preparer := &reportPreparer{lastBasicInfoAt: time.Now(), collect: func(interval int) Report {
		at := time.Now().UnixMilli()
		time.Sleep(time.Second)
		return Report{CPU: 42, Timestamp: at, ReportInterval: interval, Version: "fixture"}
	}}
	go func() { defer close(done); runHTTPReporterWithPreparer(ctx, preparer) }()
	defer func() {
		cancel()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Error("HTTP reporter did not stop")
		}
	}()
	var first int64
	for i := 0; i < 3; i++ {
		select {
		case at := <-reports:
			if i > 0 {
				gap := time.Duration(at-first) * time.Millisecond
				if gap < 2700*time.Millisecond || gap > 3500*time.Millisecond {
					t.Fatalf("HTTP sample gap = %s, want approximately 3s", gap)
				}
				t.Logf("HTTP sample gap: %s", gap)
			}
			first = at
		case <-time.After(6 * time.Second):
			t.Fatal("HTTP report missing")
		}
	}
}
