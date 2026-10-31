import assert from 'node:assert/strict';
import test from 'node:test';

import { createTestDatabase, rpc } from '../../../../scripts/test-support/postgres.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// 5 天前的 UTC 零点：所有样本都落在「过去」且在 400 天保留窗口内，不依赖运行日期。
const BASE = Math.floor((Date.now() - 5 * DAY) / DAY) * DAY;
const dayKey = (ms, offsetSeconds = 0) => new Date(ms + offsetSeconds * 1000).toISOString().slice(0, 10);
const RANGE = { input_from: dayKey(BASE - 30 * DAY), input_to: dayKey(BASE + 30 * DAY) };

function sample(ts, interfaces, { boot = 1_780_000_000, scope = 'scope-a', offset = 0 } = {}) {
  return {
    ts,
    boot,
    scope,
    utc_offset: offset,
    interfaces: Object.fromEntries(Object.entries(interfaces).map(([name, [up, down]]) => [name, { up, down }])),
  };
}

async function setup() {
  const database = await createTestDatabase();
  await database.exec(`insert into clients (uuid, name) values ('c1', 'node-1'), ('c2', 'node-2');`);
  return database;
}

const apply = (database, samples, range = RANGE, client = 'c1') =>
  rpc(database, 'cfm_traffic_apply_samples', { input_client: client, input_samples: samples, ...range });

async function days(database, client = 'c1') {
  const result = await database.query(
    `select to_char(day, 'YYYY-MM-DD') as day, up::text as up, down::text as down from traffic_daily where client = $1 order by day`,
    [client],
  );
  return result.rows.map((row) => ({ day: row.day, up: Number(row.up), down: Number(row.down) }));
}

test('the first sample only establishes a baseline; later samples are counted on their local day', async () => {
  const database = await setup();
  try {
    let totals = await apply(database, [sample(BASE + 1 * HOUR, { eth0: [1000, 2000] })]);
    assert.deepEqual([totals.up, totals.down, totals.applied], [0, 0, 1], 'nothing is counted until there is something to compare with');
    assert.deepEqual(await days(database), []);

    totals = await apply(database, [sample(BASE + 2 * HOUR, { eth0: [1500, 2600] })]);
    assert.deepEqual([totals.up, totals.down], [500, 600]);
    totals = await apply(database, [sample(BASE + 3 * HOUR, { eth0: [1700, 2700] })]);
    assert.deepEqual([totals.up, totals.down], [700, 700]);
    assert.deepEqual(await days(database), [{ day: dayKey(BASE), up: 700, down: 700 }]);
  } finally {
    await database.close();
  }
});

test('increments are attributed to the agent\'s local date, using each sample\'s own UTC offset', async () => {
  const database = await setup();
  try {
    const plus8 = 8 * 3600;
    // 23:30 UTC 在 UTC+8 已经是第二天 07:30。
    await apply(database, [sample(BASE + 20 * HOUR, { eth0: [0, 0] }, { offset: plus8 })]); // 本地 04:00（当天）
    await apply(database, [sample(BASE + 23.5 * HOUR, { eth0: [100, 10] }, { offset: plus8 })]); // 本地次日 07:30
    await apply(database, [sample(BASE + 26 * HOUR, { eth0: [150, 20] }, { offset: plus8 })]); // 次日 10:00
    assert.deepEqual(await days(database), [{ day: dayKey(BASE + DAY), up: 150, down: 20 }], 'all of it lands on the local next day, not UTC day 1');

    // 夏令时 / 时区变化：下一个样本用新的偏移，各自按自己的偏移分日。
    await apply(database, [sample(BASE + 27 * HOUR, { eth0: [160, 25] }, { offset: -5 * 3600 })]); // 本地前一天 22:00
    const rows = await days(database);
    assert.deepEqual(rows.map((row) => row.day), [dayKey(BASE), dayKey(BASE + DAY)]);
    assert.deepEqual(rows[0], { day: dayKey(BASE), up: 10, down: 5 });
  } finally {
    await database.close();
  }
});

