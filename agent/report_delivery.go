package main

import (
	"log"
	"strings"
)

const maxPingResultsPerReport = 50
const maxReportsPerEnvelope = 300

type queuedPingResult struct {
	result   PingResult
	sequence uint64
	leased   bool
}

func samePingProbe(a, b PingTask) bool {
	return strings.EqualFold(a.Type, b.Type) && a.Target == b.Target
}

func (s *pingReportState) invalidateResultsForPolicyLocked(pings []PingTask) {
	pingByID := make(map[int]PingTask, len(pings))
	for _, task := range pings {
		pingByID[task.ID] = task
	}
	for _, old := range s.tasks {
		if next, ok := pingByID[old.ID]; !ok || !samePingProbe(old, next) {
			if running := s.runningPing[old.ID]; running != nil {
				running.cancel()
			}
			delete(s.pendingPing, old.ID)
			delete(s.scheduler.lastRunByTaskID, old.ID)
		}
	}
	s.pruneResultOrderLocked()
}

func (s *pingReportState) pruneResultOrderLocked() {
	pingOrder := s.pingOrder[:0]
	for _, id := range s.pingOrder {
		if _, ok := s.pendingPing[id]; ok {
			pingOrder = append(pingOrder, id)
		}
	}
	s.pingOrder = pingOrder
}

func (s *pingReportState) queuePingResultsLocked(results []PingResult) {
	for _, result := range results {
		if _, exists := s.pendingPing[result.TaskID]; exists {
			continue
		}
		s.nextResultID++
		s.pendingPing[result.TaskID] = &queuedPingResult{result: result, sequence: s.nextResultID}
		s.pingOrder = append(s.pingOrder, result.TaskID)
	}
}

func (s *pingReportState) appendPendingResultsLocked(report *Report) {
	for _, id := range s.pingOrder {
		if len(report.PingResults) >= maxPingResultsPerReport {
			break
		}
		result := s.pendingPing[id]
		if result == nil || result.leased {
			continue
		}
		result.leased = true
		if report.pingResultLeases == nil {
			report.pingResultLeases = make(map[int]uint64)
		}
		report.pingResultLeases[id] = result.sequence
		report.PingResults = append(report.PingResults, result.result)
	}
}

func (s *pingReportState) appendPendingReports(first Report) []Report {
	reports := []Report{first}
	if s == nil {
		return reports
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for {
		next := first
		next.PingResults = nil
		next.pingResultLeases = nil
		next.BasicInfo = nil
		next.basicInfoOwner, next.basicInfoRevision = nil, 0
		s.appendPendingResultsLocked(&next)
		if len(next.PingResults) == 0 {
			break
		}
		reports = append(reports, next)
	}
	return reports
}

func (s *pingReportState) currentReportResultsLocked(report Report) Report {
	report = currentReportBasicInfo(report)
	if len(report.pingResultLeases) > 0 {
		results := make([]PingResult, 0, len(report.PingResults))
		for _, result := range report.PingResults {
			if pending := s.pendingPing[result.TaskID]; pending != nil && pending.sequence == report.pingResultLeases[result.TaskID] {
				results = append(results, result)
			}
		}
		report.PingResults = results
	}
	return report
}

func (s *pingReportState) currentReportResults(reports []Report) []Report {
	if s == nil {
		return reports
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current := make([]Report, len(reports))
	for index, report := range reports {
		current[index] = s.currentReportResultsLocked(report)
	}
	return current
}

func (s *pingReportState) acknowledgeReports(reports []Report) {
	for _, report := range reports {
		if owner := report.basicInfoOwner; owner != nil && report.BasicInfo != nil {
			owner.basicInfoMu.Lock()
			if owner.basicInfoRevision == report.basicInfoRevision {
				owner.pendingBasicInfo = nil
			}
			owner.basicInfoMu.Unlock()
		}
	}
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, report := range reports {
		for id, sequence := range report.pingResultLeases {
			if pending := s.pendingPing[id]; pending != nil && pending.sequence == sequence {
				delete(s.pendingPing, id)
			}
		}
	}
	s.pruneResultOrderLocked()
	s.signalProbeScheduler()
}

func currentReportBasicInfo(report Report) Report {
	if owner := report.basicInfoOwner; owner != nil {
		owner.basicInfoMu.Lock()
		if owner.pendingBasicInfo == nil || owner.basicInfoRevision != report.basicInfoRevision {
			report.BasicInfo = nil
			report.basicInfoOwner, report.basicInfoRevision = nil, 0
		}
		owner.basicInfoMu.Unlock()
	}
	return report
}

func (s *pingReportState) retryReports(reports []Report) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, report := range reports {
		report = s.currentReportResultsLocked(report)
		if len(report.PingResults) > 0 {
			s.retryQueue = append(s.retryQueue, report)
		}
	}
}

func (s *pingReportState) takeRetryReports() []Report {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	var reports []Report
	for _, report := range s.retryQueue {
		report = s.currentReportResultsLocked(report)
		if len(report.PingResults) > 0 {
			reports = append(reports, report)
		}
	}
	s.retryQueue = nil
	return reports
}

func deliverHTTPReports(state *pingReportState, reports []Report) error {
	for len(reports) > 0 {
		count := min(len(reports), maxReportsPerEnvelope)
		batch := state.currentReportResults(reports[:count])
		if err := sendHTTPReports(batch); err != nil {
			log.Printf("HTTP report not accepted; probe results retained: %v", err)
			state.retryReports(reports)
			return err
		}
		state.acknowledgeReports(batch)
		reports = reports[count:]
	}
	return nil
}
