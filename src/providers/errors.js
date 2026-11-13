// One error type for everything a model provider can throw at the agent.

export class ProviderError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, retryable?: boolean, retryAfter?: number, kind?: string, cause?: unknown }} [info]
   * kind: 'auth' | 'rate_limit' | 'context_overflow' | 'bad_request' | 'network' | 'server' | 'other'
   */
  constructor(message, info = {}) {
    super(message, info.cause ? { cause: info.cause } : undefined);
    this.name = 'ProviderError';
    this.status = info.status;
    this.code = info.code;
    this.retryable = !!info.retryable;
    this.retryAfter = info.retryAfter;
    this.kind = info.kind || 'other';
  }
}

export function kindFromStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 400 || status === 404 || status === 422) return 'bad_request';
  if (status >= 500) return 'server';
  return 'other';
}

export function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/** Exponential backoff with jitter; honors a server-provided retry-after (seconds). */
export function backoffMs(attempt, retryAfter, baseMs = 1000) {
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter, 60) * 1000;
  const base = Math.min(baseMs * 2 ** attempt, 16000);
  return base / 2 + Math.random() * (base / 2);
}
