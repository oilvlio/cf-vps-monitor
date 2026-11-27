/** A required read failed; callers must not publish or cache fabricated empty data. */
export class ReadUnavailableError extends Error {
  constructor() {
    super('Data is temporarily unavailable');
    this.name = 'ReadUnavailableError';
  }
}

export function readFailureResponse(error: Error): Response {
  if (!(error instanceof ReadUnavailableError)) throw error;
  return Response.json({ error: '数据暂时不可用，请稍后重试' }, {
    status: 503,
    headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' },
  });
}