test('the period total follows the requested range and never rewrites history', async () => {
  const database = await setup();
  try {
    await apply(database, [sample(BASE, { eth0: [0, 0] })]);
    await apply(database, [sample(BASE + 12 * HOUR, { eth0: [100, 1000] })]);
    await apply(database, [sample(BASE + 1 * DAY + 12 * HOUR, { eth0: [300, 3000] })]);
    const lastSample = sample(BASE + 2 * DAY + 12 * HOUR, { eth0: [600, 6000] });
    await apply(database, [lastSample]);
    // 空样本：只返回合计，换区间就是换求和范围，不改数据。
    const d0 = dayKey(BASE);
    const d1 = dayKey(BASE + DAY);
    const d2 = dayKey(BASE + 2 * DAY);
    const sum = async (from, to) => apply(database, [], { input_from: from, input_to: to });
    assert.deepEqual([(await sum(d0, d2)).up, (await sum(d0, d2)).down], [600, 6000]);
    assert.deepEqual([(await sum(d1, d2)).up, (await sum(d1, d2)).down], [500, 5000], '重置日改到 d1：d0 的 100/1000 不再计入');
    assert.deepEqual([(await sum(d0, d2)).up, (await sum(d0, d2)).down], [600, 6000], '改回去，历史原样还在');
    assert.deepEqual([(await sum(d2, d2)).up], [300]);
    assert.deepEqual([(await sum(d2, d0)).up, (await sum(d2, d0)).down], [0, 0], '反向区间为空');
    assert.deepEqual((await days(database)).length, 3);
  } finally {
    await database.close();
  }
});

test('counter wrap-around is handled per direction and never repeats history', async () => {
  const database = await setup();
  try {
    await apply(database, [sample(BASE + 1 * HOUR, { eth0: [100, 12_000] })]);
    // 同一次开机里下行计数器变小：视为清零 / 回绕，取当前读数（800）；上行正常 +600。
    const totals = await apply(database, [sample(BASE + 2 * HOUR, { eth0: [700, 800] })]);
    assert.deepEqual([totals.up, totals.down], [600, 800]);
  } finally {
    await database.close();
  }
});

test('interfaces appearing and disappearing do not inflate the total', async () => {
  const database = await setup();
  try {
    const steps = [
      [{ eth0: [1000, 2000], eth1: [2000, 4000] }, 0, 0], // 起基线
      [{ eth0: [1100, 2200] }, 100, 200], // eth1 消失：忽略
      [{ eth0: [1200, 2400], eth1: [3000, 6000] }, 200, 400], // eth1 重新出现：先起基线，不计增量
      [{ eth0: [1300, 2600], eth1: [3010, 6020] }, 310, 620],
      [{ eth0: [20, 2700], eth1: [3020, 6030] }, 340, 730], // eth0 上行回绕：取 20；下行 +100
    ];
    for (const [index, [interfaces, up, down]] of steps.entries()) {
      const totals = await apply(database, [sample(BASE + (index + 1) * HOUR, interfaces)]);
      assert.deepEqual([totals.up, totals.down], [up, down], `step ${index}`);
    }
  } finally {
    await database.close();
  }
});

test('a reboot (changed boot time) counts the new counters in full, even if one direction looks normal', async () => {
  const database = await setup();
  try {
    await apply(database, [sample(BASE + 1 * HOUR, { eth0: [100, 12_000] })]);
    // 重启后：上行读数 700 > 100（看起来是正常增长），但开机时间变了，所以整体按新计数器计入。
    let totals = await apply(database, [sample(BASE + 2 * HOUR, { eth0: [700, 800] }, { boot: 1_780_100_000 })]);
    assert.deepEqual([totals.up, totals.down], [700, 800]);
    totals = await apply(database, [sample(BASE + 3 * HOUR, { eth0: [710, 820] }, { boot: 1_780_100_000 })]);
    assert.deepEqual([totals.up, totals.down], [710, 820], '同一次开机之后只计差值');
  } finally {
    await database.close();
  }
});

