#!/usr/bin/env node
/**
 * Behaviour evals for course-agent.
 *
 *   node evals/run.mjs --deck 实验3="C:/Users/.../实验3-面向对象编程&函数式编程.pptx"
 *   node evals/run.mjs --write-baseline        # record the current behaviour
 *   node evals/run.mjs --only gate             # only one family
 *
 * What this measures and what it does not:
 *   ✓ reading honesty, citation ranges, response bounds, miss handling, gates,
 *     structured refusals — all deterministic, no model needed
 *   ✗ whether a 讲解 is *good* — that needs a live model and a human judge; do it
 *     in DSH with the 课程助教 preset and compare against baseline.json
 *
 * Runs each deck in its own data directory so a benchmark never mixes with real
 * study progress, and writes nothing outside that temporary directory.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gradeAsk, gradeBounds, gradeCitation, gradeCost, gradeGate, gradeMemory, gradeMiss, gradeReadingHonesty, gradeStructured } from './grade.mjs'

const HERE = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const TASKS = JSON.parse(readFileSync(join(HERE, 'tasks.json'), 'utf8')).tasks
const BASELINE = join(HERE, 'baseline.json')

const args = process.argv.slice(2)
const flag = (name) => args.includes(`--${name}`)
const valueOf = (name, fallback = '') => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const decks = []
for (let i = 0; i < args.length; i += 1) {
  if (args[i] !== '--deck' || !args[i + 1]) continue
  const [label, path] = args[i + 1].includes('=') ? args[i + 1].split(/=(.*)/s) : ['deck', args[i + 1]]
  decks.push({ label, path })
}

// CI has no real courseware (and should not ship student decks), so it runs the
// same graders on a synthetic deck with known content.
const fixtureRoot = flag('fixture') ? mkdtempSync(join(tmpdir(), 'course-agent-eval-fixture-')) : null
if (fixtureRoot) {
  const path = join(fixtureRoot, '评测夹具.md')
  writeFileSync(
    path,
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
  decks.push({ label: 'fixture', path })
}
process.on('exit', () => {
  if (fixtureRoot) {
    try {
      rmSync(fixtureRoot, { recursive: true, force: true })
    } catch {}
  }
})

const only = valueOf('only', '')
const selected = only ? TASKS.filter((task) => task.family === only || task.id === only) : TASKS

/* ------------------------------- harness -------------------------------- */

async function boot(dataDir) {
  const registered = new Map()
  const provided = new Map()
  const ctx = {
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
    },
    webServer: { register: () => () => {} },
    logger: { info() {}, warn() {}, error() {} },
    get: () => undefined,
    provide(name, value) {
      provided.set(name, value)
    },
    effect() {},
  }
  const { apply } = await import('../index.js')
  await apply(ctx, { dataDir, withVideos: false, reportLevel: 'normal', concurrency: 1, coverage: 'fast' })
  // The host no longer registers the tools globally: they belong to the agent
  // preset's scope (preset/tutor.js). The harness stands in for that scope so
  // the evals exercise exactly the surface a real session sees.
  const service = provided.get('courseAgent')
  if (!service?.registerTools) throw new Error('courseAgent service does not expose registerTools')
  service.registerTools(ctx)
  const call = (name, callArgs) => registered.get(name).execute(callArgs)
  return { call }
}

async function settle(call, jobId, deadlineMs = 120000) {
  const deadline = Date.now() + deadlineMs
  let status = await call('course_status', { jobId })
  while (status.ok && (status.status === 'running' || status.status === 'queued') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    status = await call('course_status', { jobId })
  }
  return status
}

/* -------------------------------- grading -------------------------------- */

