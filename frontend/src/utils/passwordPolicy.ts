// 与 worker/src/auth/password.ts 的 MIN_ADMIN_PASSWORD_LENGTH 保持一致。
// 前端只做即时提示，最终以服务端校验为准。
export const MIN_ADMIN_PASSWORD_LENGTH = 12;

export function validateAdminPasswordLength(password: string): string | null {
  if (Array.from(password).length < MIN_ADMIN_PASSWORD_LENGTH) {
    return `密码至少需要 ${MIN_ADMIN_PASSWORD_LENGTH} 位`;
  }
  return null;
}
