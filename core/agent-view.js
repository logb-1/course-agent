/**
 * Agent-facing views of a course job.
 *
 * The pipeline already knows everything an agent needs, but a job snapshot is a
 * 30–50 KB object with per-chapter summaries, videos and trees. Handing that to
 * a model costs context and still hides the two things it must decide on: how
 * far the run got, and what to call next.
 *
 * So every tool return goes through one of the views below. They are pure
 * functions of the job (plus the persisted passage index for reading), which is
 * what makes the tool surface testable without a model or a real pipeline.
 */

import { readingNote } from './reading.js'
import { summarizeTrace } from './trace.js'

/** Hard caps for every agent-facing payload. Prompted by real prompts getting fat. */
export const LIMITS = {
  maxFiles: 12,
  maxFileBytes: 60 * 1024 * 1024,
  maxChapters: 80,
  defaultReadChars: 6000,
  maxReadChars: 12000,
  maxWarnings: 3,
  maxKeyPoints: 6,
  maxAnswers: 4,
  maxLibrary: 20,
  maxPreviewChars: 1200,
}

const clampInt = (value, min, max, fallback) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

const list = (value) => (Array.isArray(value) ? value : [])

/**
 * One machine-readable next step. The agent should never have to infer "is it
 * done?" from a progress float: `next` names the tool to call and why.
 * @returns {{tool:string, hint:string}}
 */
export function nextStep(job) {
  const status = job?.status
  if (!job) return { tool: 'course_library', hint: '没有任务上下文，先列出历史课程或重新建档' }
  if (status === 'running') return { tool: 'course_status', hint: '任务在跑：轮询 course_status，不要重复建档' }
  if (status === 'done') {
    return { tool: 'course_outline', hint: '已完成：先看目录，再按章 course_read / course_ask，最后 course_export' }
  }
  if (status === 'error') return { tool: 'course_ingest', hint: '任务失败：看 error 说明，必要时修正文件或用 course_ingest 重跑' }
  if (status === 'cancelled' || status === 'interrupted') {
    return { tool: 'course_ingest', hint: '任务已中止：需要结果就重新 course_ingest' }
  }
  return { tool: 'course_status', hint: '状态未知：轮询 course_status' }
}

/** OCR coverage, kept short: silent OCR degradation is what bites later. */
export function ocrSummary(job) {
  const ocr = job?.ocr
  if (!ocr) return null
  return {
    mode: ocr.mode || '',
    engine: ocr.engine || '',
    total: Number(ocr.total) || 0,
    pages: Number(ocr.pages) || 0,
    adopted: Number(ocr.adopted) || 0,
    deferred: Number(ocr.deferred) || 0,
    // lines where the Latin pass beat the Chinese pass: proof the merge ran
    merged: Number(ocr.merged) || 0,
    scanned: !!ocr.scanned,
  }
}

/**
 * Reading coverage rolled up to the job: pages that had readable text, pages
 * whose text came from OCR, and how many chapters were not fully read. Silent
 * page loss is the failure this field exists to surface.
 */
export function readingSummary(job) {
  const chapters = list(job.chapters)
  let pages = 0
  let withText = 0
  let ocred = 0
  let unknown = 0
  let unreadChapters = 0
  for (const chapter of chapters) {
    const stats = chapter.stats
    if (!stats || !stats.pages) continue
    const total = Number(stats.pages) || 0
    const seen = Number(stats.withText) || 0
    const lost = Number(stats.unknown) || 0
    pages += total
    withText += seen
    ocred += Number(stats.ocred) || 0
    unknown += lost
    // pages we could not attribute at all are unknown, not missing: claiming them
    // unread would invent a gap the same way the old report invented health
    if (total - seen - lost > 0) unreadChapters += 1
  }
  if (!pages) return null
  return { pages, withText, ocred, unknownPages: unknown, unreadPages: pages - withText - unknown, unreadChapters }
}

/**
 * What the run cost. `modelCalls` is the number that explains a long run; the
 * cache ratio explains a cheap one.
 */
export function costSummary(job) {
  const t = job?.telemetry
  if (!t) return null
  const calls = Number(t.modelCalls) || 0
  const hits = Number(t.cacheHits) || 0
  return {
    modelCalls: calls,
    cacheHits: hits,
    cacheRatio: calls + hits ? Math.round((hits / (calls + hits)) * 100) / 100 : null,
    sourceChars: Number(t.sourceChars) || 0,
    keptChars: Number(t.keptChars) || 0,
    ms: Number(t.ms) || null,
  }
}

/**
 * Progress view. Answers "how far, what broke, what next" and nothing else —
 * chapter bodies and summaries belong to course_read / course_outline.
 * `extra.trace` is the job's tool trace, when the caller has one.
 */
export function statusView(job, extra = {}) {
  const chapters = list(job.chapters)
  const summarized = chapters.filter((c) => c.summary && !c.summary.offline).length
  const offline = chapters.filter((c) => c.summary?.offline).length
  const failed = chapters.filter((c) => c.summary?.error).map((c) => c.index)
  const warnings = list(job.warnings)
  // derived, so a run that read only half a scan cannot look healthy
  const reading = readingSummary(job)
  const derived = []
  if (reading?.unreadPages) {
    derived.push(
      `有 ${reading.unreadPages}/${reading.pages} 页没有可读文字（扫描件或纯图），涉及章节的讲解依据可能不全`,
    )
  }
  return {
    jobId: job.id,
    status: job.status,
    phase: job.phase || '',
    message: job.message || '',
    progress: Math.round((Number(job.progress) || 0) * 100) / 100,
    courseTitle: job.courseTitle || '',
    chapters: { total: chapters.length, summarized, offline },
    reading: readingSummary(job),
    failedChapters: failed,
    warnings: [...derived, ...warnings].slice(0, LIMITS.maxWarnings).map(String),
    warningsTotal: warnings.length + derived.length,
    ocr: ocrSummary(job),
    // what this run has spent so far, and what the agent has already called:
    // without these, "why is this slow / expensive" is unanswerable
    cost: costSummary(job),
    tools: extra.trace ? summarizeTrace(extra.trace) : undefined,
    elapsedMs: Number(job.elapsedMs) || null,
    error: job.error || '',
    reportPath: job.reportPath || '',
    next: nextStep(job),
  }
}