test('boot time jitter of a few seconds is not mistaken for a reboot', async () => {
  const database = await setup();
  try {
    await apply(database, [sample(BASE + 1 * HOUR, { eth0: [1000, 2000] }, { boot: 1_780_000_000 })]);
    const totals = await apply(database, [sample(BASE + 2 * HOUR, { eth0: [1100, 2100] }, { boot: 1_780_000_003 })]);
    assert.deepEqual([totals.up, totals.down], [100, 100], 'not 1100/2100');
  } finally {
    await database.close();
  }
});

test('changing the counter scope re-baselines instead of inflating, and keeps recorded days', async () => {
  const database = await setup();
  try {
    await apply(database, [sample(BASE + 1 * HOUR, { eth0: [1000, 1000] })]);
    await apply(database, [sample(BASE + 2 * HOUR, { eth0: [1500, 1500] })]);
    // 口径变化：新口径把隧道网卡也算进来，读数骤增；不能被当成计数器回绕再加一遍。
    let totals = await apply(database, [sample(BASE + 3 * HOUR, { eth0: [1600, 1600], wg0: [9_000_000, 9_000_000] }, { scope: 'scope-b' })]);
    assert.deepEqual([totals.up, totals.down], [500, 500], 'the re-baseline round adds nothing');
    totals = await apply(database, [sample(BASE + 4 * HOUR, { eth0: [1700, 1700], wg0: [9_000_100, 9_000_100] }, { scope: 'scope-b' })]);
    assert.deepEqual([totals.up, totals.down], [700, 700]);
  } finally {
    await database.close();
  }
});

test('re-sent and out-of-order samples are ignored (idempotent)', async () => {
  const database = await setup();
  try {
    const first = sample(BASE + 1 * HOUR, { eth0: [1000, 1000] });
    const second = sample(BASE + 2 * HOUR, { eth0: [1400, 1400] });
    const third = sample(BASE + 3 * HOUR, { eth0: [1500, 1500] });
    await apply(database, [first, second]);
    let totals = await apply(database, [first, second]); // 整批重发（比如上一次响应丢了）
    assert.deepEqual([totals.up, totals.applied], [400, 0]);
    totals = await apply(database, [second, third]); // 与已处理部分重叠：只有 third 生效
    assert.deepEqual([totals.up, totals.applied], [500, 1]);
    totals = await apply(database, [sample(BASE + 90 * 60_000, { eth0: [1450, 1450] })]); // 迟到的旧样本
    assert.deepEqual([totals.up, totals.applied], [500, 0]);
  } finally {
    await database.close();
  }
});

test('a batch is processed in order, so samples straddling midnight are split between the two days', async () => {
  const database = await setup();
  try {
    await apply(database, [sample(BASE + 22 * HOUR, { eth0: [0, 0] })]);
    await apply(database, [
      sample(BASE + 23 * HOUR, { eth0: [100, 0] }),
      sample(BASE + 25 * HOUR, { eth0: [250, 0] }),
      sample(BASE + 26 * HOUR, { eth0: [300, 0] }),
    ]);
    assert.deepEqual(await days(database), [
      { day: dayKey(BASE), up: 100, down: 0 },
      { day: dayKey(BASE + DAY), up: 200, down: 0 },
    ]);
  } finally {
    await database.close();
  }
});

test('bad timestamps cannot poison the baseline, and malformed samples are skipped', async () => {
  const database = await setup();
  try {
    await apply(database, [sample(BASE + 1 * HOUR, { eth0: [1000, 1000] })]);
    const farFuture = sample(Date.now() + 30 * DAY, { eth0: [9_999_999, 9_999_999] });
    const garbage = [
      farFuture,
      sample(-5, { eth0: [1, 1] }),
      sample(0, { eth0: [1, 1] }),
      { ts: BASE + 2 * HOUR, scope: 'scope-a', interfaces: 'nope' },
      { ts: 'x', scope: 'scope-a', interfaces: {} },
      'nonsense',
      null,
      { ...sample(BASE + 2 * HOUR, { eth0: [1200, 1200] }), interfaces: { eth0: { up: 'x', down: 1 }, eth1: 5 } },
    ];
    let totals = await apply(database, garbage);
    assert.equal(totals.applied, 1, 'only the structurally valid sample is applied; its unreadable interfaces are skipped');
    assert.deepEqual([totals.up, totals.down], [0, 0]);
    // 未来时间戳没有把 last_ts 顶上去：正常样本仍然被接受。
    totals = await apply(database, [sample(BASE + 3 * HOUR, { eth0: [1300, 1300] })]);
    assert.equal(totals.applied, 1);
  } finally {
    await database.close();
  }
});

