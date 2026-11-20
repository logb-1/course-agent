/**
 * Character error rate, shared by both OCR benchmarks.
 *
 * Whitespace and full-width punctuation are dropped before comparing: OCR
 * spacing and `，`/`,` choices are the least interesting thing it gets wrong,
 * and counting them hides whether the *words* survived.
 */

export function normalizedForCer(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[，。；：、（）【】“”‘’—…·]/g, '')
    .toLowerCase()
}

/**
 * @param {string} truth expected text
 * @param {string} guess OCR text
 * @param {{maxChars?:number}} [options] compare only the first N expected chars
 * @returns {{cer:number, score:number, expectedChars:number, matchedChars:number}}
 */
export function cerOf(truth, guess, options = {}) {
  const limit = Math.max(0, Number(options.maxChars) || 0)
  const expected = limit ? [...normalizedForCer(truth)].slice(0, limit).join('') : normalizedForCer(truth)
  const actual = limit ? [...normalizedForCer(guess)].slice(0, Math.ceil(limit * 2)).join('') : normalizedForCer(guess)
  const a = [...expected]
  const b = [...actual]
  if (!a.length) return { cer: b.length ? 1 : 0, score: b.length ? 0 : 1, expectedChars: 0, matchedChars: 0 }
  let prev = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j += 1) prev[j] = j
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i]
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = cur
  }
  const distance = prev[b.length]
  const cer = distance / a.length
  return { cer, score: Math.max(0, 1 - cer), expectedChars: a.length, matchedChars: Math.max(0, a.length - distance) }
}