const firstLast = (pages) => {
  if (!pages.length) return []
  return pages.length === 1 ? [pages[0]] : [pages[0], pages[pages.length - 1]]
}

/**
 * Outline view: the menu the agent reads before opening a chapter. No bodies,
 * no videos, no summary text — just enough to choose and to justify a choice.
 */
export function outlineView(job) {
  const chapters = list(job.chapters)
  const rows = chapters.slice(0, LIMITS.maxChapters).map((chapter) => ({
    chapter: chapter.index,
    title: chapter.title || `第 ${chapter.index} 章`,
    pages: firstLast(list(chapter.pages).map(Number)),
    chars: Number(chapter.chars) || 0,
    // how much of the chapter was actually read — a short row with pages 0 is
    // "text-only document", a row with withText < pages is "we could not read it"
    read: chapter.stats
      ? {
          pages: Number(chapter.stats.pages) || 0,
          withText: Number(chapter.stats.withText) || 0,
          ocred: Number(chapter.stats.ocred) || 0,
        }
      : null,
    note: readingNote(chapter.stats),
    keyPoints: list(chapter.summary?.key_points).length,
    offline: !!chapter.summary?.offline,
    error: chapter.summary?.error || '',
    coverage: chapter.coverage?.covered ?? chapter.coverage?.ratio ?? null,
  }))
  return {
    jobId: job.id,
    courseTitle: job.courseTitle || '',
    status: job.status,
    domain: job.domain?.name || '',
    chapters: rows,
    reading: readingSummary(job),
    truncated: chapters.length > rows.length,
    warnings: list(job.warnings).slice(0, LIMITS.maxWarnings).map(String),
    ocr: ocrSummary(job),
    telemetry: job.telemetry || null,
    cost: costSummary(job),
    reportPath: job.reportPath || '',
    next: { tool: 'course_read', hint: '选一章 course_read 读正文；要定位具体说法用 course_ask' },
  }
}

/** Passages of one chapter, in their original order. */
export function chapterPassages(passages, chapter) {
  const wanted = Number(chapter)
  return list(passages).filter((row) => Number(row.chapter) === wanted)
}

const cutAt = (text, limit) => {
  if (text.length <= limit) return { text, cut: false }
  const window = text.slice(0, limit)
  const at = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('。'), window.lastIndexOf('；'))
  const keep = at > limit * 0.6 ? window.slice(0, at + 1) : window
  return { text: keep, cut: true }
}

/**
 * Deterministic read of one chapter. `offset` makes it resumable instead of
 * asking for `maxChars: 999999`, and the page list keeps every claim traceable.
 * @returns {null|object} null when the chapter has no persisted text
 */
export function readView(passages, chapter, options = {}) {
  const rows = chapterPassages(passages, chapter)
  if (!rows.length) return null
  const pages = [...new Set(rows.map((row) => Number(row.page)).filter((page) => page > 0))]
  // Provenance has to survive into the text the model reads: a separate `pages`
  // array only says which pages were in play, not which sentence came from
  // where, and an answer can only cite what it can see.
  const marked = pages.length > 0
  const whole = marked
    ? rows.map((row) => `${Number(row.page) > 0 ? `[p${Number(row.page)}] ` : ''}${row.text}`).join('\n')
    : rows.map((row) => row.text).join('')
  const offset = clampInt(options.offset, 0, Math.max(0, whole.length), 0)
  const maxChars = clampInt(options.maxChars, 400, LIMITS.maxReadChars, LIMITS.defaultReadChars)
  const window = cutAt(whole.slice(offset), maxChars)
  return {
    jobId: options.jobId || '',
    chapter: Number(chapter),
    title: rows[0].chapterTitle || '',
    pages,
    charsTotal: whole.length,
    offset,
    chars: window.text.length,
    text: window.text,
    truncated: window.cut,
    nextOffset: window.cut ? offset + window.text.length : null,
    next: window.cut
      ? { tool: 'course_read', hint: `还有 ${whole.length - offset - window.text.length} 字：带 offset=${offset + window.text.length} 继续` }
      : { tool: 'course_ask', hint: '要讲解的原文已读全；需要定位某个说法用 course_ask 取带页码片段' },
  }
}

/** History list: one line per job, newest first. */
export function libraryView(rows) {
  return {
    jobs: list(rows).slice(0, LIMITS.maxLibrary).map((row) => ({
      jobId: row.id,
      courseTitle: row.courseTitle || '',
      status: row.status || 'unknown',
      chapters: Number(row.chapters) || 0,
      report: !!row.report,
      updatedAt: row.updatedAt || '',
    })),
    next: { tool: 'course_status', hint: '接着上次的课程继续：对某个 jobId 调 course_status' },
  }
}

/** Trim a markdown report to a bounded preview without splitting a heading. */
export function previewOf(markdown, maxChars = LIMITS.maxPreviewChars) {
  const body = String(markdown || '')
  const { text, cut } = cutAt(body, clampInt(maxChars, 200, 4000, LIMITS.maxPreviewChars))
  return { preview: text, truncated: cut, charsTotal: body.length }
}
