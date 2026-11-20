/**
 * Deterministic graders for the eval suite.
 *
 * Rule for everything here: grade only what a program can prove. "Was the
 * explanation good?" needs a model and a human; "did it cite a page that
 * exists?", "did it claim to have read a page it did not read?", "did it refuse
 * an expensive run?" do not. Those are the failures that actually shipped bugs.
 *
 * Every grader returns `{ ok, detail }` so a runner can print one line per check
 * and a baseline can store the numbers without them.
 */

const isNum = (value) => typeof value === 'number' && Number.isFinite(value)

/**
 * Reading honesty: the job must not look fully read when pages produced no
 * text, and `unreadPages` must equal pages - withText - unknown. Three silent
 * OCR bugs once looked exactly like a short chapter.
 */
export function gradeReadingHonesty({ status, outline }) {
  const reading = status?.reading
  if (!reading) return { ok: true, detail: 'no reading stats (text-only path)' }
  const unread = reading.pages - reading.withText - unknown(reading)
  if (!isNum(reading.pages) || !isNum(reading.withText)) return { ok: false, detail: `malformed reading ${JSON.stringify(reading)}` }
  if (unknown(reading) > 0 && unread < 0) return { ok: false, detail: `unknown pages counted as unread ${JSON.stringify(reading)}` }
  if (unread < 0) return { ok: false, detail: `more pages read than exist ${JSON.stringify(reading)}` }
  const warned = (status.warnings || []).some((line) => String(line).includes('没有可读文字'))
  if (unread > 0 && !warned) return { ok: false, detail: `${unread} unread pages but no warning` }
  const chatty = unread === 0 && warned
  if (chatty) return { ok: false, detail: 'warned about unread pages when none are unread' }
  if (outline && isNum(outline.reading?.unreadPages) && outline.reading.unreadPages !== reading.unreadPages) {
    return { ok: false, detail: `status/outline disagree ${reading.unreadPages} vs ${outline.reading.unreadPages}` }
  }
  return { ok: true, detail: `${reading.withText}/${reading.pages} read, ${unread} unread` }
}

const unknown = (reading) => Number(reading.unknownPages) || 0

/**
 * Provenance: every page a chapter claims must be one of the pages the outline
 * assigned to that chapter — an answer citing page 12 of a 5-page chapter is a
 * fabricated citation even when the text is right.
 */
export function gradeCitation({ read, outlineChapter }) {
  if (!read || read.ok === false) return { ok: false, detail: `read failed: ${read?.code || read?.reason}` }
  const chapterPages = (outlineChapter?.pages || []).map(Number)
  const cited = (read.pages || []).map(Number)
  // A markdown/txt deck has no pages at all: nothing to cite, nothing to fake.
  if (!cited.length && !chapterPages.length) return { ok: true, detail: 'no pagination (text deck)' }
  if (!cited.length) return { ok: false, detail: 'read returned no page numbers' }
  // outline only carries first/last page, so check the range rather than the set
  if (!chapterPages.length) return { ok: true, detail: `${cited.length} passages on p${Math.min(...cited)}..p${Math.max(...cited)}` }
  const low = Math.min(...cited)
  const high = Math.max(...cited)
  const outlineLow = Math.min(...chapterPages)
  const outlineHigh = Math.max(...chapterPages)
  if (low < outlineLow || high > outlineHigh) {
    return { ok: false, detail: `cited ${low}..${high} outside chapter ${outlineLow}..${outlineHigh}` }
  }
  return { ok: true, detail: `${cited.length} passages on p${low}..p${high}` }
}

/** Bounds: a read must stay inside what it promised, or context silently grows. */
export function gradeBounds({ read, maxChars }) {
  if (!read || read.ok === false) return { ok: false, detail: `read failed: ${read?.code || read?.reason}` }
  const limit = Number(maxChars) || 12000
  if (read.chars > limit) return { ok: false, detail: `returned ${read.chars} chars > ${limit}` }
  if (read.text.length !== read.chars) return { ok: false, detail: `chars ${read.chars} != text ${read.text.length}` }
  const shouldContinue = read.charsTotal > read.offset + read.chars
  if (shouldContinue && !read.truncated) return { ok: false, detail: 'silently dropped the rest of the chapter' }
  if (!shouldContinue && read.truncated) return { ok: false, detail: 'claimed truncation at the end of the chapter' }
  return { ok: true, detail: `${read.chars}/${read.charsTotal} chars` }
}

/**
 * No fabrication: a query with no match must return nothing and say so. The
 * model may then answer "课件里没写"; what it must never get is a plausible
 * snippet that was never in the deck.
 */
export function gradeMiss({ asked }) {
  if (!asked || asked.ok === false) return { ok: false, detail: `ask failed: ${asked?.code || asked?.reason}` }
  if ((asked.answers || []).length > 0) return { ok: false, detail: `invented ${asked.answers.length} answers for a nonsense query` }
  if (!asked.hint) return { ok: false, detail: 'empty result without an explanation' }
  return { ok: true, detail: 'explicit miss' }
}

/** Cost gate: max/plus must be refused without consent, and refused cheaply. */
export function gradeGate({ refused }) {
  if (!refused || refused.ok !== false) return { ok: false, detail: 'expensive run was accepted without confirm' }
  if (refused.code !== 'needs_confirm') return { ok: false, detail: `wrong code ${refused.code}` }
  if (!refused.hint) return { ok: false, detail: 'refusal without a way forward' }
  return { ok: true, detail: refused.code }
}

/** A hit must be usable: page-cited passages, not a bare paragraph. */
export function gradeAsk({ asked }) {
  if (!asked || asked.ok === false) return { ok: false, detail: `ask failed: ${asked?.code || asked?.reason}` }
  const answers = asked.answers || []
  if (!answers.length) return { ok: false, detail: `no passage for a query the deck should answer (${asked.hint || 'no hint'})` }
  const cited = answers.filter((row) => Number.isFinite(Number(row.page)) && Number(row.chapter) > 0)
  if (cited.length !== answers.length) return { ok: false, detail: `${answers.length - cited.length} passages without chapter/page` }
  return { ok: true, detail: `${answers.length} cited passages` }
}

/** Cost visibility: without numbers, "slow" and "expensive" are opinions. */
export function gradeCost({ status }) {
  if (!status || status.ok === false) return { ok: false, detail: `status failed: ${status?.code || status?.reason}` }
  if (!('cost' in status)) return { ok: false, detail: 'status has no cost field' }
  if (status.status !== 'done') return { ok: true, detail: `not done yet (${status.status})` }
  const cost = status.cost
  if (!cost || typeof cost.modelCalls !== 'number') return { ok: false, detail: `cost is ${JSON.stringify(cost)}` }
  const tools = status.tools
  if (!tools || typeof tools.calls !== 'number' || !Array.isArray(tools.tools)) return { ok: false, detail: 'status has no tool summary' }
  return { ok: true, detail: `${cost.modelCalls} model calls, ${tools.calls} tool calls` }
}

/** Structured refusals: a code a caller can branch on, plus a way forward. */
export function gradeStructured({ refusal, code }) {
  if (!refusal || refusal.ok !== false) return { ok: false, detail: 'call unexpectedly succeeded' }
  if (refusal.code !== code) return { ok: false, detail: `expected ${code}, got ${refusal.code}` }
  if (typeof refusal.reason !== 'string' || !refusal.reason) return { ok: false, detail: 'no human reason' }
  return { ok: true, detail: `${refusal.code}${refusal.retryable ? ' (retryable)' : ''}` }
}