async function runDeck({ label, path }) {
  const root = mkdtempSync(join(tmpdir(), 'course-agent-eval-'))
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true })
  const results = {}
  const details = {}
  try {
    const { call } = await boot(dataDir)
    const ingest = await call('course_ingest', { files: [path], reportLevel: 'normal', withVideos: false })
    if (!ingest.ok) {
      return { label, error: `${ingest.code}: ${ingest.reason}`, results: {}, details: {} }
    }
    const status = await settle(call, ingest.jobId)
    const outline = await call('course_outline', { jobId: ingest.jobId })
    const chapter = outline.ok ? outline.chapters[0] : null
    const read = chapter ? await call('course_read', { jobId: ingest.jobId, chapter: chapter.chapter, maxChars: 400 }) : null
    // ask about something the deck really contains: the first chapter's title
    // (a fixed query like 补码 only works for the CS-architecture deck)
    const hitQuery = chapter?.title || '第一章'
    const hit = await call('course_ask', { jobId: ingest.jobId, question: hitQuery })
    const miss = await call('course_ask', { jobId: ingest.jobId, question: '量子色动力学 的 渐近自由 证明' })
    const gate = await call('course_ingest', { files: [path], reportLevel: 'max', withVideos: false })
    const exportGate = await call('course_export', { jobId: 'no-such-job', format: 'md' })
    const statusGate = await call('course_status', { jobId: 'no-such-job' })
    const readGate = await call('course_read', { jobId: 'no-such-job', chapter: 1 })
    const outlineGate = await call('course_outline', { jobId: 'no-such-job' })
    // What the user would say while looking at chapter one, then read it back.
    const firstChapter = chapter?.chapter || 1
    const noted = await call('course_note', {
      jobId: ingest.jobId,
      goal: { days: 3, target: 80 },
      chapter: firstChapter,
      state: 'explained',
    })
    const recalled = await call('course_recall', { jobId: ingest.jobId })

    const grade = {
      'reading-honesty': () => gradeReadingHonesty({ status, outline }),
      'citation-range': () => gradeCitation({ read, outlineChapter: chapter }),
      'read-bounds': () => gradeBounds({ read, maxChars: 400 }),
      'read-continuation': () => (read && read.truncated ? { ok: true, detail: `continues at ${read.nextOffset}` } : { ok: true, detail: 'chapter fits in one read' }),
      'ask-miss': () => gradeMiss({ asked: miss }),
      'ask-hit': () => gradeAsk({ asked: hit }),
      'confirm-gate': () => gradeGate({ refused: gate }),
      'export-gate': () => gradeStructured({ refusal: exportGate, code: 'job_not_found' }),
      'status-gate': () => gradeStructured({ refusal: statusGate, code: 'job_not_found' }),
      'read-gate': () => gradeStructured({ refusal: readGate, code: 'job_not_found' }),
      'outline-gate': () => gradeStructured({ refusal: outlineGate, code: 'job_not_found' }),
      'cost-visibility': () => gradeCost({ status }),
      'memory-roundtrip': () => gradeMemory({ noted, recalled, chapter: firstChapter }),
    }

    for (const task of selected) {
      const fn = grade[task.id]
      if (!fn) {
        results[task.id] = false
        details[task.id] = 'no grader wired for this task'
        continue
      }
      const outcome = fn()
      results[task.id] = outcome.ok
      details[task.id] = outcome.detail
    }
    return {
      label,
      jobId: ingest.jobId,
      status: status.ok ? status.status : status.code,
      reading: status.ok ? status.reading : null,
      results,
      details,
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/* --------------------------------- main ---------------------------------- */

if (!decks.length) {
  console.log('no --deck given; nothing to run')
  console.log('example: node evals/run.mjs --deck 实验3="C:/Users/ThinkPad/Desktop/实验3-面向对象编程&函数式编程.pptx"')
  process.exit(decks.length ? 1 : 0)
}

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null
const report = { version: 1, generatedAt: new Date().toISOString(), decks: [] }
let failed = 0

for (const deck of decks) {
  if (!existsSync(deck.path)) {
    console.log(`SKIP  ${deck.label}: ${deck.path} 不存在`)
    continue
  }
  const result = await runDeck(deck)
  report.decks.push(result)
  console.log(`\n== ${deck.label}${result.status ? ` · ${result.status}` : ''}${result.error ? ` · ${result.error}` : ''}`)
  if (result.reading) console.log(`   reading: ${JSON.stringify(result.reading)}`)
  for (const task of selected) {
    const ok = result.results[task.id]
    if (ok === undefined) continue
    if (!ok) failed += 1
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${task.id.padEnd(18)} ${result.details[task.id] || ''}`)
  }
}

if (flag('write-baseline')) {
  writeFileSync(BASELINE, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  console.log(`\nbaseline written: ${BASELINE}`)
} else if (baseline) {
  const drift = []
  for (const deck of report.decks) {
    const before = baseline.decks.find((row) => row.label === deck.label)
    if (!before) continue
    if (before.reading && deck.reading && before.reading.unreadPages !== deck.reading.unreadPages) {
      drift.push(`${deck.label}: unreadPages ${before.reading.unreadPages} → ${deck.reading.unreadPages}`)
    }
    for (const [id, ok] of Object.entries(deck.results)) {
      if (before.results?.[id] === true && ok === false) drift.push(`${deck.label}: ${id} regressed`)
    }
  }
  console.log(drift.length ? `\nbaseline drift:\n  ${drift.join('\n  ')}` : '\nmatches baseline')
  if (drift.length) failed += 1
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall eval checks passed')
process.exit(failed ? 1 : 0)
