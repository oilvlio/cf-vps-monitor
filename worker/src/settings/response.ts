import { SETTING_SCHEMA } from './schema';
import { maskSecretPreview } from '../utils/secret-preview';

/** Browser-facing projection only; internal notification delivery keeps raw settings. */
export function redactAdminSettings(settings: Record<string, string>): Record<string, string> {
  const result = { ...settings };
  for (const [key, definition] of Object.entries(SETTING_SCHEMA)) {
    if (!('sensitive' in definition) || !definition.sensitive || !Object.hasOwn(settings, key)) continue;
    result[`${key}_set`] = settings[key] ? 'true' : 'false';
    // URLs, arbitrary header JSON and binary uploads must not reveal secret fragments.
    if (!['webhook_url', 'webhook_headers_json', 'site_logo_data'].includes(key)) {
      result[`${key}_preview`] = maskSecretPreview(settings[key]);
    }
    delete result[key];
  }
  if (Object.hasOwn(settings, 'webhook_headers_json')) result.webhook_headers_set = result.webhook_headers_json_set;
  if (Object.hasOwn(settings, 'webhook_url')) {
    try { result.webhook_url_host = settings.webhook_url ? new URL(settings.webhook_url).hostname.toLowerCase() : ''; }
    catch { result.webhook_url_host = ''; }
  }
  return result;
}
