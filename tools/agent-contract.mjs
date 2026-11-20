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

/* ---------------------------- scope narrowing --------------------------- */

const service0 = provided.get('courseAgent')
check(
  'host registers no course_* tools globally (they belong to the preset scope)',
  registered.size === 0,
  [...registered.keys()].join(','),
)
check('service exposes registerTools for the preset scope', typeof service0?.registerTools === 'function')

// The preset calls this from its own fiber; here we emulate that call.
const disposers = service0?.registerTools?.(ctx) || []
check('registerTools returns disposers', Array.isArray(disposers) && disposers.length === 9, String(disposers.length))

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

// The same request twice is one job: a model that missed the answer must not
// pay for a second course.
const again = await call('course_ingest', { files: [deck], reportLevel: 'normal', withVideos: false })
check('the same files twice reuse the same job', again.ok === true && again.jobId === jobId && again.reused === true, JSON.stringify(again).slice(0, 200))

// A costly level is a user decision, so the tool must refuse without consent.
const costly = await call('course_ingest', { files: [deck], reportLevel: 'max', withVideos: false })
check('max without confirm is refused, not merely hinted', costly.ok === false && costly.code === 'needs_confirm' && typeof costly.hint === 'string')
check('a refused expensive run creates no job', (await call('course_library', { limit: 20 })).jobs.filter((row) => row.courseTitle || row.id).length >= 1 && !('jobId' in costly))

const missingExport = await call('course_export', { jobId: 'no-such-job', format: 'csv' })
check('export of an unknown job is a structured refusal', missingExport.ok === false && missingExport.code === 'job_not_found' && typeof missingExport.hint === 'string')

// wait for the run to settle, then exercise the read path
let status = await call('course_status', { jobId })
const deadline = Date.now() + 20000
while (status.ok && status.status === 'running' && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 200))
  status = await call('course_status', { jobId })
}
check('status reaches a settled state', status.ok === true && ['done', 'error', 'cancelled', 'interrupted'].includes(status.status), status.ok ? status.status : status.reason)
check('status carries reading stats so gaps cannot hide', status.ok === true && (status.reading === null || ['pages', 'withText', 'ocred', 'unreadPages', 'unreadChapters'].every((k) => typeof status.reading[k] === 'number')))
check('status reports what the run cost and called', status.ok === true && 'cost' in status && typeof status.tools?.calls === 'number', JSON.stringify(status.tools || null).slice(0, 120))

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

/* ----------------------------- preset realm ----------------------------- */

// The narrowing only holds if the preset half actually registers the tools when
// it is mounted — otherwise "not global" would mean "nowhere".
registered.clear()
const presetCleanups = []
const presetCtx = {
  tools: ctx.tools,
  logger: ctx.logger,
  get: (key) => (key === 'courseAgent' ? service0 : undefined),
  inject(deps, callback) {
    if (deps.includes('courseAgent')) callback(presetCtx)
  },
  effect(fn) {
    presetCleanups.push(fn)
  },
}
try {
  const tutor = await import('../preset/tutor.js')
  tutor.apply(presetCtx)
  check(
    'mounted preset registers the nine tools in its own scope',
    EXPECTED.every((name) => registered.has(name)),
    [...registered.keys()].join(','),
  )
  // unloading the preset must take its tools with it
  for (const cleanup of presetCleanups) {
    const disposer = cleanup()
    await disposer?.()
  }
  check('unloading the preset removes its tools', registered.size === 0, [...registered.keys()].join(','))
} catch (error) {
  check('mounted preset registers the nine tools in its own scope', false, String(error?.message || error))
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
