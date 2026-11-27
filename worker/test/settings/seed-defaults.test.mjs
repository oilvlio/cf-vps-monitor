import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createTestDatabase } from '../../../scripts/test-support/postgres.mjs';
import { buildAdminSettings, SETTING_SCHEMA, REMOVED_SETTING_KEYS, sanitizeSettingsForStorage } from '../../src/settings/schema.ts';

test('fresh database seeds match runtime defaults and omit the retired capacity estimator', async () => {
  const database = await createTestDatabase();
  try {
    const { rows } = await database.query('select key, value from settings');
    const settings = Object.fromEntries(rows.map(row => [row.key, row.value]));
    assert.equal(settings.site_title, 'CF VPS Monitor');
    for (const [key, value] of Object.entries(settings)) {
      if (SETTING_SCHEMA[key]) assert.equal(value, SETTING_SCHEMA[key].defaultValue, `${key} seed differs from runtime`);
    }
    assert.equal(settings.capacity_daily_view_minutes, undefined);
    assert.equal(REMOVED_SETTING_KEYS.has('capacity_daily_view_minutes'), true);
    assert.equal(buildAdminSettings({ capacity_daily_view_minutes: '60' }).capacity_daily_view_minutes, undefined);
    assert.deepEqual(sanitizeSettingsForStorage({ capacity_daily_view_minutes: '60' }), {
      ok: true, settings: {}, errors: [], ignoredKeys: ['capacity_daily_view_minutes'],
    });
    assert.equal(sanitizeSettingsForStorage({ capacity_daily_view_minutes: '60' }, { ignoreRemoved: false }).ok, false);
    await database.exec("insert into settings(key,value) values ('capacity_daily_view_minutes','60'); update settings set value='Custom title' where key='site_title';");
    const sql = await readFile(new URL('../../../supabase/migrations/1_schema.sql', import.meta.url), 'utf8');
    await database.exec(sql);
    const replay = await database.query("select key,value from settings where key in ('site_title','capacity_daily_view_minutes')");
    assert.deepEqual(replay.rows, [{ key: 'site_title', value: 'Custom title' }]);
  } finally {
    await database.close();
  }
});
