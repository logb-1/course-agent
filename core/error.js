/**
 * Structured failures.
 *
 * A prose `reason` is fine for a human reading the transcript, but a model
 * cannot branch on Chinese text. Every refusal therefore carries:
 *
 *   code      machine-readable, stable, documented in docs/agent-contract.md
 *   reason    the human sentence (kept, callers/tests already show it)
 *   retryable whether calling again could succeed without changing anything
 *   hint      the next call the model should make instead
 *
 * Codes are frozen on purpose: changing one is a breaking change for any
 * caller that branches on it, so new situations get new codes.
 */

export const CODES = {
  /** A required argument is missing or malformed. */
  badRequest: 'bad_request',
  /** No job with that id — typo, or it was pruned. */
  jobNotFound: 'job_not_found',
  /** The job exists but has nothing to give yet (still running / no parse). */
  jobNotReady: 'job_not_ready',
  /** The request costs materially more than the default and nobody agreed. */
  needsConfirm: 'needs_confirm',
  /** Identical request already running; the caller gets that job back. */
  duplicateJob: 'duplicate_job',
  /** Input path missing, not a file, or too large. */
  badFile: 'bad_file',
  /** Parsed fine, but the deck yields no readable text. */
  noContent: 'no_content',
  /** Anything unexpected; retryable is false until proven otherwise. */
  internal: 'internal',
}

export const FAILURE_CODES = Object.values(CODES)

/**
 * @param {string} code one of CODES
 * @param {string} reason human sentence, Chinese
 * @param {{ retryable?: boolean, hint?: string, details?: object }} [extra]
 */
export function failure(code, reason, extra = {}) {
  const result = { ok: false, code: String(code), reason: String(reason || '操作失败') }
  if (extra.retryable !== undefined) result.retryable = !!extra.retryable
  if (extra.hint) result.hint = String(extra.hint)
  if (extra.details && typeof extra.details === 'object') result.details = extra.details
  return result
}

export const isFailure = (value) => value?.ok === false
