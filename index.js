/**
 * Host half of course-agent.
 *
 * Responsibilities:
 *   • same-origin HTTP routes the panel calls (upload / run / poll / report)
 *   • one agent tool sharing the exact same pipeline
 *   • no state outside this machine: uploads, cache and reports live under
 *     `<DSH_HOME>/course-agent` (config `dataDir` overrides it)
 *
 * The model is reached through the Host `llm` service, so the plugin uses the
 * profile's configured provider/model and never needs an API key of its own.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Schema from 'schemastery'
import { createStore, resolveDataDir } from './core/store.js'
import { createBiliClient } from './core/bili.js'
import { runPipeline, rerunChapter } from './core/pipeline.js'
import { ocrAvailable, ocrStatus } from './core/ocr.js'
import { pointText } from './core/verify.js'
import { ask, indexFromPassages } from './core/search.js'
import { coverage, parseSyllabus } from './core/coverage.js'
import { parseFile } from './core/parser.js'
import { markdownToDocx } from './core/docx.js'
import { SUPPORTED } from './core/parser.js'
import { resolveLevel, resolveSprint, styleOfLevel } from './core/report-level.js'
import { LIMITS, libraryView, outlineView, previewOf, readView, statusView } from './core/agent-view.js'
import { registerCourseTools } from './core/agent-tools.js'
import { CODES, failure } from './core/error.js'
import { checkExport, checkLevel, ingestKey, reusableJob } from './core/guards.js'
import { appendTrace, argsHash, readTrace, summarizeTrace, tracePathOf } from './core/trace.js'

const HERE = join(fileURLToPath(new URL('.', import.meta.url)))
const PDF_FONT = join(HERE, 'assets', 'fonts', 'NotoSansSC-Regular.ttf')
const PKG = (() => {
  try {
    return JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
  } catch {
    return { version: String(0) }
  }
})()
const SKILL_DIR = join(HERE, 'skills', 'course-tutor')
const SKILL_FILE = join(SKILL_DIR, 'SKILL.md')

/** Split `---` frontmatter from the body without pulling in a YAML dependency. */
function parseSkill(markdown) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(markdown)
  if (!match) return { meta: {}, content: markdown.trim() }
  const meta = {}
  for (const line of match[1].split(/\r?\n/)) {
    const at = line.indexOf(':')
    if (at > 0) {
      const value = line.slice(at + 1).trim().replace(/^['"]|['"]$/g, '')
      meta[line.slice(0, at).trim()] = value
    }
  }
  return { meta, content: markdown.slice(match[0].length).trim() }
}

/**
 * Register the bundled skill on the host's global skill layer. The preset then
 * needs no path into this checkout, and every agent — preset or plain — sees it.
 */
function registerTutorSkill(ctx) {
  const skills = ctx.get?.('skills')
  if (!skills?.register) return null
  const { meta, content } = parseSkill(readFileSync(SKILL_FILE, 'utf8'))
  return skills.register({
    name: meta.name || 'course-tutor',
    description: meta.description || '课程 agent 的工作流：建档、目录、按章讲解、出题判分、排期。',
    ...(meta.whenToUse ? { whenToUse: meta.whenToUse } : {}),
    content,
    source: 'bundled',
    resourceBase: { kind: 'directory', path: SKILL_DIR },
  })
}

export const name = 'course-agent'
export const inject = ['tools', 'webServer']

/**
 * Every knob the panel and the tool read, validated at activation. A bad value
 * fails the plugin loudly instead of starting half-configured.
 * Precedence for every field: request option > this config > built-in default.
 */
export const Config = Schema.object({
  dataDir: Schema.string().default('').description('上传/缓存/报告目录，留空用 <DSH_HOME>/course-agent'),
  concurrency: Schema.natural().min(1).max(5).default(4).description('并行章节数'),
  withVideos: Schema.boolean().default(true).description('默认是否检索 B 站网课'),
  images: Schema.string().default('ocr').description('幻灯片图片 OCR：ocr 读取图片文字，off 关闭'),
  imagesMax: Schema.natural().default(40).description('每份课件最多 OCR 的图片数'),
  coverage: Schema.string().default('auto').description('要点覆盖：auto 自动，fast 不分节提示（最省），thorough 逐节摘要（每章最多 4 次调用）'),
  chapterTitles: Schema.union([Schema.const('auto'), Schema.const('rules')])
    .default('auto')
    .description('章标题：auto 允许模型在摘要时顺带给标题（只覆盖启发式章名），rules 只用本地规则'),
  reportLevel: Schema.union([Schema.const('normal'), Schema.const('max'), Schema.const('plus')])
    .default('normal')
    .description('报告能力：normal 要点式；max 复习资料（模块/知识点/实例/习题）；plus 冲刺五册（在 max 基础上按天数排期，输出计划/主册/答案册/速记/刷题五册）'),
  vision: Schema.string().default('').description('多模态模型（预留，留空关闭）'),
  domain: Schema.string().default('').description('强制课程领域（如 C++），留空自动识别'),
  ocrMaxPages: Schema.natural().min(1).max(400).default(60).description('OCR 重读页数上限（页级分诊选出的页，按文档顺序）'),
  ocrMode: Schema.union([Schema.const('auto'), Schema.const('all'), Schema.const('off')])
    .default('auto')
    .description('PDF 页级 OCR：auto 只重读文字层不可用的页，all 整份重读，off 关闭'),
  ocrPick: Schema.union([Schema.const('first'), Schema.const('best')])
    .default('first')
    .description('OCR 引擎择优：first 只用首选引擎，best 对低分页再用第二引擎复读并取高分（耗时翻倍）'),
  ocrLangMerge: Schema.union([Schema.const('auto'), Schema.const('off')])
    .default('auto')
    .description('中文页再用英文引擎读一遍并按行合并：代码和公式更准，耗时约增四成'),
  ocrEngine: Schema.union([Schema.const(''), Schema.const('windows'), Schema.const('rapidocr')])
    .default('')
    .description('OCR 引擎，留空自动选择'),
  ocrPython: Schema.string().default('').description('rapidocr 用的 python 可执行文件'),
  provider: Schema.string().default('').description('摘要模型 provider，留空跟随默认模型'),
  model: Schema.string().default('').description('摘要模型名，留空跟随默认模型'),
  spacingMs: Schema.natural().min(1000).max(60000).default(1000).description('B 站请求间隔（毫秒）'),
  keepUploadsDays: Schema.natural().min(1).max(90).default(7).description('上传文件保留天数'),
})

const ROUTE = '/course-agent'
const MAX_UPLOAD = 60 * 1024 * 1024
const HEARTBEAT_MS = 15_000
const STALE_MS = 90_000
const BOOT_ID = randomUUID()

const csvCell = (value) => `"${String(value ?? '').replace(/\r/g, '').replace(/"/g, '""')}"`

/** Anki: one card per key point, back side carries the chapter, page and quote. */
export function buildAnkiCsv(job) {
  const rows = [['front', 'back', 'tags'].map(csvCell).join(',')]
  const tags = `课程助手 ${job.courseTitle || ''}`.trim()
  for (const chapter of job.chapters || []) {
    for (const point of chapter.summary?.key_points || []) {
      const front = pointText(point)
      if (!front) continue
      const page = point.page ? `（p.${point.page}）` : ''
      const evidence = point.evidence ? `\n原文：${point.evidence}` : ''
      rows.push([csvCell(front), csvCell(`${chapter.title}${page}${evidence}`), csvCell(tags)].join(','))
    }
  }
  // BOM so Excel on Windows reads it as UTF-8; Anki ignores it
  return `\uFEFF${rows.join('\r\n')}\r\n`
}

/** Interop document other plugins can read without parsing the markdown report. */
export function buildCourseJson(job) {
  return JSON.stringify(
    {
      schema: 'course-agent/course@1',
      generatedAt: new Date().toISOString(),
      courseTitle: job.courseTitle || '',
      files: (job.files || []).map((f) => f.name),
      domain: job.domain || null,
      chapters: (job.chapters || []).map((c) => ({
        index: c.index,
        title: c.title,
        pages: c.pages || [],
        keywords: c.summary?.keywords || [],
        confidence: c.confidence?.tier || null,
        keyPoints: (c.summary?.key_points || []).map((p) => ({
          text: pointText(p),
          page: p?.page ?? null,
          evidence: p?.evidence || '',
        })),
        important: c.summary?.important || [],
        difficult: c.summary?.difficult || [],
      })),
    },
    null,
    2,
  )
}

function readBody(req, limit = MAX_UPLOAD) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error(`请求体超过 ${Math.round(limit / 1024 / 1024)}MB 上限`))
        req.destroy?.()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function send(res, code, body, headers = {}) {
  try {
    res.statusCode = code
    res.setHeader('content-type', headers['content-type'] || 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    for (const [k, v] of Object.entries(headers)) {
      if (k !== 'content-type') res.setHeader(k, v)
    }
    // strings (markdown) go out verbatim; objects are JSON-encoded
    const payload = Buffer.isBuffer(body) ? body : typeof body === 'string' ? Buffer.from(body, 'utf8') : JSON.stringify(body)
    res.end(payload)
  } catch {}
}

export function apply(ctx, config = {}) {
  const store = createStore(resolveDataDir(config.dataDir))
  store.pruneUploads(config.keepUploadsDays ?? 7)
  try {
    store.pruneReports(90)
    store.cache.prune(500)
  } catch {}
  const bili = createBiliClient({
    cache: store.cache,
    spacingMs: Number(config.spacingMs) || 1000,
    log: (m) => ctx.logger?.info?.(m),
  })
  const jobs = new Map()
  const jobInputs = new Map()
  const uploads = new Map()
  const disposers = []
  try {
    const disposeSkill = registerTutorSkill(ctx)
    if (disposeSkill) disposers.push(disposeSkill)
  } catch (error) {
    ctx.logger?.warn?.(`[course-agent] skill registration failed: ${error?.message ?? error}`)
  }

  const pick = (value) => (value === '' || value == null ? undefined : value)
  // precedence is the same for every field: request option > config > default
  const optionsOf = (raw = {}) => {
    // both spellings accepted: `reportLevel` is the UI option, `reportStyle` is
    // what saved jobs and cache keys carry (and what 1.13 callers still send)
    const level = resolveLevel(
      pick(raw.reportLevel) || pick(raw.reportStyle),
      resolveLevel(pick(config.reportLevel), 'normal'),
    )
    return {
      withVideos: raw.withVideos !== false && config.withVideos !== false,
      concurrency: Math.max(1, Math.min(5, Number(raw.concurrency) || Number(config.concurrency) || 4)),
      ocr: raw.ocr === true,
      ocrMaxPages: Number(raw.ocrMaxPages) || Number(config.ocrMaxPages) || 60,
      ocrMode: String(pick(raw.ocrMode) || pick(config.ocrMode) || 'auto'),
      ocrPick: String(pick(raw.ocrPick) || pick(config.ocrPick) || 'first'),
      ocrLangMerge: String(pick(raw.ocrLangMerge) || pick(config.ocrLangMerge) || 'auto'),
      ocrEngine: pick(raw.ocrEngine) || pick(config.ocrEngine),
      ocrPython: pick(raw.ocrPython) || pick(config.ocrPython),
      domain: pick(raw.domain) || pick(config.domain),
      images: {
        mode: String(pick(raw.images) || pick(config.images) || 'ocr'),
        max: Number(pick(raw.imagesMax) ?? pick(config.imagesMax) ?? 40) || 40,
        engine: pick(raw.imagesEngine),
      },
      coverage: String(pick(raw.coverage) || pick(config.coverage) || 'auto'),
      chapterTitles: String(pick(raw.chapterTitles) || pick(config.chapterTitles) || 'auto'),
      reportLevel: level,
      reportStyle: styleOfLevel(level),
      // PLUS 的排期参数只影响 sprint；普通档位忽略它们
      sprint: resolveSprint({
        days: pick(raw.days) ?? pick(raw.plusDays),
        target: pick(raw.target) ?? pick(raw.plusTarget),
        minutes: pick(raw.minutes) ?? pick(raw.plusMinutes),
      }),
      vision: pick(raw.vision) || pick(config.vision) || '',
    }
  }

  function resolveLlm() {
    const svc = ctx.get('llm')
    if (!svc) return null
    let provider = pick(config.provider)
    let model = pick(config.model)
    if (!provider || !model) {
      try {
        const sel = ctx.get('agentDefaultModel')?.currentSelection?.()
        provider = provider || sel?.provider
        model = model || sel?.model
      } catch {}
    }
    if (!provider || !model) return null
    return { provider, model, stream: (options) => svc.stream(options) }
  }

  /**
   * .ppt/.doc are OLE compound files our parser does not read. The profile's
   * officeToPdf service converts them to PDF, which we already parse — cheaper
   * and more faithful than writing two more binary parsers.
   */
  const LEGACY_EXT = new Set(['ppt', 'doc', 'xls'])

  async function prepareInputs(inputs) {
    const office = ctx.get('officeToPdf')
    if (!office?.convert) return inputs
    const prepared = []
    for (const input of inputs) {
      const ext = String(input.name || input.path).split('.').pop().toLowerCase()
      if (!LEGACY_EXT.has(ext)) {
        prepared.push(input)
        continue
      }
      try {
        const bytes = readFileSync(input.path)
        const result = await office.convert({
          extension: ext,
          priority: 'foreground',
          source: {
            key: `course-agent:${basename(input.path)}:${bytes.length}`,
            version: String(bytes.length),
            bytes: bytes.length,
            read: async () => ({ bytes, version: String(bytes.length) }),
          },
        })
        const target = join(store.uploadsDir, `${randomUUID().slice(0, 8)}-${basename(input.name).replace(/\.[^.]+$/, '')}.pdf`)
        store.writeBytes(target, Buffer.from(result.pdf))
        // keep the original display name: the report should say "x.ppt", not "x.pdf"
        prepared.push({ ...input, path: target, convertedFrom: ext })
        ctx.logger?.info?.(`converted ${input.name} (.${ext}) to PDF for parsing`)
      } catch (error) {
        ctx.logger?.warn?.(`legacy conversion failed for ${input.name}: ${error.message}`)
        prepared.push({ ...input, convertError: error.message })
      }
    }
    return prepared
  }

  /* ------------------------ heartbeat + zombie reaper ------------------------ */

  const heartbeats = new Map()

  const stopHeartbeat = (id) => {
    const timer = heartbeats.get(id)
    if (timer) clearInterval(timer)
    heartbeats.delete(id)
  }

  /**
   * A single chapter can run longer than a minute, so the beat cannot ride on
   * push(): an independent timer renews it. `owner` lets a second Host instance
   * on the same machine check pid liveness instead of declaring a false death.
   */
  const startHeartbeat = (id) => {
    stopHeartbeat(id)
    // stamp immediately: a crash inside the first interval must still look recent
    const seedJob = jobs.get(id)
    if (seedJob) {
      seedJob.heartbeatAt = Date.now()
      seedJob.owner = { pid: process.pid, hostname: hostname(), bootId: BOOT_ID }
    }
    const timer = setInterval(() => {
      const job = jobs.get(id)
      if (!job || job.status !== 'running') return stopHeartbeat(id)
      job.heartbeatAt = Date.now()
      job.owner = { pid: process.pid, hostname: hostname(), bootId: BOOT_ID }
      try {
        store.saveJob(job)
      } catch {}
    }, HEARTBEAT_MS)
    timer.unref?.()
    heartbeats.set(id, timer)
  }

  const finishJob = (id, job) => {
    // `finishedAt` is what lets a repeated ingest tell "just finished, reuse it"
    // from "finished an hour ago, this is a new request".
    const settled = job.finishedAt ? job : { ...job, finishedAt: new Date().toISOString() }
    jobs.set(id, { ...settled, requestKey: requestKeys.get(id) || settled.requestKey })
    stopHeartbeat(id)
  }

  /** Jobs left `running` by a dead process must not poll forever. */
  function reapZombies() {
    const now = Date.now()
    let reaped = 0
    for (const { id } of store.listJobs(300)) {
      if (jobs.has(id)) continue
      let job
      try {
        job = store.loadJob(id)
      } catch {
        continue
      }
      if (!job || job.status !== 'running') continue
      const beat = Number(job.heartbeatAt || 0) || Date.parse(job.createdAt || '') || 0
      if (now - beat <= STALE_MS) continue
      const owner = job.owner
      if (owner?.hostname === hostname() && Number.isInteger(owner.pid)) {
        let alive = false
        try {
          process.kill(owner.pid, 0)
          alive = true
        } catch {}
        if (alive) continue
      }
      const dead = {
        ...job,
        status: 'interrupted',
        phase: 'interrupted',
        error: '进程重启，任务已中断（可重新运行）',
        interruptedAt: new Date().toISOString(),
      }
      jobs.set(id, dead)
      store.saveJob(dead)
      reaped += 1
    }
    return reaped
  }

  async function makeJob(inputs, options) {
    const prepared = await prepareInputs(inputs)
    inputs = prepared
    const id = randomUUID().slice(0, 8)
    const job = {
      id,
      status: 'running',
      phase: 'queued',
      message: '排队中…',
      progress: 0,
      files: inputs.map((f) => ({ name: f.name })),
      chapters: [],
      byChapter: {},
      series: [],
      warnings: [],
    }
    jobs.set(id, job)
    jobInputs.set(id, inputs)
    store.touchUploads(inputs.map((f) => f.uploadId).filter(Boolean))
    startHeartbeat(id)
    const llm = resolveLlm()
    const controller = new AbortController()
    controllers.set(id, controller)
    runPipeline({
      id,
      inputs,
      options,
      deps: { store, bili, llm },
      signal: controller.signal,
      emit: (next) => {
        jobs.set(id, { ...next, requestKey: requestKeys.get(id) || next.requestKey })
      },
    })
      .then((final) => {
        finishJob(id, final)
      })
      .catch((error) => {
        // A cancel is not a failure: the model was told "已取消", so the job
        // must not later flip to error when the aborted promise settles.
        const current = jobs.get(id) || job
        const aborted = controller.signal.aborted
        finishJob(id, {
          ...current,
          status: aborted ? 'cancelled' : 'error',
          phase: aborted ? 'cancelled' : 'error',
          error: aborted ? '' : String(error?.message || error),
          progress: aborted ? current.progress : 1,
        })
        store.saveJob(jobs.get(id))
        if (!aborted) ctx.logger?.warn?.(`[course-agent] job ${id} failed: ${error?.stack || error}`)
      })
      .finally(() => {
        controllers.delete(id)
      })
    return job
  }

  /**
   * Rerun one chapter of a finished job: the parse + outline are replayed to
   * recover that chapter's text, the summary is regenerated with the cache
   * bypassed, and the report is rebuilt. Everything else is carried over.
   */
  async function makeRerunJob(previous, inputs, chapterIndex, options) {
    const id = randomUUID().slice(0, 8)
    const seed = {
      ...previous,
      id,
      status: 'running',
      phase: 'rerun',
      message: `重跑第 ${chapterIndex} 章…`,
      progress: 0.05,
      error: '',
    }
    jobs.set(id, seed)
    jobInputs.set(id, inputs)
    store.touchUploads(inputs.map((f) => f.uploadId).filter(Boolean))
    startHeartbeat(id)
    const controller = new AbortController()
    controllers.set(id, controller)
    rerunChapter({
      id,
      inputs,
      previous,
      chapterIndex,
      options,
      deps: { store, bili, llm: resolveLlm() },
      signal: controller.signal,
      emit: (next) => jobs.set(id, next),
    })
      .then((final) => {
        finishJob(id, final)
      })
      .catch((error) => {
        const current = jobs.get(id) || seed
        const aborted = controller.signal.aborted
        finishJob(id, {
          ...current,
          status: aborted ? 'cancelled' : 'error',
          phase: aborted ? 'cancelled' : 'error',
          error: aborted ? '' : String(error?.message || error),
          progress: aborted ? current.progress : 1,
        })
        store.saveJob(jobs.get(id))
        if (!aborted) ctx.logger?.warn?.(`[course-agent] rerun ${id} failed: ${error?.stack || error}`)
      })
      .finally(() => {
        controllers.delete(id)
      })
    return seed
  }

  /**
   * Recover the inputs of a job after a restart: the in-memory map is gone, but
   * job.inputs carries dataDir-relative paths. A pruned upload is reported by
   * name (410), never as a generic "task not found".
   */
  function restoreInputs(jobId) {
    const previous = jobs.get(jobId) || store.loadJob(jobId)
    const rows = previous?.inputs
    if (!Array.isArray(rows) || !rows.length) return { error: '原任务缺少输入清单（旧版本任务），请重新拖入文件' }
    const inputs = []
    for (const row of rows) {
      const path = isAbsolute(row.path) ? row.path : join(store.dataDir, row.path)
      if (!existsSync(path)) {
        return {
          error: `上传文件已过期（保留 ${config.keepUploadsDays ?? 7} 天）：${row.name}，请重新拖入`,
          missing: row.name,
        }
      }
      inputs.push({ path, name: row.name, uploadId: row.uploadId })
    }
    return { inputs, previous }
  }

  /**
   * PDF export: the report is laid out natively (pdfkit + bundled CJK subset)
   * and the structure diagram is drawn as vectors. The old docx→LibreOffice path
   * stays as a fallback for installs where the font asset is missing.
   */
  async function exportPdf(job) {
    if (job.pdfPath && existsSync(job.pdfPath)) return job.pdfPath
    const markdown = job.markdown || (job.reportPath && existsSync(job.reportPath) ? readFileSync(job.reportPath, 'utf8') : '')
    if (!markdown) throw new Error('报告尚未生成')

    let buffer = null
    if (existsSync(PDF_FONT)) {
      const { buildPdf } = await import('./core/pdfdoc.js')
      const { buildStructure } = await import('./core/diagram.js')
      const level = styleOfLevel(job.style || job.reportLevel || config.reportLevel)
      const subtitle =
        level === 'sprint' ? '冲刺五册 · PLUS' : level === 'review' ? '复习资料 · MAX' : '学习报告'
      const files = Array.isArray(job.files) ? job.files : []
      const pages = files.reduce((total, file) => total + (Number(file.pages) || 0), 0)
      const meta = [
        `读取文件：${files.length} 个${pages ? `（${pages} 页）` : ''}`,
        `章节：${Array.isArray(job.chapters) ? job.chapters.length : 0} 章`,
        `生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        `报告模式：${subtitle}`,
      ]
      if (files.length) {
        const names = files.slice(0, 4).map((file) => file.name).filter(Boolean)
        if (names.length) meta.push(`课件：${names.join('、')}${files.length > 4 ? ' 等' : ''}`)
      }
      const structure = buildStructure({
        courseTitle: job.courseTitle || '课程报告',
        chapters: job.chapters || [],
        plan: job.sprint?.plan || [],
      })
      buffer = await buildPdf({ markdown, courseTitle: job.courseTitle || '课程报告', subtitle, meta, structure })
    }

    if (!buffer) {
      const office = ctx.get('officeToPdf')
      if (!office?.convert) throw new Error('PDF 导出不可用：缺少中文字体，且当前 profile 未提供 officeToPdf 服务')
      const docx = markdownToDocx(markdown, `《${job.courseTitle || '课程'}》学习报告`)
      const version = String(job.createdAt || Date.now())
      const result = await office.convert({
        extension: 'docx',
        priority: 'foreground',
        source: {
          key: `course-agent:${job.id}`,
          version,
          bytes: docx.length,
          read: async () => ({ bytes: docx, version }),
        },
      })
      buffer = Buffer.from(result.pdf)
    }

    const pdfPath = (job.reportPath || join(store.reportsDir, `course-${job.id}.md`)).replace(/\.md$/, '.pdf')
    store.writeBytes(pdfPath, buffer)
    job.pdfPath = pdfPath
    job.pdfBytes = buffer.length
    store.saveJob(job)
    return pdfPath
  }

  /* ------------------------------- routes ------------------------------- */

  const routeHandler = async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    try {
      if (path === `${ROUTE}/health`) {
        return send(res, 200, {
          ok: true,
          version: PKG.version || 'unknown',
          llm: !!resolveLlm(),
          pdf: existsSync(PDF_FONT) || !!ctx.get('officeToPdf')?.convert,
          pdfFont: existsSync(PDF_FONT),
          ocr: ocrAvailable(),
          ocrEngines: await ocrStatus(),
          ocrMode: String(config.ocrMode || 'auto'),
          ocrPick: String(config.ocrPick || 'first'),
          reportLevel: String(config.reportLevel || 'normal'),
          dataDir: store.dataDir,
          supported: [...SUPPORTED, '.ppt', '.doc', '.xls'],
          jobs: jobs.size,
        })
      }

      if (path === `${ROUTE}/history`) {
        const limit = Number(url.searchParams.get('limit')) || 20
        return send(res, 200, { ok: true, jobs: store.listHistory?.(limit) || [] })
      }

      if (path === `${ROUTE}/upload` && req.method === 'POST') {
        const rawName = url.searchParams.get('name') || 'file'
        const name = basename(decodeURIComponent(rawName))
        const ext = name.slice(name.lastIndexOf('.')).toLowerCase()
        // legacy Office files are accepted and converted to PDF before parsing
        if (!SUPPORTED.includes(ext) && !LEGACY_EXT.has(ext.slice(1))) {
          return send(res, 400, { ok: false, reason: `不支持的文件类型：${ext || '(无扩展名)'}` })
        }
        const body = await readBody(req)
        if (!body.length) return send(res, 400, { ok: false, reason: '空文件' })
        const saved = store.saveUpload(body, name)
        uploads.set(saved.id, saved)
        return send(res, 200, { ok: true, file: { id: saved.id, name: saved.name, bytes: saved.bytes, sha256: saved.sha256 } })
      }

      if (path === `${ROUTE}/run` && req.method === 'POST') {
        const body = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString('utf8') || '{}')
        const list = Array.isArray(body.files) ? body.files : []
        if (!list.length) return send(res, 400, { ok: false, reason: '没有待处理文件' })
        const inputs = []
        for (const item of list) {
          const id = typeof item === 'string' ? item : item.id
          const saved = uploads.get(id)
          if (!saved || !existsSync(saved.path)) {
            return send(res, 400, { ok: false, reason: `上传文件已失效：${id}` })
          }
          inputs.push({ path: saved.path, name: saved.name, uploadId: saved.id })
        }
        if (inputs.length > 12) return send(res, 400, { ok: false, reason: '一次最多处理 12 个文件' })
        const job = await makeJob(inputs, optionsOf(body.options))
        return send(res, 200, { ok: true, jobId: job.id })
      }

      if (path === `${ROUTE}/rerun` && req.method === 'POST') {
        const body = JSON.parse((await readBody(req, 256 * 1024)).toString('utf8') || '{}')
        let inputs = jobInputs.get(body.jobId)
        if (!inputs?.length) {
          // after a restart the in-memory map is empty: rebuild from the manifest
          const restored = restoreInputs(body.jobId)
          if (restored.error) {
            return send(res, restored.missing ? 410 : 404, { ok: false, reason: restored.error })
          }
          inputs = restored.inputs
          jobInputs.set(body.jobId, inputs)
        }
        const chapterIndex = Number(body.chapterIndex)
        if (chapterIndex > 0) {
          const previous = jobs.get(body.jobId) || store.loadJob(body.jobId)
          if (!previous) return send(res, 404, { ok: false, reason: '原任务不存在' })
          if (!(previous.chapters || []).length) return send(res, 400, { ok: false, reason: '原任务还没有章节目录，先完整跑一次' })
          const job = await makeRerunJob(previous, inputs, chapterIndex, optionsOf(body.options))
          return send(res, 200, { ok: true, jobId: job.id, chapterIndex })
        }
        const job = await makeJob(inputs, optionsOf(body.options))
        return send(res, 200, { ok: true, jobId: job.id })
      }

      if (path === `${ROUTE}/job` && req.method === 'GET') {
        const id = url.searchParams.get('id')
        const job = jobs.get(id) || (id && store.loadJob(id))
        if (!job) return send(res, 404, { ok: false, reason: '任务不存在' })
        const { markdown, ...rest } = job
        return send(res, 200, { ok: true, job: { ...rest, hasReport: !!job.reportPath } })
      }

      if (path === `${ROUTE}/job` && req.method === 'DELETE') {
        const id = url.searchParams.get('id')
        if (!id) return send(res, 400, { ok: false, reason: '缺少 id' })
        const job = jobs.get(id) || store.loadJob(id)
        if (!job) return send(res, 404, { ok: false, reason: '任务不存在' })
        stopHeartbeat(id)
        jobs.delete(id)
        jobInputs.delete(id)
        store.deleteJob(id, url.searchParams.get('withReport') === '1' ? job : null)
        return send(res, 200, { ok: true, deleted: id })
      }

      if (path === `${ROUTE}/report` && req.method === 'GET') {
        const id = url.searchParams.get('id')
        const format = (url.searchParams.get('format') || 'md').toLowerCase()
        const job = jobs.get(id) || (id && store.loadJob(id))
        if (!job) return send(res, 404, { ok: false, reason: '任务不存在' })
        if (format === 'csv' || format === 'json') {
          const body = format === 'csv' ? buildAnkiCsv(job) : buildCourseJson(job)
          return send(res, 200, body, {
            'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${job.courseTitle || job.id}.${format}`)}`,
          })
        }
        let markdown = job.markdown
        if (!markdown && job.reportPath && existsSync(job.reportPath)) markdown = readFileSync(job.reportPath, 'utf8')
        if (!markdown) return send(res, 404, { ok: false, reason: '报告尚未生成' })
        const stem = `课程学习报告-${(job.courseTitle || job.id).replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)}`
        if (format === 'pdf') {
          const pdfPath = await exportPdf({ ...job, markdown })
          return send(res, 200, readFileSync(pdfPath), {
            'content-type': 'application/pdf',
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${stem}.pdf`)}`,
          })
        }
        return send(res, 200, markdown, {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(`${stem}.md`)}`,
        })
      }

      if (path === `${ROUTE}/ask` && req.method === 'GET') {
        const id = url.searchParams.get('id')
        const question = (url.searchParams.get('q') || '').trim()
        if (!id || !question) return send(res, 400, { ok: false, reason: '缺少 id 或 q' })
        const rows = store.loadSearchIndex(id)
        if (!rows?.length) return send(res, 404, { ok: false, reason: '该任务还没有可检索的内容（先完整跑一次）' })
        const { answers, hint } = ask(indexFromPassages(rows), question)
        return send(res, 200, { ok: true, question, answers, hint })
      }

      if (path === `${ROUTE}/library` && req.method === 'GET') {
        const rows = store.listJobs(20).map(({ id, mtime }) => {
          const job = jobs.get(id) || store.loadJob(id)
          return {
            id,
            updatedAt: new Date(mtime).toISOString(),
            courseTitle: job?.courseTitle || '',
            status: job?.status || 'unknown',
            chapters: job?.chapters?.length || 0,
            report: !!job?.reportPath,
          }
        })
        return send(res, 200, { ok: true, jobs: rows })
      }

      return send(res, 404, { ok: false, reason: 'not found' })
    } catch (error) {
      return send(res, 500, { ok: false, reason: String(error?.message || error) })
    }
  }

  try {
    disposers.push(ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: routeHandler }))
  } catch (error) {
    ctx.logger?.warn?.(`[course-agent] route unavailable: ${error}`)
  }

  // A previous process may have died mid-run; mark those jobs before the panel
  // starts polling them (otherwise it polls a `running` job forever).
  try {
    const reaped = reapZombies()
    if (reaped) ctx.logger?.info?.(`[course-agent] ${reaped} interrupted job(s) marked as zombie`)
  } catch (error) {
    ctx.logger?.warn?.(`[course-agent] zombie scan failed: ${error.message}`)
  }

  /* ------------------------------ agent api ------------------------------ */
  // One service, two callers. The panel's HTTP routes already share this job
  // registry; providing it gives the tools (and any other plugin) a supported
  // entry point instead of "call the same internal functions as the routes".

  const controllers = new Map()
  // The pipeline emits fresh snapshots, so the request identity has to live
  // beside the jobs map rather than inside one snapshot that gets replaced.
  const requestKeys = new Map()
  const jobOf = (id) => (id ? jobs.get(String(id)) || store.loadJob(String(id)) : null)
  const traceOf = (jobId) => tracePathOf(store.jobsDir, String(jobId))

  const agentApi = {
    async health() {
      return {
        version: PKG.version || 'unknown',
        llm: !!resolveLlm(),
        pdf: existsSync(PDF_FONT) || !!ctx.get('officeToPdf')?.convert,
        pdfFont: existsSync(PDF_FONT),
        ocrEngines: await ocrStatus(),
        ocrMode: String(config.ocrMode || 'auto'),
        reportLevel: String(config.reportLevel || 'normal'),
        dataDir: store.dataDir,
        activeJobs: [...jobs.values()].filter((job) => job.status === 'running').length,
        supported: [...SUPPORTED, '.ppt', '.doc', '.xls'],
        limits: {
          maxFiles: LIMITS.maxFiles,
          maxFileMB: Math.round(MAX_UPLOAD / (1024 * 1024)),
          levels: ['normal', 'max', 'plus'],
          ocrMaxPages: Number(config.ocrMaxPages) || 60,
          readChunkChars: LIMITS.defaultReadChars,
        },
      }
    },

    /**
     * Start a run and return at once. The old tool polled for up to 150 s inside
     * one call, which is the opposite of what an agent needs: it cannot show
     * progress, cannot cancel, and a slow deck just looked like a hang.
     */
    async ingest(options = {}) {
      const list = Array.isArray(options.files) ? options.files.filter(Boolean).map(String) : []
      let inputs = []
      if (options.appendTo) {
        const restored = restoreInputs(String(options.appendTo))
        if (restored.error) {
          return failure(CODES.badRequest, restored.error, {
            hint: '用 course_library 确认 jobId；追加需要原任务的上传文件还在有效期内',
            details: { appendTo: String(options.appendTo) },
          })
        }
        inputs = [...restored.inputs]
      }
      if (!list.length && !inputs.length) {
        return failure(CODES.badRequest, '请提供 files（至少一个课程文件路径），或 appendTo 追加到已有课程', {
          hint: 'course_health 里有 supported 扩展名和 maxFiles 上限',
        })
      }
      for (const path of list) {
        if (!existsSync(path)) return failure(CODES.badFile, `文件不存在：${path}`, { hint: '确认路径是绝对路径；课件要先下载到本机' })
        const stat = statSync(path)
        if (!stat.isFile()) return failure(CODES.badFile, `不是文件：${path}`)
        if (stat.size > MAX_UPLOAD) {
          return failure(CODES.badFile, `文件过大（>${Math.round(MAX_UPLOAD / (1024 * 1024))}MB）：${path}`)
        }
        inputs.push({ path, name: basename(path) })
      }
      if (inputs.length > LIMITS.maxFiles) {
        return failure(CODES.badRequest, `一次最多处理 ${LIMITS.maxFiles} 个文件`, { details: { maxFiles: LIMITS.maxFiles } })
      }
      const optionsOfRun = optionsOf({
        withVideos: options.withVideos,
        reportLevel: options.reportLevel || options.reportStyle,
        days: options.days,
        target: options.target,
        minutes: options.minutes,
      })
      // A costly level is a user decision, not a tool default.
      const gate = checkLevel(optionsOfRun.reportLevel, options.confirm)
      if (gate) return gate
      // The same request twice is one job: the model often retries after a
      // timeout, and building a second course doubles the spend for nothing.
      const key = ingestKey(inputs, optionsOfRun, options.appendTo)
      const reused = reusableJob(jobs, key)
      if (reused) {
        return {
          jobId: reused.id,
          status: reused.status,
          reused: true,
          files: inputs.map((input) => input.name),
          level: reused.reportLevel || optionsOfRun.reportLevel,
          appendedTo: options.appendTo ? String(options.appendTo) : '',
          next: { tool: 'course_status', hint: '这个请求刚才已经建过档，直接轮询这个 jobId，不要重复建档' },
        }
      }
      const job = await makeJob(inputs, optionsOfRun)
      requestKeys.set(job.id, key)
      job.requestKey = key
      if (options.appendTo) job.appendedFrom = String(options.appendTo)
      jobs.set(job.id, job)
      try {
        store.saveJob(job)
      } catch {}
      return {
        jobId: job.id,
        status: job.status,
        files: inputs.map((input) => input.name),
        level: optionsOfRun.reportLevel,
        appendedTo: options.appendTo ? String(options.appendTo) : '',
        next: { tool: 'course_status', hint: '轮询 course_status（10–60 秒；max/plus 更久），不要重复建档' },
      }
    },

    status(jobId) {
      const job = jobOf(jobId)
      if (!job) {
        return failure(CODES.jobNotFound, '任务不存在（jobId 写错了，或任务已被删除）', { hint: '用 course_library 找 jobId' })
      }
      return statusView(job, { trace: readTrace(traceOf(job.id)) })
    },

    outline(jobId, syllabusPath) {
      const job = jobOf(jobId)
      if (!job) return failure(CODES.jobNotFound, '任务不存在', { hint: '用 course_library 找 jobId' })
      if (!Array.isArray(job.chapters) || !job.chapters.length) {
        return failure(CODES.jobNotReady, `目录还没生成（当前 ${job.status}/${job.phase || '-'}）：先 course_status 等到 done`, {
          retryable: true,
          hint: '先 course_status 轮询到 done，再 course_outline',
          details: { status: job.status },
        })
      }
      const view = outlineView(job)
      const syllabus = String(syllabusPath || '').trim()
      if (!syllabus) return view
      if (!existsSync(syllabus)) return failure(CODES.badFile, `考纲文件不存在：${syllabus}`)
      try {
        const doc = parseFile(syllabus, basename(syllabus))
        // markdown/docx put the body in blocks, pdf/pptx in pages
        const body =
          doc.text ||
          (doc.blocks || []).map((block) => `${block.title}\n${block.text}`).join('\n\n') ||
          (doc.pages || []).map((page) => page.text).join('\n\n')
        const result = coverage(job.chapters, parseSyllabus(body, { ignore: [doc.title, basename(syllabus)] }))
        view.coverage = {
          syllabus: basename(syllabus),
          total: result.total,
          covered: result.covered,
          // 0/0 would read as "完全没覆盖"; say so explicitly instead
          ratio: result.total ? result.ratio : null,
          note: result.total ? undefined : '考纲里没解析出可比的考点（每条至少 6 个字），换个更细的大纲文件再试',
          uncovered: result.uncovered.slice(0, 10),
          uncoveredTotal: result.uncovered.length,
          byChapter: result.byChapter.map((row) => ({ chapter: row.index, title: row.title, covered: row.covered.length, ratio: row.ratio })),
        }
      } catch (error) {
        view.coverage = { syllabus: basename(syllabus), error: `考纲解析失败：${error.message}` }
      }
      return view
    },

    read(jobId, chapter, options = {}) {
      const job = jobOf(jobId)
      if (!job) return failure(CODES.jobNotFound, '任务不存在', { hint: '用 course_library 找 jobId' })
      const rows = store.loadSearchIndex(job.id)
      if (!rows?.length) {
        return failure(CODES.jobNotReady, '这个任务还没有可读正文（先等 course_status 到 done，或旧版本任务重跑一次）', {
          retryable: true,
          hint: 'course_status 到 done 再 course_read；旧任务可以 course_ingest appendTo 重跑',
        })
      }
      const view = readView(rows, chapter, { jobId: job.id, offset: options.offset, maxChars: options.maxChars })
      if (!view) {
        return failure(CODES.badRequest, `第 ${chapter} 章没有正文（可用 course_outline 核对章号）`, {
          hint: 'course_outline 拿到真实章号后再读',
        })
      }
      return view
    },

    ask(jobId, question, topK) {
      const job = jobOf(jobId)
      if (!job) return failure(CODES.jobNotFound, '任务不存在', { hint: '用 course_library 找 jobId' })
      const questionText = String(question || '').trim()
      if (!questionText) return failure(CODES.badRequest, '请给出 question', { hint: '把用户原问题传进来，例如「第 3 章的重点是什么」' })
      const rows = store.loadSearchIndex(job.id)
      if (!rows?.length) {
        return failure(CODES.jobNotReady, '这个任务还没有可检索的内容（先等 course_status 到 done）', { retryable: true })
      }
      const limit = Number.isFinite(Number(topK)) ? Math.min(LIMITS.maxAnswers, Math.max(1, Math.round(Number(topK)))) : 3
      const { answers, hint } = ask(indexFromPassages(rows), questionText, limit)
      return { jobId: job.id, question: questionText, answers, hint }
    },

    async export(jobId, format) {
      const job = jobOf(jobId)
      if (!job) return failure(CODES.jobNotFound, '任务不存在', { hint: '用 course_library 找 jobId' })
      // Only a finished job has artefacts worth handing over; csv/json used to
      // be assembled from whatever fields existed, so a half-built course looked
      // like a course.
      const gate = checkExport(job)
      if (gate) return gate
      const picked = ['md', 'pdf', 'csv', 'json'].includes(String(format)) ? String(format) : 'md'
      if (picked === 'csv' || picked === 'json') {
        const body = picked === 'csv' ? buildAnkiCsv(job) : buildCourseJson(job)
        const path = join(store.reportsDir, `course-${job.id}-${picked === 'csv' ? 'anki.csv' : 'course.json'}`)
        store.writeBytes(path, Buffer.from(body, 'utf8'))
        return { jobId: job.id, format: picked, path, bytes: Buffer.byteLength(body) }
      }
      const markdown = job.markdown || (job.reportPath && existsSync(job.reportPath) ? readFileSync(job.reportPath, 'utf8') : '')
      if (!markdown) {
        return failure(CODES.jobNotReady, '报告文件不见了（可能被清理）', {
          hint: 'course_status 看 reportPath；没有就 rerun 建档一次',
          details: { reportPath: job.reportPath || '' },
        })
      }
      if (picked === 'md') {
        return { jobId: job.id, format: 'md', path: job.reportPath || '', chars: markdown.length, ...previewOf(markdown) }
      }
      const refreshed = job.markdown ? job : { ...job, markdown }
      const pdfPath = await exportPdf(refreshed)
      return { jobId: job.id, format: 'pdf', path: pdfPath, bytes: statSync(pdfPath).size }
    },

    library(limit) {
      const count = Number.isFinite(Number(limit)) ? Math.min(LIMITS.maxLibrary, Math.max(1, Math.round(Number(limit)))) : 10
      const rows = store.listJobs(Math.max(count * 2, 20)).map(({ id, mtime }) => {
        const job = jobs.get(id) || store.loadJob(id)
        return {
          id,
          updatedAt: new Date(mtime).toISOString(),
          courseTitle: job?.courseTitle || '',
          status: job?.status || 'unknown',
          chapters: job?.chapters?.length || 0,
          report: !!job?.reportPath,
        }
      })
      return libraryView(rows.slice(0, count))
    },

    /** Abort a run: the pipeline already honours an AbortSignal. */
    cancel(jobId) {
      const job = jobOf(jobId)
      if (!job) return failure(CODES.jobNotFound, '任务不存在', { hint: '用 course_library 找 jobId' })
      if (job.status !== 'running') return { ok: true, jobId: job.id, status: job.status, cancelled: false, reason: '任务已结束，无需取消' }
      const controller = controllers.get(job.id)
      if (!controller) {
        return failure(CODES.jobNotReady, '这个任务不属于当前进程（可能已重启），无法取消', {
          hint: 'course_library 里状态是 running 但进程已重启时，等心跳超时会被标记 interrupted',
        })
      }
      controller.abort()
      const next = {
        ...job,
        status: 'cancelled',
        phase: 'cancelled',
        message: '已取消',
        error: '',
        progress: Math.min(Number(job.progress) || 0, 0.99),
      }
      jobs.set(job.id, next)
      stopHeartbeat(job.id)
      store.saveJob(next)
      controllers.delete(job.id)
      return { ok: true, jobId: job.id, status: 'cancelled', cancelled: true }
    },

    /**
     * One line per tool call, written by the tool layer. Kept here so the api is
     * the only thing that knows where traces live, and a future transport (or a
     * second host) inherits the same behaviour.
     */
    noteToolCall(jobId, entry) {
      if (!jobId) return false
      return appendTrace(traceOf(jobId), entry)
    },

    /** The raw trace of a job — for the panel and for `course_status`. */
    trace(jobId) {
      return readTrace(traceOf(jobId))
    },

    /**
     * Register the nine tools in the caller's scope.
     *
     * The Host plugin owns the implementation but not the visibility: the
     * `course` preset calls this from its own fiber, so the tools exist exactly
     * where the agent that uses them lives. Registering them here (globally)
     * would put nine course tools in every session's tool list, including the
     * ones that will never see a slide deck.
     */
    registerTools(scope) {
      return registerCourseTools(scope, agentApi)
    },
  }

  // Other plugins may depend on `courseAgent`; the tools below use the same
  // object, so the panel and the agent can never disagree about a job.
  try {
    ctx.provide?.('courseAgent', agentApi)
  } catch (error) {
    ctx.logger?.warn?.(`[course-agent] courseAgent service unavailable: ${error.message}`)
  }

  // The tools are not registered here on purpose: `course` preset calls
  // `courseAgent.registerTools` from its own scope (see preset/tutor.js), so
  // only sessions that picked the tutor see them.

  ctx.effect?.(() => () => {
    // unload is not a place to leave pipelines running: abort them first so the
    // store is not written by a half-dead job after the service is gone
    for (const controller of controllers.values()) {
      try {
        controller.abort()
      } catch {}
    }
    controllers.clear()
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch {}
    }
    try {
      store.cache.flush()
    } catch {}
  })
}
