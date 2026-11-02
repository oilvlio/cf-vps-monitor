import assert from 'node:assert/strict';
import test from 'node:test';

const {
  collectTrafficSamples,
  estimateTrafficDelta,
  isValidDateKey,
  localDateKey,
  nextTrafficBase,
  parseTrafficImport,
  parseTrafficSample,
  selectDueSamples,
  trafficPeriodStart,
  TRAFFIC_APPLY_MIN_GAP_MS,
} = await import('./traffic-samples.ts');

test('period start follows the reset day, including month-end clamping', () => {
  const cases = [
    [1, '2026-10-31', '2026-10-01'],
    [1, '2026-10-01', '2026-10-01'],
    [15, '2026-10-14', '2026-09-15'], // 还没到本月重置日：周期从上月 15 号开始
    [15, '2026-10-15', '2026-10-15'],
    [15, '2026-01-10', '2025-12-15'], // 跨年
    // 重置日大于当月天数：顺延到下月 1 日（与旧版 Agent 一致）
    [31, '2026-11-05', '2026-10-31'],
    [31, '2026-11-30', '2026-10-31'],
    [31, '2026-12-01', '2026-12-01'],
    [31, '2026-12-31', '2026-12-31'],
    [30, '2026-02-27', '2026-01-30'],
    [30, '2026-03-01', '2026-03-01'],
    [29, '2028-02-29', '2028-02-29'], // 闰年有 2 月 29 日
    [29, '2027-03-05', '2027-03-01'], // 平年顺延
    // 旧 Go 测试覆盖过的几组
    [31, '2026-03-31', '2026-03-31'],
    [31, '2026-03-30', '2026-03-01'],
    [31, '2026-02-28', '2026-01-31'],
    [15, '2026-06-14', '2026-05-15'],
  ];
  for (const [resetDay, today, expected] of cases) {
    assert.equal(trafficPeriodStart(resetDay, today), expected, `resetDay=${resetDay} today=${today}`);
  }
  assert.equal(trafficPeriodStart(0, '2026-10-20'), '2026-10-01');
  assert.equal(trafficPeriodStart(99, '2026-10-20'), trafficPeriodStart(31, '2026-10-20'));
});

test('date keys are validated by round trip; local date = UTC time + the agent\'s offset', () => {
  assert.equal(isValidDateKey('2026-10-31'), true);
  for (const bad of ['2026-02-31', '2026-13-01', '2026-1-1', 'abc', '', 20261031, null, undefined, '2026-10-31T00:00:00Z']) {
    assert.equal(isValidDateKey(bad), false, String(bad));
  }
  const utc2330 = Date.UTC(2026, 9, 31, 23, 30);
  assert.equal(localDateKey(utc2330, 0), '2026-10-31');
  assert.equal(localDateKey(utc2330, 8 * 3600), '2026-11-01');
  assert.equal(localDateKey(utc2330, -5 * 3600), '2026-10-31');
  assert.equal(localDateKey(Date.UTC(2026, 10, 1, 2, 0), -5 * 3600), '2026-10-31');
});

const wire = (overrides = {}) => ({
  boot: 1780000000,
  scope: 'abc123',
  utc_offset: 28800,
  interfaces: { eth0: { up: 1000, down: 2000 }, eth1: { up: 5, down: 6 } },
  ...overrides,
});

test('a traffic sample is validated, clamped and normalised', () => {
  const ts = 1_800_000_000_000;
  assert.deepEqual(parseTrafficSample(wire(), ts), {
    ts, boot: 1780000000, scope: 'abc123', utc_offset: 28800,
    interfaces: { eth0: { up: 1000, down: 2000 }, eth1: { up: 5, down: 6 } },
  });
  // 偏移夹到 UTC-12..UTC+14；小数向下取整；超大值夹到上限；坏网卡被丢弃但不影响其他网卡。
  const clamped = parseTrafficSample(wire({
    utc_offset: 999999,
    boot: 12.9,
    interfaces: { eth0: { up: 5.9, down: 1e30 }, bad: { up: -1, down: 0 }, worse: { up: 'x', down: 1 }, '': { up: 1, down: 1 }, text: 'no' },
  }), ts);
  assert.equal(clamped.utc_offset, 14 * 3600);
  assert.equal(clamped.boot, 12);
  assert.deepEqual(clamped.interfaces, { eth0: { up: 5, down: 1_000_000_000_000_000 } });
  assert.equal(parseTrafficSample(wire({ utc_offset: -999999 }), ts).utc_offset, -12 * 3600);
  assert.equal(parseTrafficSample(wire({ boot: undefined }), ts).boot, 0);
  assert.equal(parseTrafficSample(wire({ utc_offset: 'x' }), ts).utc_offset, 0);
});

