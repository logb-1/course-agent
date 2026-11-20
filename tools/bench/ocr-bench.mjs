/**
 * OCR accuracy benchmark.
 *
 * Ground truth lives here; pages are *drawn* to images and wrapped in image-only
 * PDFs, so the text layer cannot help the engine. That is the only way to tell
 * "the engine got better" from "the PDF had a text layer".
 *
 *   node tools/bench/ocr-bench.mjs [--tag before] [--pages dark,light,scan]
 *
 * Results are printed as CER (character error rate over non-space characters)
 * and appended to tools/bench/results.json so two runs can be compared.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')

const FIXTURES = [
  {
    id: 'light',
    width: 1280,
    height: 720,
    margin: 64,
    quality: 92,
    lines: [
      { text: '第 3 章 面向对象编程', size: 34, bold: true },
      { text: '类的成员函数可以访问私有成员；构造函数在对象创建时自动调用。', size: 22 },
      { text: '虚函数通过 vtable 实现动态绑定，析构函数应声明为 virtual。', size: 22 },
      { text: 'int main() { return 0; }', size: 22, mono: true },
      { text: 'x = (-b ± sqrt(b*b - 4*a*c)) / (2*a)', size: 22, mono: true },
      { text: '圆周率取 3.14159，黄金分割约 0.618，时间复杂度 O(n log n)。', size: 22 },
      { text: '引用与指针：int& r = a; int* p = &a;', size: 22, mono: true },
    ],
  },
  {
    id: 'dark',
    width: 1280,
    height: 720,
    margin: 64,
    dark: true,
    quality: 92,
    lines: [
      { text: '第 4 章 虚函数与多态', size: 34, bold: true },
      { text: '派生类重写基类的虚函数后，通过基类指针调用会走到派生类实现。', size: 22 },
      { text: 'class Base { public: virtual void run(); };', size: 22, mono: true },
      { text: 'sizeof(Base) 在 64 位下为 8 字节（仅一个 vptr）。', size: 22 },
      { text: '纯虚函数写法：virtual void draw() = 0;', size: 22, mono: true },
    ],
  },
  {
    id: 'scan',
    width: 1654,
    height: 2339,
    margin: 120,
    quality: 72,
    lines: [
      { text: '实验三 函数式编程与面向对象', size: 40, bold: true },
      { text: '1. 定义函数 add(a, b) 返回两数之和，并用 map 与 reduce 组合。', size: 28 },
      { text: '2. 不可变数据：元组 (1, 2, 3) 不能修改，列表 [1, 2, 3] 可以。', size: 28 },
      { text: '3. 柯里化：f(x)(y) 等价于 f(x, y)，注意闭包捕获的是引用。', size: 28 },
      { text: '4. 递归深度限制 1000；尾递归在 Python 中并不优化。', size: 28 },
      { text: '5. 结果输出：sum = 55，平均值 5.5，方差 8.25。', size: 28 },
    ],
  },
]

const argOf = (flag, fallback) => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : fallback
}

const tag = argOf('--tag', 'run')
const only = String(argOf('--pages', '')).split(',').filter(Boolean)
const width = argOf('--width', '') === '' ? undefined : Number(argOf('--width'))
const merge = !process.argv.includes('--nomerge')

function normalized(text) {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[，。；：、（）【】“”‘’—…·]/g, '')
    .toLowerCase()
}

function cer(truth, guess) {
  const a = [...normalized(truth)]
  const b = [...normalized(guess)]
  if (!a.length) return b.length ? 1 : 0
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
  return prev[b.length] / a.length
}

async function buildPdf(pngPath, outPath) {
  const PDFDocument = (await import('pdfkit')).default
  const doc = new PDFDocument({ autoFirstPage: false })
  const chunks = []
  doc.on('data', (chunk) => chunks.push(chunk))
  const done = new Promise((resolve) => doc.on('end', resolve))
  doc.addPage({ size: [readPngSize(pngPath).width, readPngSize(pngPath).height], margin: 0 })
  doc.image(pngPath, 0, 0, { width: readPngSize(pngPath).width, height: readPngSize(pngPath).height })
  doc.end()
  await done
  writeFileSync(outPath, Buffer.concat(chunks))
}

function readPngSize(path) {
  const buf = readFileSync(path)
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

const work = join(tmpdir(), 'ocr-bench')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const spec = {
  pages: FIXTURES.filter((f) => !only.length || only.includes(f.id)).map((f) => ({
    name: `${f.id}.png`,
    width: f.width,
    height: f.height,
    margin: f.margin,
    dark: !!f.dark,
    quality: f.quality,
    lines: f.lines,
  })),
}
writeFileSync(join(work, 'spec.json'), JSON.stringify(spec))

const outDir = join(work, 'images')
const std = execFileSync('powershell.exe', [
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-File',
  join(HERE, 'draw-pages.ps1'),
  '-Spec',
  join(work, 'spec.json'),
  '-OutDir',
  outDir,
], { encoding: 'utf8' })
if (process.env.DEBUG) console.log(std)

const { ocrPdfDeep } = await import(pathToFileURL(join(ROOT, 'core', 'ocr.js')).href)
const rows = []
for (const fixture of FIXTURES.filter((f) => !only.length || only.includes(f.id))) {
  const png = join(outDir, `${fixture.id}.png`)
  if (!existsSync(png)) {
    console.log(`SKIP ${fixture.id}: image not drawn`)
    continue
  }
  const pdf = join(work, `${fixture.id}.pdf`)
  await buildPdf(png, pdf)
  const truth = fixture.lines.map((l) => l.text).join('\n')
  const started = Date.now()
  const { pages, stats } = await ocrPdfDeep(pdf, { engine: 'windows', pages: [1], maxPages: 1, width, langMerge: merge ? 'auto' : 'off' })
  const text = pages.map((p) => p.text).join('\n')
  const elapsed = Date.now() - started
  const { scoreText } = await import(pathToFileURL(join(ROOT, 'core', 'ocr-score.js')).href)
  const row = {
    tag: `${tag}${width === undefined ? '' : `@${width}`}${merge ? '' : '-nomerge'}`,
    id: fixture.id,
    cer: Number(cer(truth, text).toFixed(4)),
    score: scoreText(text).score,
    charsTruth: normalized(truth).length,
    charsOcr: normalized(text).length,
    ms: elapsed,
    stats,
  }
  rows.push(row)
  console.log(
    `${row.id.padEnd(6)} CER ${(row.cer * 100).toFixed(1).padStart(5)}%  score ${row.score}  chars ${row.charsOcr}/${row.charsTruth}  ${elapsed}ms`,
  )
  if (process.env.DEBUG) console.log(`--- ${fixture.id} ---\n${text}\n`)
}

const resultsFile = join(HERE, 'results.json')
const history = existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, 'utf8')) : []
writeFileSync(resultsFile, JSON.stringify([...history, ...rows], null, 2))
console.log(`\nmean CER ${(rows.reduce((s, r) => s + r.cer, 0) / Math.max(1, rows.length) * 100).toFixed(1)}%  (${rows.length} pages, tag=${tag})`)
