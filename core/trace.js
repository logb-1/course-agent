/**
 * A per-job trace, one JSON object per line.
 *
 * Without it "why was that explanation bad?" is unanswerable: the transcript
 * shows the answer, not the calls that produced it. The trace is the cheapest
 * thing that makes the agent observable — which tools ran, with what arguments
 * (hashed, not stored verbatim), how long they took, and whether they failed.
 *
 * Kept outside the job record on purpose: the job is rewritten on every
 * heartbeat, and appending a line must not become a 200 ms save.
 */

import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export const TRACE_LIMIT = 50

export const tracePathOf = (jobsDir, jobId) => join(jobsDir, `${jobId}.trace.jsonl`)

/** Stable hash of the arguments, so the trace stays small and secret-free. */
export function argsHash(args) {
  let text
  try {
    text = JSON.stringify(args ?? {})
  } catch {
    text = String(args)
  }
  return createHash('sha1').update(text).digest('hex').slice(0, 10)
}

/** Append one line; a trace failure must never fail the tool call. */
export function appendTrace(path, entry) {
  try {
    appendFileSync(path, `${JSON.stringify(entry)}\n`)
    return true
  } catch {
    return false
  }
}

/** Last `limit` entries, newest last. Missing file → empty. */
export function readTrace(path, limit = TRACE_LIMIT) {
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
    return lines.slice(-limit).map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    }).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Aggregate what a session did: how many calls, how many failed, how long they
 * took, and the tool sequence. `statusView` shows this so the model can notice
 * it has been polling forever or repeating a failing call.
 */
export function summarizeTrace(entries = []) {
  const calls = entries.length
  const failed = entries.filter((entry) => entry.ok === false).length
  const ms = entries.reduce((sum, entry) => sum + (Number(entry.ms) || 0), 0)
  return {
    calls,
    failed,
    ms,
    tools: entries.map((entry) => entry.tool).filter(Boolean),
  }
}
