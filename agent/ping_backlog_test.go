package main

import (
	"context"
	"errors"
	"io"
	"log"
	"net"
	"testing"
	"time"
)

func backlogState(t *testing.T) *pingReportState {
	t.Helper()
	state := newPingReportState()
	t.Cleanup(state.close)
	return state
}

func queueResults(state *pingReportState, taskID int, stamps ...int64) {
	state.mu.Lock()
	defer state.mu.Unlock()
	for _, stamp := range stamps {
		state.queuePingResultsLocked([]PingResult{{TaskID: taskID, Value: float64(stamp), Timestamp: stamp}})
	}
}

func TestPingBacklogKeepsEveryProbeUntilAcknowledged(t *testing.T) {
	state := backlogState(t)
	queueResults(state, 1, 1000, 2000, 3000)
	queueResults(state, 2, 1000, 2000)

	first := Report{Timestamp: 5000}
	state.appendDueResults(&first, time.Now())
	reports := state.appendPendingReports(first)
	if len(reports) != 3 {
		t.Fatalf("expected one report per probe round, got %d", len(reports))
	}
	wantRounds := [][]int64{{1000, 1000}, {2000, 2000}, {3000}}
	for index, report := range reports {
		if len(report.PingResults) != len(wantRounds[index]) {
			t.Fatalf("round %d has %d results, want %d", index, len(report.PingResults), len(wantRounds[index]))
		}
		seen := map[int]bool{}
		for position, result := range report.PingResults {
			if seen[result.TaskID] {
				t.Fatalf("round %d repeats task %d", index, result.TaskID)
			}
			seen[result.TaskID] = true
			if result.Timestamp != wantRounds[index][position] {
				t.Fatalf("round %d result %d has timestamp %d", index, position, result.Timestamp)
			}
		}
	}

	// 只确认前两轮：第三轮仍然保留，等待下一次确认。
	state.acknowledgeReports(state.currentReportResults(reports[:2]))
	state.mu.Lock()
	remaining := len(state.pendingPing[1]) + len(state.pendingPing[2])
	state.mu.Unlock()
	if remaining != 1 {
		t.Fatalf("%d results remain after acknowledging two rounds, want 1", remaining)
	}
	state.acknowledgeReports(state.currentReportResults(reports[2:]))
	state.mu.Lock()
	left, order := len(state.pendingPing), len(state.pingOrder)
	state.mu.Unlock()
	if left != 0 || order != 0 {
		t.Fatalf("acknowledged results were not released: %d tasks, %d ordered", left, order)
	}
}

func TestPingBacklogRetriesUnacknowledgedRoundsInOrder(t *testing.T) {
	state := backlogState(t)
	queueResults(state, 1, 1000, 2000)
	first := Report{Timestamp: 5000}
	state.appendDueResults(&first, time.Now())
	reports := state.appendPendingReports(first)
	state.retryReports(reports)

	// 重发的报告先于新积压的结果，且内容不变。
	queueResults(state, 1, 3000)
	retry := state.takeRetryReports()
	if len(retry) != 2 || retry[0].PingResults[0].Timestamp != 1000 || retry[1].PingResults[0].Timestamp != 2000 {
		t.Fatalf("unexpected retry batch: %#v", retry)
	}
	next := Report{Timestamp: 6000}
	state.appendDueResults(&next, time.Now())
	if len(next.PingResults) != 1 || next.PingResults[0].Timestamp != 3000 {
		t.Fatalf("new report must carry only the not-yet-sent result: %#v", next.PingResults)
	}
}

func TestPingBacklogDropsOldestWhenFull(t *testing.T) {
	previousLog := log.Writer()
	log.SetOutput(io.Discard)
	t.Cleanup(func() { log.SetOutput(previousLog) })
	state := backlogState(t)
	for stamp := int64(1); stamp <= maxBufferedPingResultsPerTask+5; stamp++ {
		queueResults(state, 1, stamp)
	}
	state.mu.Lock()
	queue := state.pendingPing[1]
	state.mu.Unlock()
	if len(queue) != maxBufferedPingResultsPerTask {
		t.Fatalf("backlog holds %d results, want %d", len(queue), maxBufferedPingResultsPerTask)
	}
	if queue[0].result.Timestamp != 6 || queue[len(queue)-1].result.Timestamp != maxBufferedPingResultsPerTask+5 {
		t.Fatalf("wrong results kept: first=%d last=%d", queue[0].result.Timestamp, queue[len(queue)-1].result.Timestamp)
	}
}

func TestPingProbeContinuesWhileResultsAreUnacknowledged(t *testing.T) {
	previousResolver, previousLog := resolvePublicIPsForPing, log.Writer()
	resolvePublicIPsForPing = func(context.Context, string) ([]net.IP, error) { return nil, errors.New("synthetic probe failure") }
	log.SetOutput(io.Discard)
	t.Cleanup(func() { resolvePublicIPsForPing = previousResolver; log.SetOutput(previousLog) })
	state := backlogState(t)
	state.applyPolicy(agentPolicy{PingTasks: []PingTask{{ID: 1, Type: "tcp", Target: "fixture.invalid:443", IntervalSec: 1}}, PingIntervalSec: 1})

	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		state.mu.Lock()
		count := len(state.pendingPing[1])
		state.mu.Unlock()
		if count >= 3 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	state.mu.Lock()
	queue := append([]*queuedPingResult(nil), state.pendingPing[1]...)
	state.mu.Unlock()
	if len(queue) < 3 {
		t.Fatalf("only %d results were probed without any acknowledgement", len(queue))
	}
	for index := 1; index < len(queue); index++ {
		gap := queue[index].result.Timestamp - queue[index-1].result.Timestamp
		if gap < 950 || gap > 1500 {
			t.Fatalf("probe spacing %dms does not follow the 1s interval", gap)
		}
	}
}
