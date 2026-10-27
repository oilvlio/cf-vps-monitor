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

func TestPingSlotStartFollowsPerAgentGrid(t *testing.T) {
	previous := token
	t.Cleanup(func() { token = previous })
	for _, agentToken := range []string{"", "agent-a", "agent-b"} {
		token = agentToken
		for _, interval := range []time.Duration{3 * time.Second, 60 * time.Second, 120 * time.Second, 300 * time.Second} {
			offset := pingGridOffsetMs(interval.Milliseconds())
			at := time.Date(2026, 10, 27, 10, 17, 43, 321_000_000, time.UTC)
			slot := pingSlotStart(at, interval)
			if slot.After(at) || at.Sub(slot) >= interval {
				t.Fatalf("token %q interval %s: slot %s does not contain %s", agentToken, interval, slot, at)
			}
			if slot.UnixMilli()%interval.Milliseconds() != offset {
				t.Fatalf("token %q interval %s: slot %d is off the grid (offset %d)", agentToken, interval, slot.UnixMilli(), offset)
			}
			if again := pingSlotStart(at.Add(-time.Millisecond), interval); again.After(slot) {
				t.Fatalf("slot moved backwards: %s -> %s", slot, again)
			}
			if next := pingSlotStart(slot.Add(interval), interval); !next.Equal(slot.Add(interval)) {
				t.Fatalf("a slot boundary must belong to the new slot: %s", next)
			}
		}
		// 成整数倍的间隔共用同一张网格：120s 的格点一定也是 60s 的格点。
		slot120 := pingSlotStart(time.Date(2026, 10, 27, 10, 17, 43, 0, time.UTC), 120*time.Second)
		if slot120.UnixMilli()%60000 != pingGridOffsetMs(60000) {
			t.Fatalf("token %q: 120s grid is not a subset of the 60s grid", agentToken)
		}
	}
	token = "agent-a"
	a := pingGridOffsetMs(60000)
	token = "agent-b"
	if b := pingGridOffsetMs(60000); a == b {
		t.Fatal("different agents should not share the same grid offset")
	}
}

func newAlignmentState(t *testing.T) *pingReportState {
	t.Helper()
	previousResolver, previousLog := resolvePublicIPsForPing, log.Writer()
	resolvePublicIPsForPing = func(context.Context, string) ([]net.IP, error) { return nil, errors.New("synthetic probe failure") }
	log.SetOutput(io.Discard)
	t.Cleanup(func() { resolvePublicIPsForPing = previousResolver; log.SetOutput(previousLog) })
	state := newPingReportState()
	t.Cleanup(state.close)
	return state
}

func waitForPendingResult(t *testing.T, state *pingReportState, taskID int) PingResult {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		state.mu.Lock()
		queue := state.pendingPing[taskID]
		var result PingResult
		if len(queue) > 0 {
			result = queue[0].result
		}
		state.mu.Unlock()
		if len(queue) > 0 {
			return result
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("task %d produced no result", taskID)
	return PingResult{}
}

// 先分配 a，稍后再下发 b：两者实际探测时刻不同，但结果必须落在同一个采样格上，
// 图表合并后才不会出现两个相邻的采样行。
func TestPingResultsOfLateAddedTaskShareTheSameSlot(t *testing.T) {
	state := newAlignmentState(t)
	const intervalSec = 3600 // 整点网格：两次下发之间几乎不可能跨格，测试不会因时刻而抖动
	task := func(id int) PingTask {
		return PingTask{ID: id, Type: "tcp", Target: "fixture.invalid:443", IntervalSec: intervalSec}
	}
	state.applyPolicy(agentPolicy{PingTasks: []PingTask{task(1)}})
	first := waitForPendingResult(t, state, 1)
	time.Sleep(250 * time.Millisecond)
	state.applyPolicy(agentPolicy{PingTasks: []PingTask{task(1), task(2)}})
	second := waitForPendingResult(t, state, 2)

	if first.Timestamp != second.Timestamp {
		t.Fatalf("late-added task sampled at %d, existing task at %d: different rows on the chart", second.Timestamp, first.Timestamp)
	}
	if first.Timestamp%(intervalSec*1000) != pingGridOffsetMs(intervalSec*1000) {
		t.Fatalf("timestamp %d is not on the agent grid", first.Timestamp)
	}

	// 下一次到期时刻就是下一个格点，不随实际启动时刻漂移。
	state.mu.Lock()
	defer state.mu.Unlock()
	if last := state.scheduler.lastRunByTaskID[2]; last.UnixMilli() != second.Timestamp {
		t.Fatalf("scheduler remembers %d, result stamped %d", last.UnixMilli(), second.Timestamp)
	}
	state.runningPing = map[int]*probeRun{}
	_, due, ok := state.nextPingLocked()
	if !ok || due.UnixMilli() != first.Timestamp+intervalSec*1000 {
		t.Fatalf("next due = %v, want one interval after the slot (%d)", due, first.Timestamp+intervalSec*1000)
	}
}