test('an empty call only reads: it never creates state', async () => {
  const database = await setup();
  try {
    const totals = await apply(database, []);
    assert.deepEqual([totals.up, totals.down, totals.applied], [0, 0, 0]);
    assert.deepEqual(await apply(database, null), { up: 0, down: 0, applied: 0 });
    const state = await database.query(`select count(*)::int as n from traffic_counter_state`);
    assert.equal(state.rows[0].n, 0);
  } finally {
    await database.close();
  }
});

test('nodes are isolated, an unknown node is rejected, deleting a node removes its traffic', async () => {
  const database = await setup();
  try {
    await apply(database, [sample(BASE + 1 * HOUR, { eth0: [0, 0] })], RANGE, 'c1');
    await apply(database, [sample(BASE + 2 * HOUR, { eth0: [500, 0] })], RANGE, 'c1');
    await apply(database, [sample(BASE + 1 * HOUR, { eth0: [0, 0] })], RANGE, 'c2');
    await apply(database, [sample(BASE + 2 * HOUR, { eth0: [7, 0] })], RANGE, 'c2');
    assert.equal((await days(database, 'c1'))[0].up, 500);
    assert.equal((await days(database, 'c2'))[0].up, 7);
    await assert.rejects(() => apply(database, [sample(BASE + HOUR, { eth0: [1, 1] })], RANGE, 'ghost'), /violates foreign key/);
    await database.exec(`delete from clients where uuid = 'c1'`);
    assert.deepEqual(await days(database, 'c1'), []);
    assert.equal((await database.query(`select count(*)::int as n from traffic_counter_state where client = 'c1'`)).rows[0].n, 0);
    assert.equal((await days(database, 'c2'))[0].up, 7);
  } finally {
    await database.close();
  }
});

test('days beyond the retention window are pruned on the next apply', async () => {
  const database = await setup();
  try {
    await database.exec(`insert into traffic_daily (client, day, up, down) values ('c1', current_date - 450, 9, 9), ('c1', current_date - 100, 5, 5)`);
    await apply(database, [sample(BASE + HOUR, { eth0: [1, 1] })]);
    const rows = await database.query(`select (current_date - day)::int as age from traffic_daily where client = 'c1' order by day`);
    assert.deepEqual(rows.rows.map((row) => row.age), [100]);
  } finally {
    await database.close();
  }
});

test('legacy import: days are idempotent (never lowered), baseline is adopted once and closes the upgrade gap', async () => {
  const database = await setup();
  try {
    const d1 = dayKey(BASE - 2 * DAY);
    const d2 = dayKey(BASE - DAY);
    const baseline = { scope: 'scope-a', boot: 1_780_000_000, interfaces: { eth0: { up: 1000, down: 2000 } } };
    const imported = await rpc(database, 'cfm_traffic_import', {
      input_client: 'c1',
      input_days: [{ date: d1, up: 700, down: 900 }, { date: d2, up: 100, down: 200 }, { date: 'bad', up: 1, down: 1 }, { date: d2, up: 'x', down: 1 }],
      input_baseline: baseline,
    });
    assert.equal(imported.days, 2, 'malformed entries are skipped');
    assert.deepEqual(await days(database), [{ day: d1, up: 700, down: 900 }, { day: d2, up: 100, down: 200 }]);

    // 重发、且给了一个更小的旧值：不改小；基线已采纳，不会被覆盖。
    await rpc(database, 'cfm_traffic_import', {
      input_client: 'c1',
      input_days: [{ date: d1, up: 50, down: 50 }],
      input_baseline: { ...baseline, interfaces: { eth0: { up: 5, down: 5 } } },
    });
    assert.equal((await days(database))[0].up, 700);

    // 新版第一次采样：与旧版最后的读数比较，升级期间的 300/400 被记下（不是只起基线）。
    const totals = await apply(database, [sample(BASE + HOUR, { eth0: [1300, 2400] })], { input_from: d1, input_to: dayKey(BASE) });
    assert.deepEqual([totals.up, totals.down], [700 + 100 + 300, 900 + 200 + 400]);
  } finally {
    await database.close();
  }
});

