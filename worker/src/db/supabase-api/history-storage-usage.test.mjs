import assert from 'node:assert/strict';
import test from 'node:test';
import { createTestDatabase, rpc } from '../../../../scripts/test-support/postgres.mjs';

test('AUD-13 deleted rows release the live-data budget even while allocated files remain large', async () => {
  const database = await createTestDatabase();
  try {
    await database.exec(`
      insert into clients(uuid) values ('synthetic-node');
      insert into records(client,time) select 'synthetic-node', '2026-09-01'::timestamptz + n * interval '1 second'
        from generate_series(1,36000) n;
    `);
    const readUsage = async () => rpc(database, 'cfm_history_storage_usage');
    const before = await readUsage();
    await database.exec('delete from records where id > 1;');
    const after = await readUsage();
    assert.equal(after.live_rows, 1);
    assert.ok(after.allocated_bytes >= before.allocated_bytes * 0.9, 'fixture retains PostgreSQL allocation after DELETE');
    assert.ok(after.estimated_live_storage_bytes < before.estimated_live_storage_bytes / 10,
      'capacity control must observe live data reduction rather than retained physical allocation');
    assert.equal(after.reusable_bytes, null, 'free space was not measured and must not be invented');
    assert.equal(after.measurement, 'live-row-bytes-plus-index-estimate');
    assert.ok(after.live_row_bytes > 0);
    assert.ok(after.estimated_live_storage_bytes > after.live_row_bytes, 'index/page allowance is separate from measured tuples');

    const { evaluateHistoryCapacity } = await import('../../utils/history-capacity.ts');
    const byteLimit = before.estimated_live_storage_bytes * 0.9;
    assert.equal(evaluateHistoryCapacity(before, { rowLimit: 1_000_000, byteLimit }).blocked, true);
    const recovered = evaluateHistoryCapacity(after, { rowLimit: 1_000_000, byteLimit, wasBlocked: true });
    assert.equal(recovered.blocked, false);
    assert.equal(recovered.allocatedWarning, after.allocated_bytes >= byteLimit);
    assert.equal(evaluateHistoryCapacity({ ...after, estimated_live_storage_bytes: byteLimit * 0.9 }, {
      rowLimit: 1_000_000, byteLimit, wasBlocked: true,
    }).blocked, true, 'hysteresis prevents repeated threshold flapping');
    assert.equal(evaluateHistoryCapacity({ ...after, live_rows: 100 }, { rowLimit: 100, byteLimit }).blocked, true);
  } finally { await database.close(); }
});
