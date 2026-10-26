package main

import (
	"log"
	"strings"
)

const maxPingResultsPerReport = 50

// 单个任务最多积压多少条未确认结果。服务端长时间不可用时，超出的最旧结果会被丢弃，
// 避免内存无限增长，也避免恢复连接后一次性补发过多历史。
const maxBufferedPingResultsPerTask = 60
const maxReportsPerEnvelope = 300

// pingReportState.pendingPing 给每个任务保存一条先进先出的积压队列：探测不等服务端确认，
// 结果先存在队列里，随后续上报发出，收到确认后才移除。Report.pingResultSeqs 与
// Report.PingResults 一一对应，记录每条结果在队列里的序号，用于确认 / 重发时识别它。
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
		if len(s.pendingPing[id]) > 0 {
			pingOrder = append(pingOrder, id)
		}
	}
	s.pingOrder = pingOrder
}

func (s *pingReportState) queuePingResultsLocked(results []PingResult) {
	for _, result := range results {
		queue := s.pendingPing[result.TaskID]
		if len(queue) == 0 {
			s.pingOrder = append(s.pingOrder, result.TaskID)
		}
		s.nextResultID++
		queue = append(queue, &queuedPingResult{result: result, sequence: s.nextResultID})
		if len(queue) > maxBufferedPingResultsPerTask {
			log.Printf("ping task %d: %d results are waiting for delivery; dropping the oldest", result.TaskID, len(queue))
			queue = append(queue[:0], queue[len(queue)-maxBufferedPingResultsPerTask:]...)
		}
		s.pendingPing[result.TaskID] = queue
	}
}

// appendPendingResultsLocked 给 report 附上每个任务最旧的一条尚未发出的结果。
// 一份 report 对同一任务最多带一条，积压的更多结果由 appendPendingReports 分成后续几份发出，
// 这样接收端每份 report 恰好对应一轮探测。
func (s *pingReportState) appendPendingResultsLocked(report *Report) {
	for _, id := range s.pingOrder {
		if len(report.PingResults) >= maxPingResultsPerReport {
			break
		}
		for _, queued := range s.pendingPing[id] {
			if queued.leased {
				continue
			}
			queued.leased = true
			report.PingResults = append(report.PingResults, queued.result)
			report.pingResultSeqs = append(report.pingResultSeqs, queued.sequence)
			break
		}
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
		next.pingResultSeqs = nil
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

func (s *pingReportState) hasPendingResultLocked(taskID int, sequence uint64) bool {
	for _, queued := range s.pendingPing[taskID] {
		if queued.sequence == sequence {
			return true
		}
	}
	return false
}

func (s *pingReportState) currentReportResultsLocked(report Report) Report {
	report = currentReportBasicInfo(report)
	if len(report.pingResultSeqs) > 0 {
		results := make([]PingResult, 0, len(report.PingResults))
		seqs := make([]uint64, 0, len(report.pingResultSeqs))
		for index, result := range report.PingResults {
			if index < len(report.pingResultSeqs) && s.hasPendingResultLocked(result.TaskID, report.pingResultSeqs[index]) {
				results = append(results, result)
				seqs = append(seqs, report.pingResultSeqs[index])
			}
		}
		report.PingResults, report.pingResultSeqs = results, seqs
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
		for index, sequence := range report.pingResultSeqs {
			if index >= len(report.PingResults) {
				break
			}
			id := report.PingResults[index].TaskID
			queue := s.pendingPing[id]
			for position, queued := range queue {
				if queued.sequence == sequence {
					queue = append(queue[:position], queue[position+1:]...)
					break
				}
			}
			if len(queue) == 0 {
				delete(s.pendingPing, id)
			} else {
				s.pendingPing[id] = queue
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
