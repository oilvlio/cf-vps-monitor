package main

import (
	"context"
	"strings"
	"time"
)

const maxConcurrentProbes = 4

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
		if task.ID <= 0 || s.pendingPing[task.ID] != nil || s.runningPing[task.ID] != nil {
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
		s.scheduler.lastRunByTaskID[ping.ID] = now
		go s.runPingProbe(ctx, ping, run)
	}
	return time.Time{}
}

func (s *pingReportState) runPingProbe(ctx context.Context, task PingTask, run *probeRun) {
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
			s.queuePingResultsLocked([]PingResult{{TaskID: task.ID, Value: value}})
		}
	}
	s.activeProbes--
	s.mu.Unlock()
	s.signalProbeScheduler()
}
