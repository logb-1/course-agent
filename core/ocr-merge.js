/**
 * Line-level merge of two OCR passes over the same page.
 *
 * Windows OCR has one language per pass, and the two are good at opposite
 * things: `zh-CN` reads Chinese prose but shreds code into `c 1 a s s B a s e`,
 * while `en-US` reads `class Base { public: virtual void run(); }` exactly and
 * drops Chinese lines entirely. Picking a page-level winner therefore loses
 * either the prose or the code; picking a line-level winner loses neither.
 *
 * Alignment uses the word bounding boxes WinRT reports, so a line only competes
 * with lines that sit on top of it. Everything here is heuristic and additive:
 * when the second pass is unavailable or disagrees weakly, the first pass text
 * survives untouched.
 */
import { scoreText } from './ocr-score.js'
import { normalizeOcrText } from './ocr.js'

const LATIN = /[A-Za-z]/g
const CODEISH = /[{}();=<>+\-*/&|[\]]/
const SPACED_CJK = /[\u3400-\u9fff]\s+[\u3400-\u9fff]/
const SINGLE_TOKEN = /(?:^|\s)[A-Za-z](?=\s|$)/g

const count = (text, pattern) => (String(text).match(pattern) || []).length

/**
 * Line quality on the axes that separate a good read from a shredded one.
 * `scoreText` already covers gibberish; the extras punish what it tolerates:
 * letter-by-letter splits, spaced-out CJK, and lines that lost all punctuation.
 */
export function lineQuality(text) {
  const value = String(text || '')
  const letters = count(value, LATIN)
  const visible = value.replace(/\s/g, '').length || 1
  let score = scoreText(value).score
  score -= Math.min(0.36, 0.12 * count(value, SINGLE_TOKEN))
  if (SPACED_CJK.test(value)) score -= 0.15
  if (CODEISH.test(value)) score += 0.1
  score += 0.2 * Math.min(1, letters / visible)
  return Math.max(0, Math.min(1.5, score))
}

/** Does this page hold enough Latin text that a second pass could pay off? */
export function wantsLatinPass(pages) {
  const rows = Array.isArray(pages) ? pages : [pages]
  for (const page of rows) {
    const text = String(page?.text || '')
    const letters = count(text, LATIN)
    if (letters < 12) continue
    const visible = text.replace(/\s/g, '').length || 1
    if (letters / visible > 0.15) return true
  }
  return false
}

const CJK = /[\u3400-\u9fff]/g

const latinRatio = (text) => {
  const value = String(text || '')
  const visible = value.replace(/\s/g, '').length || 1
  return count(value, LATIN) / visible
}

/**
 * A Latin-pass line may replace a primary line only when it is convincing on
 * its own terms: mostly Latin, and it did not *lose* Chinese characters the
 * primary line read. Otherwise `en-US` happily turns `：` into `.` and drops
 * characters out of Chinese prose, which is exactly how a "merge" makes
 * accuracy worse.
 */
function acceptable(row, candidate) {
  if (latinRatio(candidate.text) < 0.6) return false
  if (count(candidate.text, CJK) < count(row.text, CJK)) return false
  if (candidate.text.replace(/\s/g, '').length < row.text.replace(/\s/g, '').length * 0.7) return false
  return true
}

const center = (line) => line.y + line.h / 2

/** Same visual row: vertical centres close, horizontal spans mostly shared. */
function onSameRow(a, b) {
  const tolerance = Math.max(6, Math.min(a.h, b.h) * 0.6)
  if (Math.abs(center(a) - center(b)) > tolerance) return false
  const left = Math.max(a.x, b.x)
  const right = Math.min(a.x + a.w, b.x + b.w)
  if (right <= left) return false
  const shared = right - left
  return shared / Math.max(1, Math.min(a.w, b.w)) >= 0.3
}

/**
 * @param {{lines?:Array<{text:string,x:number,y:number,w:number,h:number}>}} primary
 * @param {{lines?:Array<{text:string,x:number,y:number,w:number,h:number}>}} alternative
 * @returns {{text:string, replaced:number}}
 */
export function mergeLines(primary, alternative) {
  const rows = primary?.lines
  const other = alternative?.lines
  if (!Array.isArray(rows) || !rows.length) return { text: String(primary?.text || ''), replaced: 0 }
  if (!Array.isArray(other) || !other.length) return { text: String(primary?.text || ''), replaced: 0 }

  const claimed = new Set()
  let replaced = 0
  const merged = rows.map((row) => {
    const latin = count(row.text, LATIN)
    if (latin < 3) return row.text
    if (latinRatio(row.text) < 0.25 && !CODEISH.test(row.text)) return row.text
    let best = null
    for (const [index, candidate] of other.entries()) {
      if (claimed.has(index) || !onSameRow(row, candidate) || !acceptable(row, candidate)) continue
      const quality = lineQuality(candidate.text)
      if (!best || quality > best.quality) best = { index, quality, text: candidate.text }
    }
    if (!best) return row.text
    if (best.quality <= lineQuality(row.text) + 0.1) return row.text
    claimed.add(best.index)
    replaced += 1
    return best.text
  })
  return { text: normalizeOcrText(merged.join('\n')), replaced }
}
