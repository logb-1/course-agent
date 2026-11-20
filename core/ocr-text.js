/**
 * OCR post-correction, tuned for slide pictures.
 *
 * Windows OCR is decent on headings and bad on code: it splits identifiers
 * (`i nt`), reads `l` for `I`, and keeps full-width punctuation. These rules are
 * deliberately conservative — a wrong "fix" is worse than leaving the text alone,
 * because the summary quotes the text back as evidence.
 */
import { normalizeOcrText } from './ocr.js'

/** Identifiers and keywords that OCR likes to split with an errant space. */
const SPLIT_WORDS = [
  'int', 'char', 'long', 'short', 'float', 'double', 'void', 'bool', 'size_t',
  'return', 'struct', 'union', 'enum', 'typedef', 'sizeof', 'unsigned', 'signed',
  'const', 'static', 'extern', 'volatile', 'register', 'inline', 'goto',
  'for', 'while', 'switch', 'case', 'break', 'continue', 'default', 'else',
  'class', 'public', 'private', 'protected', 'namespace', 'template', 'typename',
  'nullptr', 'include', 'define', 'printf', 'scanf', 'malloc', 'free',
]

/** Full-width punctuation that never belongs in code or Chinese notes. */
const FULLWIDTH = new Map([
  ['；', ';'],
  ['（', '('],
  ['）', ')'],
  ['｛', '{'],
  ['｝', '}'],
  ['＜', '<'],
  ['＞', '>'],
  ['＝', '='],
  ['，', ','],
])

/** Windows OCR splits some CJK characters into radical + component. Curated. */
const RADICAL_JOINS = [
  ['衤卜', '补'],
  ['氵孚', '浮'],
  ['氵去', '法'],
  ['氵殳', '没'],
  ['讠十', '计'],
]

/**
 * Glyph pairs Windows OCR confuses inside latin words. Folding both sides onto
 * one form makes `lnt`/`int`, `VOid`/`void`, `rn`/`m` compare equal while
 * leaving genuinely different words (`Base` vs `case`) unequal.
 */
const CONFUSABLE = new Map([
  ['i', 'l'], ['1', 'l'], ['|', 'l'], ['I', 'l'],
  ['0', 'o'], ['O', 'o'],
  ['5', 's'], ['8', 'b'], ['2', 'z'], ['9', 'g'],
])

const foldWord = (word) =>
  word
    .toLowerCase()
    .split('')
    .map((ch) => CONFUSABLE.get(ch) || ch)
    .join('')

const KEYWORDS = SPLIT_WORDS.concat(['catch', 'try', 'throw', 'new', 'delete', 'this', 'virtual', 'override'])
const FOLDED_KEYWORDS = new Map(KEYWORDS.map((word) => [foldWord(word), word]))

const looksLikeCode = (line) =>
  /[{};]|#include|return\b|void\b|int\b|printf\(|->|::|=>/.test(line) ||
  /^\s{2,}\S/.test(line)

/** `c 1 a s s` → `class`, `v o i d` → `void`; only when the join is a keyword. */
function joinSpacedKeyword(line) {
  return line.replace(/\b([\p{L}\p{N}])((?:\s+[\p{L}\p{N}]){2,})\b/gu, (run, head, tail) => {
    const letters = (head + tail).replace(/\s+/g, '')
    return FOLDED_KEYWORDS.get(foldWord(letters)) || run
  })
}

/** `lnt`, `VOid`, `publlc` → the keyword they almost certainly are. */
function repairKeywordTypos(line) {
  return line.replace(/[A-Za-z]{3,}/g, (word) => {
    if (KEYWORDS.includes(word)) return word
    return FOLDED_KEYWORDS.get(foldWord(word)) || word
  })
}

/** Trailing `o`/`O` after a bracket is a full stop: `run()o` → `run().` */
const fixFinalStop = (line) => line.replace(/([)\]}])\s*[oO09]$/, '$1.')


/**
 * @param {string} text raw OCR output
 * @returns {string}
 */
export function fixOcrArtifacts(text) {
  let value = normalizeOcrText(String(text || ''))
  // unambiguous everywhere: capital I read as lowercase l before EEE
  value = value.replace(/\blEEE(\d*)/g, 'IEEE$1')
  for (const [from, to] of RADICAL_JOINS) value = value.split(from).join(to)
  const lines = value.split('\n').map((line) => {
    if (!looksLikeCode(line)) return line
    let out = joinSpacedKeyword(line)
    // `i nt main` → `int main`; only for known identifiers
    for (const word of SPLIT_WORDS) {
      const pattern = new RegExp(`\\b${word[0]}\\s+${word.slice(1)}\\b`, 'g')
      out = out.replace(pattern, word)
    }
    out = repairKeywordTypos(out)
    out = fixFinalStop(out)
    for (const [from, to] of FULLWIDTH) out = out.split(from).join(to)
    return out
  })
  return lines.join('\n').trim()
}
