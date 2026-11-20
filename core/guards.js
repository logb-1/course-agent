/**
 * The rules that were documented but not enforced.
 *
 * `docs/agent-contract.md` promises three things the tools used to only hint at:
 * a half-finished job cannot be exported, a costly level needs explicit consent,
 * and the same files twice is one job. Each rule lives here as a pure function
 * so a unit test can pin the intent and the api stays a thin shell.
 */

import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { failure, CODES } from './error.js'

/** Levels that cost materially more than the default. */
export const COSTLY_LEVELS = ['max', 'plus']

/** A job whose artefacts may be handed to the user. */
export const EXPORTABLE = ['done']

/**
 * Refuse to export anything from a job that is still working, failed, or was
 * cancelled. `csv` and `json` used to slip through because they are built from
 * whatever fields happen to exist — a half-built course looked like a course.
 */
export function checkExport(job) {
  if (!job) {
    return failure(CODES.jobNotFound, '任务不存在（jobId 写错了，或任务已被删除）', {
      hint: '用 course_library 找 jobId',
    })
  }
  const status = String(job.status || 'unknown')
  if (EXPORTABLE.includes(status)) return null
  if (status === 'running' || status === 'queued') {
    return failure(CODES.jobNotReady, `任务还在 ${status}（${job.phase || '-'}），跑完再导出`, {
      retryable: true,
      hint: '先 course_status 轮询到 done，再 course_export',
      details: { status, progress: Number(job.progress) || 0 },
    })
  }
  return failure(CODES.jobNotReady, `任务状态是 ${status}，没有可导出的成果`, {
    hint: status === 'error' || status === 'interrupted' ? '重跑这次建档，再导出' : '换一个已完成的 jobId',
    details: { status, error: String(job.error || '') },
  })
}

/**
 * `normal` is the default and free to use. `max` / `plus` multiply the model
 * spend, so the caller must say yes explicitly — a hint in a description is not
 * a gate.
 */
export function checkLevel(level, confirm) {
  const picked = String(level || 'normal')
  if (!COSTLY_LEVELS.includes(picked)) return null
  if (confirm === true) return null
  return failure(CODES.needsConfirm, `reportLevel=${picked} 明显更贵（每个章节都要重新调用模型），需要用户明确同意`, {
    hint: `先向用户说明 ${picked} 的成本；得到同意后带 confirm: true 再调用 course_ingest`,
    details: { level: picked, costs: true },
  })
}

/**
 * Identity of an ingest request. Same files (by resolved path), same level,
 * same append target, same options that change the output → same job. Nothing
 * here looks at file contents, so an edited deck is a new request only when its
 * path changes; the summary cache keys handle content.
 */
export function ingestKey(inputs, options = {}, appendTo = '') {
  const files = (inputs || [])
    .map((input) => resolve(String(input?.path || input || '')))
    .sort()
  const parts = [
    `files:${files.join('|')}`,
    `level:${options.reportLevel || 'normal'}`,
    `videos:${options.withVideos === false ? 'off' : 'on'}`,
    `append:${appendTo || ''}`,
    `sprint:${[options.days || '', options.target || '', options.minutes || ''].join(',')}`,
  ]
  return createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 16)
}

/**
 * A job may be reused when it is still running, or finished successfully and
 * recently enough that "call it again" almost certainly means "I did not see
 * the answer". Errors are never reused: the caller may have fixed the input.
 */
export function reusableJob(jobs, key, now = Date.now(), windowMs = 5 * 60_000) {
  const rows = [...(jobs?.values?.() || jobs || [])]
  for (const job of rows) {
    if (!job || job.requestKey !== key) continue
    const status = String(job.status || '')
    if (status === 'running' || status === 'queued') return job
    if (status === 'error' || status === 'cancelled' || status === 'interrupted') continue
    const at = Date.parse(job.finishedAt || job.updatedAt || '') || 0
    if (at && now - at <= windowMs) return job
  }
  return null
}
