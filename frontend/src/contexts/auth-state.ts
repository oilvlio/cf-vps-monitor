export interface User {
  uuid: string;
  username: string;
}

// 登录态缓存键：AuthContext 写入，App 用它判断是否值得预取后台路由。
export const AUTH_USER_STORAGE_KEY = 'cf_monitor_user';

export function normalizeAuthUser(value: unknown): User | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const uuid = typeof record.uuid === 'string' ? record.uuid.trim() : '';
  const username = typeof record.username === 'string' ? record.username.trim() : '';
  return uuid && username ? { uuid, username } : null;
}

export function shouldClearAuthForStatus(status: number): boolean {
  return status === 401 || status === 403;
}

export function shouldCheckAdminSessionOnLoad(_pathname: string): boolean {
  return true;
}
