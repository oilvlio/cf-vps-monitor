/** 主题配置的读取与校验（/api/themes/:short/config 的数据层）。 */
import * as db from '../../db/queries';
import { recordOrNull } from './json';

export const THEME_CONFIG_MAX_BYTES = 32 * 1024;
export const THEME_CONFIG_SETTING_PREFIX = 'monitor_theme_config:';

export async function loadThemeConfig(
  database: db.QueryDatabase,
  short: string,
): Promise<Record<string, unknown>> {
  const saved = await db.getSetting(database, `${THEME_CONFIG_SETTING_PREFIX}${short}`).catch(() => null);
  if (saved !== null) {
    try {
      const config = recordOrNull(JSON.parse(saved));
      if (config && new TextEncoder().encode(JSON.stringify(config)).byteLength <= THEME_CONFIG_MAX_BYTES) {
        return config;
      }
    } catch {
      // Ignore malformed stored values and fall back to the uploaded theme record.
    }
  }
  const theme = await db.getTheme(database, short).catch(() => null);
  if (!theme?.config_json) return {};

  try {
    const config = recordOrNull(JSON.parse(theme.config_json));
    if (!config || JSON.stringify(config).length > THEME_CONFIG_MAX_BYTES) return {};
    return config;
  } catch {
    return {};
  }
}
