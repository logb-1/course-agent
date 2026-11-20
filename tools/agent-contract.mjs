/**
 * Contract test for the agent surface (P1a step 1).
 *
 * Two things must hold for course-agent to behave like a normal agent tool:
 *   1. the surface is atomic — one verb per tool, no action switch, no aliases;
 *   2. nothing blocks — a run returns a jobId immediately and progress is polled.
 *
 * This test drives the real plugin with a fake Host context and a tiny fixture,
 * so it runs offline (no model, no Bilibili) and fails loudly on regressions.
 *
 *   node tools/agent-contract.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const EXPECTED = [
  'course_health',
  'course_ingest',
  'course_status',
  'course_outline',
  'course_read',
  'course_ask',
  'course_export',
  'course_library',
  'course_cancel',
]

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    console.log(`PASS  ${name}`)
  } else {
    failures += 1
    console.log(`FAIL  ${name}${detail ? `  ${detail}` : ''}`)
  }
}

const root = mkdtempSync(join(tmpdir(), 'course-agent-contract-'))
const dataDir = join(root, 'data')
mkdirSync(dataDir, { recursive: true })

const deck = join(root, '绪论.md')
writeFileSync(
  deck,
  [
    '# 第一章 绪论',
    '计算机系统由硬件与软件组成。',
    '存储器层次结构分为寄存器、缓存、主存与磁盘。',
    '',
    '# 第二章 数据表示',
    '整数采用补码表示，浮点数遵循 IEEE 754 标准。',
    '溢出会截断高位，符号位决定正负。',
  ].join('\n'),
  'utf8',
)

/* ------------------------------ fake host ------------------------------ */

const registered = new Map()
const provided = new Map()
const cleanups = []
const skills = []

const ctx = {
  tools: {
    register(definition) {
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  },
  webServer: { register: () => () => {} },
  logger: { info() {}, warn() {}, error() {} },
  get: (key) =>
    key === 'skills'
      ? {
          register(skill) {
            skills.push(skill)
            return () => {}
          },
        }
      : undefined,
  provide(name, value) {
    provided.set(name, value)
  },
  effect(fn) {
    cleanups.push(fn)
  },
}

const { apply } = await import('../index.js')
await apply(ctx, { dataDir, withVideos: false, reportLevel: 'normal', concurrency: 1, coverage: 'fast' })

/* ------------------------------- surface ------------------------------- */

const names = [...registered.keys()]
check('registers exactly the atomic tool set', names.length === EXPECTED.length && EXPECTED.every((n) => registered.has(n)), names.join(','))
check('old action-switch tool is gone', !registered.has('course_assistant'))

const actionTools = names.filter((name) => {
  const params = registered.get(name)?.parameters?.properties || {}
  return Object.prototype.hasOwnProperty.call(params, 'action')
})
check('no tool takes an action switch', actionTools.length === 0, actionTools.join(','))

check(
  'registers the bundled tutor skill on the global layer',
  skills.length === 1 && skills[0].name === 'course-tutor' && skills[0].content.length > 200 && skills[0].source === 'bundled',
  skills.map((skill) => `${skill.name}:${skill.content.length}`).join(','),
)

check('every tool declares an output schema and a description', names.every((name) => {
  const tool = registered.get(name)
  return !!tool.description && !!tool.output && typeof tool.execute === 'function'
}))

const required = Object.fromEntries(names.map((name) => [name, registered.get(name).parameters.required || []]))
check('jobId-requiring tools require it', ['course_status', 'course_outline', 'course_read', 'course_ask', 'course_export', 'course_cancel']
  .every((name) => required[name].includes('jobId')))
check('course_ingest takes no required params (files are validated at call time)', required.course_ingest.length === 0)

/* -------------------------------- service ------------------------------- */

const service = provided.get('courseAgent')
check('provides courseAgent to other plugins', !!service)
check('service exposes the same 9 verbs', !!service && ['health', 'ingest', 'status', 'outline', 'read', 'ask', 'export', 'library', 'cancel'].every((k) => typeof service[k] === 'function'))

const call = (name, args) => registered.get(name).execute(args)

/* ------------------------------ behaviour ------------------------------ */

const health = await call('course_health', {})
check('health reports ok with limits', health.ok === true && !!health.limits && Array.isArray(health.ocrEngines), JSON.stringify(health).slice(0, 160))

const missing = await call('course_status', { jobId: 'nope' })
check('unknown jobId fails with a reason', missing.ok === false && typeof missing.reason === 'string')

const started = Date.now()
const ingest = await call('course_ingest', { files: [deck], reportLevel: 'normal', withVideos: false })
const elapsed = Date.now() - started
check('ingest returns immediately (no 150 s poll)', ingest.ok === true && typeof ingest.jobId === 'string' && elapsed < 3000, `elapsed=${elapsed}ms`)
check('ingest names the next tool', ingest.ok === true && ingest.next?.tool === 'course_status')

const jobId = ingest.jobId

// wait for the run to settle, then exercise the read path
let status = await call('course_status', { jobId })
const deadline = Date.now() + 20000
while (status.ok && status.status === 'running' && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 200))
  status = await call('course_status', { jobId })
}
check('status reaches a settled state', status.ok === true && ['done', 'error', 'cancelled', 'interrupted'].includes(status.status), status.ok ? status.status : status.reason)
check('status carries reading stats so gaps cannot hide', status.ok === true && (status.reading === null || ['pages', 'withText', 'ocred', 'unreadPages', 'unreadChapters'].every((k) => typeof status.reading[k] === 'number')))