test('unusable samples are rejected instead of being guessed at', () => {
  const ts = 1_800_000_000_000;
  for (const bad of [null, undefined, 'x', [], {}, wire({ scope: '' }), wire({ scope: 5 }), wire({ scope: 'x'.repeat(65) }),
    wire({ interfaces: {} }), wire({ interfaces: 'eth0' }), wire({ interfaces: { eth0: { up: -1, down: 1 } } })]) {
    assert.equal(parseTrafficSample(bad, ts), null, JSON.stringify(bad));
  }
  for (const badTs of [0, -1, NaN, Infinity]) assert.equal(parseTrafficSample(wire(), badTs), null);
  const many = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`nic${index}`, { up: 1, down: 1 }]));
  assert.equal(Object.keys(parseTrafficSample(wire({ interfaces: many }), ts).interfaces).length, 64);
});

test('collectTrafficSamples keeps order, dedupes by time and skips reports without a sample', () => {
  const stamp = report => report.timestamp;
  const samples = collectTrafficSamples([
    { timestamp: 3000, traffic_sample: wire({ interfaces: { eth0: { up: 3, down: 3 } } }) },
    { timestamp: 1000, cpu: 5 },
    { timestamp: 1000, traffic_sample: wire({ interfaces: { eth0: { up: 1, down: 1 } } }) },
    { timestamp: 2000, traffic_sample: 'garbage' },
    { timestamp: 1000, traffic_sample: wire({ interfaces: { eth0: { up: 9, down: 9 } } }) },
  ], stamp);
  assert.deepEqual(samples.map(sample => [sample.ts, sample.interfaces.eth0.up]), [[1000, 9], [3000, 3]]);
});

test('selectDueSamples thins samples to about one per two minutes without losing the latest baseline order', () => {
  const at = (seconds) => ({ ts: seconds * 1000, boot: 0, scope: 's', utc_offset: 0, interfaces: { eth0: { up: seconds, down: 0 } } });
  const gap = TRAFFIC_APPLY_MIN_GAP_MS;
  // 有人在看：每 3 秒一个样本。DO 刚启动 → 第一个立刻入选，之后每 ≥100 秒一个。
  const realtime = Array.from({ length: 100 }, (_, index) => at(index * 3));
  assert.deepEqual(selectDueSamples(realtime, undefined, gap).map(s => s.ts / 1000), [0, 102, 204]);
  // 已处理过的样本不再入选；没到间隔的也不选。
  assert.deepEqual(selectDueSamples(realtime, 150_000, gap).map(s => s.ts / 1000), [252]);
  assert.deepEqual(selectDueSamples([at(10), at(20)], 5_000, gap), []);
  // 空闲：每 120 秒一个样本（带一点抖动），每个都应入选，不能被稀疏化成 240 秒一次。
  const idle = [at(0), at(119), at(240), at(359)];
  assert.equal(selectDueSamples(idle, undefined, gap).length, 4);
  assert.deepEqual(selectDueSamples([], undefined, gap), []);
});