test('legacy import never overrides a baseline that live samples already established', async () => {
  const database = await setup();
  try {
    await apply(database, [sample(BASE + HOUR, { eth0: [50_000, 50_000] })]);
    await rpc(database, 'cfm_traffic_import', {
      input_client: 'c1',
      input_days: [],
      input_baseline: { scope: 'scope-a', boot: 1_780_000_000, interfaces: { eth0: { up: 1, down: 1 } } },
    });
    const totals = await apply(database, [sample(BASE + 2 * HOUR, { eth0: [50_100, 50_100] })]);
    assert.deepEqual([totals.up, totals.down], [100, 100], 'a stale legacy baseline would have produced ~50000');
  } finally {
    await database.close();
  }
});

test('legacy import validates its input', async () => {
  const database = await setup();
  try {
    assert.deepEqual(await rpc(database, 'cfm_traffic_import', { input_client: 'c1', input_days: null, input_baseline: null }), { days: 0 });
    await assert.rejects(
      () => rpc(database, 'cfm_traffic_import', { input_client: 'c1', input_days: Array.from({ length: 401 }, () => ({ date: dayKey(BASE), up: 1, down: 1 })), input_baseline: null }),
      /too_many_days/,
    );
    await rpc(database, 'cfm_traffic_import', { input_client: 'c1', input_days: [], input_baseline: { scope: '', interfaces: {} } });
    assert.equal((await database.query(`select count(*)::int as n from traffic_counter_state`)).rows[0].n, 0, 'an empty scope is not a baseline');
    const ancient = dayKey(BASE - 500 * DAY);
    const imported = await rpc(database, 'cfm_traffic_import', { input_client: 'c1', input_days: [{ date: ancient, up: 1, down: 1 }], input_baseline: null });
    assert.equal(imported.days, 1);
    assert.deepEqual(await days(database), [], 'outside the retention window: handled but not stored');
  } finally {
    await database.close();
  }
});

test('traffic tables and functions are not reachable by anon or authenticated roles', async () => {
  const database = await createTestDatabase();
  try {
    const exposure = await database.query(`
      select
        has_table_privilege('anon', 'public.traffic_daily', 'select') as anon_daily,
        has_table_privilege('authenticated', 'public.traffic_counter_state', 'select') as auth_state,
        has_function_privilege('anon', 'public.cfm_traffic_apply_samples(text, jsonb, text, text)', 'execute') as anon_apply,
        has_function_privilege('authenticated', 'public.cfm_traffic_import(text, jsonb, jsonb)', 'execute') as auth_import,
        has_function_privilege('service_role', 'public.cfm_traffic_apply_samples(text, jsonb, text, text)', 'execute') as service_apply,
        has_function_privilege('service_role', 'public.cfm_traffic_import(text, jsonb, jsonb)', 'execute') as service_import,
        (select bool_and(relrowsecurity and relforcerowsecurity) from pg_class
           where oid in ('public.traffic_daily'::regclass, 'public.traffic_counter_state'::regclass)) as rls
    `);
    assert.deepEqual(exposure.rows[0], {
      anon_daily: false, auth_state: false, anon_apply: false, auth_import: false,
      service_apply: true, service_import: true, rls: true,
    });
  } finally {
    await database.close();
  }
});
