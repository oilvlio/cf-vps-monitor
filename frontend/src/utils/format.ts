/**
 * 共享格式化工具函数
 */

export const formatBytes = (bytes: number): string => {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  let decimals = 2;
  if (i >= 3) decimals = 1;
  if (i <= 1) decimals = 0;
  if (val >= 100) decimals = 0;
  return `${val.toFixed(decimals)} ${units[i]}`;
};

export const formatSpeed = (bytes: number): string => {
  if (!bytes || bytes === 0) return '0 B/s';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  let decimals = 2;
  if (i >= 3) decimals = 1;
  if (i <= 1) decimals = 0;
  if (val >= 100) decimals = 0;
  return `${val.toFixed(decimals)} ${units[i]}`;
};

// 运行时长只精确到小时：显示 d / h，不再显示分钟和秒（不足 1 小时显示 0h）。
export const formatUptime = (seconds: number): string => {
  if (!seconds || seconds < 0) return '0h';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (parts.length === 0) parts.push('0h');
  return parts.join(' ');
};

export const formatPercent = (value: number, total: number): number => {
  if (!total || total === 0) return 0;
  return Math.min(100, (value / total) * 100);
};
