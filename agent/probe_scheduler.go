package main

import (
	"context"
	"hash/fnv"
	"strings"
	"time"
)

const maxConcurrentProbes = 4

// pingGridOffsetMs 是本机采样网格相对 Unix 纪元的固定偏移（毫秒）。
//
// 每个 Ping 任务的结果都按「间隔对齐的网格」打时间戳：同一台机器上，不管任务是安装时就有的、
// 还是后来才下发的，同一间隔的任务落在同一个时间点上，图表按时间戳合并后每条线才不会被别的任务的
// 采样行打断。偏移取自 token 的哈希：同一台机器稳定不变，不同机器彼此错开，
// 避免全部节点在整分整秒同时向 Worker 上报。
//
// 偏移对每个间隔分别取模（seed mod 间隔）。这样 60s 与 120s 等成整数倍的间隔，
// 其网格天然重合（seed mod 120000 再 mod 60000 恒等于 seed mod 60000）。
func pingGridOffsetMs(intervalMs int64) int64 {
	if intervalMs <= 0 {
		return 0
	}
	hash := fnv.New64a()
	_, _ = hash.Write([]byte(token))
	return int64(hash.Sum64() % uint64(intervalMs))
}

// pingSlotStart 返回 at 所在采样格的起点：不晚于 at 的、最近的网格时刻。
func pingSlotStart(at time.Time, interval time.Duration) time.Time {
	intervalMs := interval.Milliseconds()
	if intervalMs <= 0 {
		return at
	}
	offset := pingGridOffsetMs(intervalMs)
	shifted := at.UnixMilli() - offset
	floored := shifted - ((shifted%intervalMs)+intervalMs)%intervalMs
	return time.UnixMilli(floored + offset)
}

type probeRun struct{ cancel context.CancelFunc }

func (s *pingReportState) close() {
	if s == nil {
		return
	}
	s.cancel()
	<-s.probeDone
	s.probeWorkers.Wait()
}

func (s *pingReportState) signalProbeScheduler() {
	if s == nil {
		return
	}
	select {
	case s.probeWake <- struct{}{}:
	default:
	}
}

func (s *pingReportState) runProbeScheduler() {
	defer close(s.probeDone)
	timer := time.NewTimer(time.Hour)
	if !timer.Stop() {
		<-timer.C
	}
	defer timer.Stop()
	for {
		if s.ctx.Err() != nil {
			return
		}
		next := s.launchDueProbes(time.Now())
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		var tick <-chan time.Time
		if !next.IsZero() {
			delay := time.Until(next)
			if delay < time.Millisecond {
				delay = time.Millisecond
			}
			timer.Reset(delay)
			tick = timer.C
		}
		select {
		case <-s.ctx.Done():
			return
		case <-s.probeWake:
		case <-tick:
		}
	}
}

func (s *pingReportState) nextPingLocked() (PingTask, time.Time, bool) {
	var best PingTask
	var due time.Time
	found := false
	for _, task := range s.tasks {
		// 上一轮结果是否已被服务端确认与是否该探测无关；只避免同一任务的探测重叠。
		if task.ID <= 0 || s.runningPing[task.ID] != nil {
			continue
		}
		candidate := time.Time{}
		if last, ok := s.scheduler.lastRunByTaskID[task.ID]; ok {
			candidate = last.Add(pingTaskInterval(task))
		}
		if !found || candidate.Before(due) {
			best, due, found = task, candidate, true
		}
	}
	return best, due, found
}

func (s *pingReportState) launchDueProbes(now time.Time) time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	for s.activeProbes < maxConcurrentProbes && s.ctx.Err() == nil {
		ping, due, hasPing := s.nextPingLocked()
		if !hasPing {
			return time.Time{}
		}
		if due.After(now) {
			return due
		}
		ctx, cancel := context.WithCancel(s.ctx)
		run := &probeRun{cancel: cancel}
		s.activeProbes++
		s.probeWorkers.Add(1)
		s.runningPing[ping.ID] = run
		// 记录并上报的都是「所在采样格的起点」而不是实际启动时刻：
		// 实际启动会因任务加入的先后、并发排队、定时器延迟而各不相同，
		// 但同一格内的结果在图表上必须是同一个时间点。错过的格不补，直接落到当前格。
		slot := pingSlotStart(now, pingTaskInterval(ping))
		s.scheduler.lastRunByTaskID[ping.ID] = slot
		go s.runPingProbe(ctx, ping, run, slot)
	}
	return time.Time{}
}

// runPingProbe 执行一次探测。slot 是这次探测所属采样格的起点，用作结果的时间戳。
func (s *pingReportState) runPingProbe(ctx context.Context, task PingTask, run *probeRun, slot time.Time) {
	defer s.probeWorkers.Done()
	defer run.cancel()
	var value float64
	switch strings.ToLower(task.Type) {
	case "icmp":
		value = executeICMPPingWithContext(ctx, task.Target)
	case "http", "https":
		value = executeHTTPPingWithContext(ctx, task.Target)
	default:
		value = executeTCPPingWithContext(ctx, task.Target)
	}
	s.mu.Lock()
	if s.runningPing[task.ID] == run {
		delete(s.runningPing, task.ID)
		if ctx.Err() == nil {
			s.queuePingResultsLocked([]PingResult{{TaskID: task.ID, Value: value, Timestamp: slot.UnixMilli()}})
		}
	}
	s.activeProbes--
	s.mu.Unlock()
	s.signalProbeScheduler()
}