test('a legacy import is parsed strictly: bad days are dropped, an unusable baseline is ignored', () => {
  assert.equal(parseTrafficImport([{ cpu: 1 }]), null);
  assert.equal(parseTrafficImport([{ traffic_import: 'x' }]), null);
  assert.equal(parseTrafficImport([{ traffic_import: { days: [{ date: 'bad', up: 1, down: 1 }] } }]), null);

  const parsed = parseTrafficImport([
    { cpu: 1 },
    { traffic_import: {
      days: [
        { date: '2026-10-30', up: 100, down: 200 },
        { date: '2026-02-31', up: 1, down: 1 },
        { date: '2026-10-29', up: -5, down: 1 },
        { date: '2026-10-28', up: 7.9, down: 1e30 },
        'x',
      ],
      baseline: { scope: 'abc', boot: 1780000000, interfaces: { eth0: { up: 1100, down: 2300 } } },
    } },
    { traffic_import: { days: [{ date: '2026-10-01', up: 999, down: 999 }] } },
  ]);
  assert.deepEqual(parsed.days, [
    { date: '2026-10-30', up: 100, down: 200 },
    { date: '2026-10-28', up: 7, down: 1_000_000_000_000_000 },
  ]);
  assert.deepEqual(parsed.baseline, { scope: 'abc', boot: 1780000000, interfaces: { eth0: { up: 1100, down: 2300 } } });

  const noBaseline = parseTrafficImport([{ traffic_import: { days: [{ date: '2026-10-30', up: 1, down: 1 }], baseline: { scope: '', interfaces: {} } } }]);
  assert.equal(noBaseline.baseline, null);
  const baselineOnly = parseTrafficImport([{ traffic_import: { baseline: { scope: 'abc', interfaces: { eth0: { up: 1, down: 1 } } } } }]);
  assert.deepEqual(baselineOnly.days, []);
  assert.equal(baselineOnly.baseline.boot, 0);
});

const mk = (ts, up, down, extra = {}) => ({ ts, boot: 1780000000, scope: 's', utc_offset: 0, interfaces: { eth0: { up, down } }, ...extra });

test('estimateTrafficDelta mirrors the SQL rules: diff, wrap, reboot, new nic, scope change', () => {
  const base = mk(1000, 500, 800, { interfaces: { eth0: { up: 500, down: 800 }, eth1: { up: 10, down: 10 } } });
  // 普通差值；eth1 消失被忽略
  assert.deepEqual(estimateTrafficDelta(base, mk(2000, 560, 900)), { up: 60, down: 100 });
  // 计数器变小：视为回绕 / 清零，取当前读数
  assert.deepEqual(estimateTrafficDelta(base, mk(2000, 30, 900)), { up: 30, down: 100 });
  // 重启（boot 相差 > 60 秒）：整体都是增量
  assert.deepEqual(estimateTrafficDelta(base, mk(2000, 40, 50, { boot: 1780000500 })), { up: 40, down: 50 });
  // boot 只差几秒：不算重启
  assert.deepEqual(estimateTrafficDelta(base, mk(2000, 560, 900, { boot: 1780000005 })), { up: 60, down: 100 });
  // 新出现的网卡只起基线
  assert.deepEqual(estimateTrafficDelta(base, mk(2000, 560, 900, { interfaces: { eth0: { up: 560, down: 900 }, eth9: { up: 999, down: 999 } } })), { up: 60, down: 100 });
  // scope 变化 / 没有基线 / 样本不比基线新：0
  assert.deepEqual(estimateTrafficDelta(base, mk(2000, 560, 900, { scope: 'other' })), { up: 0, down: 0 });
  assert.deepEqual(estimateTrafficDelta(undefined, mk(2000, 560, 900)), { up: 0, down: 0 });
  assert.deepEqual(estimateTrafficDelta(base, mk(1000, 560, 900)), { up: 0, down: 0 });
});

test('nextTrafficBase keeps the last valid boot when the applied sample has none (same as the SQL state)', () => {
  const previous = mk(1000, 1, 1);
  assert.equal(nextTrafficBase(previous, mk(2000, 2, 2, { boot: 0 })).boot, 1780000000);
  assert.equal(nextTrafficBase(previous, mk(2000, 2, 2, { boot: 1780000999 })).boot, 1780000999);
  assert.equal(nextTrafficBase(undefined, mk(2000, 2, 2, { boot: 0 })).boot, 0);
});
