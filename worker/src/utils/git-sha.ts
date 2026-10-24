export function normalizeGitSha(value: string | undefined): string {
  return (value || '').trim().toLowerCase();
}

export function shortGitSha(value: string | undefined): string {
  return normalizeGitSha(value).slice(0, 7);
}
