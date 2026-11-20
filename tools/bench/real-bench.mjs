#!/usr/bin/env node
/**
 * Real-courseware OCR benchmark against the PDF's own text layer.
 *
 * Synthetic fixtures (ocr-bench.mjs) prove a rule works on text we drew
 * ourselves; they cannot tell us whether the reader is good enough for the
 * courseware people actually feed this plugin. A PDF that *has* a text layer is
 * the ideal ground truth: render its pages, OCR them, and compare the result
 * with what the page really says.
 *
 *   node tools/bench/real-bench.mjs --pdf "C:/path/deck.pdf"
 *   node tools/bench/real-bench.mjs --pdf deck.pdf --pages 1,2,3 --width 1600
 *   node tools/bench/real-bench.mjs --pdf deck.pdf --nomerge     # A/B the merge
 *
 * CER is computed on characters with whitespace removed: OCR spacing is the
 * least interesting thing it gets wrong, and character errors are what corrupt
 * summaries.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const argOf = (name, fallback = '') => {
  const argv = process.argv.slice(2)
  const index = argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = argv[index + 1]
  return value && !value.startsWith('--') ? value : fallback
}
const has = (name) => process.argv.includes(`--${name}`)

const pdf = argOf('pdf')
if (!pdf || !existsSync(pdf)) {
  console.error('用法：node tools/bench/real-bench.mjs --pdf <带文本层的 PDF> [--pages 1,2,3] [--width 1600] [--nomerge] [--maxChars 1200]')
  process.exit(2)
}

const tag = argOf('tag', 'real')
const width = argOf('width', '') === '' ? undefined : Number(argOf('width'))
const merge = !has('nomerge')
const maxChars = Number(argOf('maxChars', '1200')) || 1200
const wanted = String(argOf('pages', '')).split(',').map((token) => Number(token.trim())).filter((n) => Number.isInteger(n) && n > 0)

const { parsePdf } = await import(pathToFileURL(join(ROOT, 'core', 'pdf.js')).href)
const { ocrPdfDeep } = await import(pathToFileURL(join(ROOT, 'core', 'ocr.js')).href)
const { cerOf } = await import(pathToFileURL(join(ROOT, 'tools', 'bench', 'cer.js')).href)

const parsed = parsePdf(readFileSync(pdf))
const truth = new Map(parsed.pages.map((page) => [page.index, page.text || '']))
const pages = wanted.length ? wanted : parsed.pages.slice(0, 3).map((page) => page.index)

console.log(JSON.stringify({ pdf: basename(pdf), bytes: statSync(pdf).size, textPages: parsed.pages.length, pages }))

const started = Date.now()
const { pages: read, stats } = await ocrPdfDeep(pdf, {
  engine: 'windows',
  pages,
  maxPages: pages.length,
  width,
  ...(merge ? {} : { langMerge: 'off' }),
})

const rows = []
for (const page of read) {
  const expected = truth.get(page.index) || ''
  if (!expected.trim()) continue
  const result = cerOf(expected, page.text, { maxChars })
  rows.push({ page: page.index, chars: result.expectedChars, cer: result.cer, score: result.score })
  console.log(
    `${String(page.index).padStart(3)}  CER ${(result.cer * 100).toFixed(1).padStart(5)}%  score ${result.score.toFixed(2)}  chars ${result.matchedChars}/${result.expectedChars}`,
  )
  if (has('show')) {
    console.log(`--- page ${page.index} ---`)
    console.log(page.text.slice(0, 600))
  }
}

const mean = rows.length ? rows.reduce((sum, row) => sum + row.cer, 0) / rows.length : 0
console.log(`\nmean CER ${(mean * 100).toFixed(1)}%  (${rows.length} real pages, ${Date.now() - started}ms, tag=${tag})`)

const dir = join(tmpdir(), 'ocr-bench')
mkdirSync(dir, { recursive: true })
const file = join(dir, 'results-real.json')
if (!existsSync(file)) writeFileSync(file, '[]\n')
const record = {
  at: new Date().toISOString(),
  tag: `${tag}${merge ? '' : '-nomerge'}${width === undefined ? '' : `@${width}`}`,
  pdf: basename(pdf),
  pages: rows.map((row) => row.page),
  mean,
  rows,
  stats,
}
appendFileSync(file, JSON.stringify(record) + '\n')
console.log(`saved ${file}`)
