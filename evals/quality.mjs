/**
 * Graders for an *explanation* — the part the pipeline eval can't see.
 *
 * The rule stays the same as grade.mjs: grade only what a program can prove.
 * We cannot prove "讲得清楚", but we can prove the claims an explanation is
 * built from:
 *
 *   - 它引的页，是这一章真的有的页吗？（第 99 页 / [p99] 属于编造）
 *   - 它「引用」的原文，真的在它读到的文本里吗？（不在就是转述冒充原文）
 *   - 这一章有页没读到，它说了吗？（沉默比说错更常见）
 *   - 它是在讲解，还是在敷衍？（长度下限；上限防呛 context）
 *
 * Every grader returns `{ ok, detail }`; `scoreAnswer` folds them into one row
 * so a runner can print PASS/FAIL per answer and a human can read the detail.
 */

const stripMarks = (text) => String(text || '').replace(/\[p\d+\]/g, '')
const squeeze = (text) => stripMarks(text).replace(/\s+/g, '')

/** Pages this answer claims to be talking about, from either style of citation. */
export function citedPages(answer) {
  const text = String(answer || '')
  const pages = []
  for (const match of text.matchAll(/\[p(\d{1,4})\]/g)) pages.push(Number(match[1]))
  for (const match of text.matchAll(/第\s*(\d{1,4})\s*页/g)) pages.push(Number(match[1]))
  for (const match of text.matchAll(/\bp\.?\s*(\d{1,4})\b/gi)) pages.push(Number(match[1]))
  return pages.filter((page) => Number.isFinite(page) && page > 0)
}

/**
 * Provenance: a citation must fall inside the chapter it explains. A text deck
 * with no pagination gets no citation requirement — inventing a page to satisfy
 * a rubric would be worse than citing none.
 */
export function gradeCitations({ answer, chapterPages = [], paginated = true }) {
  if (!paginated) return { ok: true, detail: 'no pagination (text deck)' }
  const pages = citedPages(answer)
  if (!pages.length) return { ok: false, detail: '讲解没有引用任何页码' }
  const low = Math.min(...chapterPages.map(Number))
  const high = Math.max(...chapterPages.map(Number))
  if (!chapterPages.length) return { ok: true, detail: `${pages.length} citation(s)` }
  const outside = pages.filter((page) => page < low || page > high)
  if (outside.length) {
    return { ok: false, detail: `引用了本章不存在的页 p${outside.join(', p')}（本章 p${low}..p${high}）` }
  }
  return { ok: true, detail: `${pages.length} citation(s) within p${low}..p${high}` }
}

const QUOTE_PATTERNS = [/「([^」]{4,})」/g, /“([^”]{4,})”/g, /"([^"]{4,})"/g, /`([^`]{4,})`/g]

/**
 * 中文写作里「」常被当成强调而不是引用。只有在同一句里出现「原话 / 原文 /
 * 写道 / 文中 / 课件说」这类锚点时，才把它当作「我照抄了原文」的断言去核对，
 * 否则会天天误报强调用法，把质量门变成噪音。
 */
const QUOTE_ANCHOR = /(原话|原文|写道|写着|文中|课件里?(说|写)|表述|字面)/

export function gradeQuotes({ answer, readText, strictQuotes = false }) {
  const text = String(answer || '')
  const haystack = squeeze(readText)
  if (!haystack) return { ok: true, detail: 'no source text to check against' }
  const quotes = []
  for (const pattern of QUOTE_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const span = match[1]
      const before = text.slice(Math.max(0, match.index - 14), match.index)
      const after = text.slice(match.index + match[0].length, match.index + match[0].length + 14)
      if (strictQuotes || QUOTE_ANCHOR.test(before) || QUOTE_ANCHOR.test(after)) quotes.push(span)
    }
  }
  if (!quotes.length) return { ok: true, detail: 'no verbatim quote claimed' }
  const missing = quotes.filter((quote) => !haystack.includes(squeeze(quote)))
  if (missing.length) {
    const sample = missing[0].slice(0, 30)
    return { ok: false, detail: `${missing.length} 处声称照抄的原文不在课件里，例如「${sample}…」` }
  }
  return { ok: true, detail: `${quotes.length} quote(s) found in source` }
}

/**
 * Silence about unread pages is the failure mode that shipped three bugs: a
 * chapter that was never really read looks exactly like a short chapter.
 */
export function gradeUnreadNote({ answer, reading }) {
  const unread = Number(reading?.unreadPages) || 0
  if (unread <= 0) return { ok: true, detail: 'every page read' }
  const said = /(未读|没读到|没有可读|无可读|读不到|无法读取|扫描件|纯图|图片页|OCR\s*失败)/.test(String(answer || ''))
  if (!said) return { ok: false, detail: `本章有 ${unread} 页没读到，讲解却没有任何提示` }
  return { ok: true, detail: `mentioned ${unread} unread page(s)` }
}

/** Long enough to be an explanation; short enough not to flood a context. */
export function gradeLength({ answer, minChars = 80, maxChars = 4000 }) {
  const chars = String(answer || '').trim().length
  if (chars < minChars) return { ok: false, detail: `只有 ${chars} 字，不足以是一段讲解` }
  if (chars > maxChars) return { ok: false, detail: `${chars} 字超出上限 ${maxChars}` }
  return { ok: true, detail: `${chars} chars` }
}

/**
 * One answer, all checks. `record` is exactly what `evals/talk.mjs` accepts:
 *
 *   { id, answer, readText, chapterPages, paginated, reading }
 */
export function scoreAnswer(record = {}) {
  const checks = [
    ['citations', gradeCitations(record)],
    ['quotes', gradeQuotes(record)],
    ['unread-note', gradeUnreadNote(record)],
    ['length', gradeLength(record)]
  ].map(([name, result]) => ({ name, ...result }))
  return { ok: checks.every((check) => check.ok), checks }
}