if (status.ok && status.status === 'running') {
  const cancelled = await call('course_cancel', { jobId })
  check('cancel aborts a running job', cancelled.ok === true && cancelled.cancelled === true)
}

const outline = await call('course_outline', { jobId })
check('outline lists chapters without bodies', outline.ok === true && Array.isArray(outline.chapters) && outline.chapters.length >= 1, outline.ok ? '' : outline.reason)
check('outline rows carry page ranges and sizes', outline.ok === true && outline.chapters.every((row) => Array.isArray(row.pages) && typeof row.chars === 'number'))
check('outline rows carry reading stats and a note field', outline.ok === true && outline.chapters.every((row) => row.read && typeof row.read.pages === 'number' && typeof row.read.withText === 'number' && typeof row.note === 'string'))
check('outline reports job-level reading summary', outline.ok === true && (outline.reading === null || typeof outline.reading.pages === 'number'))

if (outline.ok) {
  const first = outline.chapters[0].chapter
  const read = await call('course_read', { jobId, chapter: first, maxChars: 400 })
  check('read returns bounded text with pages', read.ok === true && typeof read.text === 'string' && Array.isArray(read.pages) && read.text.length <= 400, read.ok ? '' : read.reason)
  check('read reports continuation instead of dumping everything', read.ok === true ? (read.truncated ? read.nextOffset > 0 : read.nextOffset === null) : false)

  const asked = await call('course_ask', { jobId, question: '补码 浮点数' })
  check('ask returns cited passages or an explicit miss', asked.ok === true && (asked.answers.length > 0 || typeof asked.hint === 'string'))

  const exported = await call('course_export', { jobId, format: 'md' })
  check('export returns a path and a bounded preview', exported.ok === true && typeof exported.path === 'string' && (exported.preview === undefined || exported.preview.length <= 4000))
}

const library = await call('course_library', { limit: 5 })
check('library lists the new job', library.ok === true && Array.isArray(library.jobs) && library.jobs.some((row) => row.jobId === jobId))

// the report is produced by the run itself; assert it was written where promised
if (status.ok && status.status === 'done' && status.reportPath) {
  let exists = false
  try {
    exists = readFileSync(status.reportPath, 'utf8').length > 0
  } catch {}
  check('done job wrote its report', exists)
}

/* ------------------------------- teardown ------------------------------- */

for (const cleanup of cleanups) {
  try {
    await cleanup()
  } catch {}
}
try {
  rmSync(root, { recursive: true, force: true })
} catch {}

console.log(failures ? `\n${failures} failure(s)` : '\nall contract checks passed')
process.exit(failures ? 1 : 0)
