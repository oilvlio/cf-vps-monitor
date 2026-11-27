/** 主题配置的读取与校验（/api/themes/:short/config 的数据层）。 */
import * as db from '../../db/queries';
import { recordOrNull } from './json';
import {
  THIRD_PARTY_THEME_SETTING_KEY,
  parseThirdPartyThemeSettings,
  parseThemeUrl,
  fetchPublishedThemeFile,
  fetchThemeFile,
} from '../../utils/third-party-theme';

// Keep the native monitor theme-settings budget compatible with the monitor
// contract route, while applying it both to the wire body and serialized value.
export const THEME_CONFIG_MAX_BYTES = 64 * 1024;
export const THEME_CONFIG_SETTING_PREFIX = 'monitor_theme_config:';

/** Uploaded styles and the enabled hosted Monitor page have separate registries. */
export async function isConfigurableTheme(database: db.QueryDatabase, short: string): Promise<boolean> {
  if (short === 'monitor' || short === 'aurora') return true;
  if (await db.getTheme(database, short)) return true;
  const settings = parseThirdPartyThemeSettings(await db.getSetting(database, THIRD_PARTY_THEME_SETTING_KEY));
  const theme = settings.enabled ? parseThemeUrl(settings.theme_url) : null;
  if (!theme) return false;
  const response = theme.repository
    ? await fetchPublishedThemeFile(theme, 'theme.json', 'application/json', 60)
    : await fetchThemeFile(`${theme.rawBase}/theme.json`, `${theme.cacheBase}/theme.json`, 'application/json', 60);
  if (response.status === 404) return false;
  if (!response.ok) throw new Error('Hosted theme manifest unavailable');
  const manifest = recordOrNull(await response.json());
  return manifest?.short === short;
}

/**
 * 读取主题配置。数据库错误必须向上抛：调用方要把它和“没有配置”区分开，
 * 否则一次读失败会被当成空配置返回，管理页再保存就会覆盖掉已存的值。
 * 只有“确实没有存过”与“存的内容不是合法对象”才回退到主题包里的默认配置。
 */
export async function loadThemeConfig(
  database: db.QueryDatabase,
  short: string,
): Promise<Record<string, unknown>> {
  const saved = await db.getSetting(database, `${THEME_CONFIG_SETTING_PREFIX}${short}`);
  if (saved !== null && saved !== '') {
    try {
      const config = recordOrNull(JSON.parse(saved));
      if (config && new TextEncoder().encode(JSON.stringify(config)).byteLength <= THEME_CONFIG_MAX_BYTES) {
        return config;
      }
    } catch {
      // Ignore malformed stored values and fall back to the uploaded theme record.
    }
  }
  const theme = await db.getTheme(database, short);
  if (!theme?.config_json) return {};

  try {
    const config = recordOrNull(JSON.parse(theme.config_json));
    if (!config || new TextEncoder().encode(JSON.stringify(config)).byteLength > THEME_CONFIG_MAX_BYTES) return {};
    return config;
  } catch {
    return {};
  }
}
