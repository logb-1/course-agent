/**
 * The agent surface of course-assistant.
 *
 * One tool with nine actions made the model carry an action switch in its head
 * and made every failure look alike. These are the atomic replacements: one
 * verb per tool, explicit parameters, bounded returns, and a `next` field that
 * names the tool to call after this one.
 *
 * Two rules hold for everything here:
 *   • nothing blocks for minutes — ingest returns a jobId, the model polls;
 *   • no tool returns more than a screenful — chapter text is paged by
 *     `offset`, reports are previewed and exported to a path.
 *
 * `api` is the courseAssistant service provided by index.js, which is also
 * what the HTTP panel uses.
 */

import { LIMITS } from './agent-view.js'

const text = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
const output = (schema) => ({ schema, render: (_args, value) => text(value) })
const OUT = output({ type: 'object', additionalProperties: true })

const fail = (reason) => ({ ok: false, reason: String(reason || '操作失败') })

/** Standard envelope so the model can branch on ok without guessing. */
const done = (value) => ({ ok: true, ...(value && typeof value === 'object' ? value : { value }) })
/** The api returns a view on success and `{ok:false, reason}` on failure. */
const wrap = (value) => (value && value.ok === false ? value : done(value))

export const TOOL_NAMES = [
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

/**
 * @param {object} ctx plugin context (only `tools` is used)
 * @param {object} api courseAssistant service provided by the plugin
 * @returns {Array<Function>} disposers
 */
export function registerCourseTools(ctx, api) {
  const disposers = []
  const add = (definition) => {
    disposers.push(ctx.tools.register(definition))
  }

  add({
    name: 'course_health',
    description:
      '课程助手环境自检：模型、OCR 引擎、PDF 导出是否可用，以及数据目录与限额。' +
      '每个会话第一次用课程助手前调用一次；返回 ok=false 时不要继续建档，先说明缺什么。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: OUT,
    async execute() {
      try {
        return done(await api.health())
      } catch (error) {
        return fail(error?.message || error)
      }
    },
  })

  add({
    name: 'course_ingest',
    description:
      '建档：把课件（pptx/pdf/docx/md/txt，也可 .ppt/.doc/.xls）解析成章节目录、分章知识点和报告。' +
      `异步：立刻返回 jobId，之后用 course_status 轮询，不要在这里等。一次最多 ${LIMITS.maxFiles} 个文件、单个 ≤60MB。` +
      'reportLevel 默认 normal（便宜）；max=复习资料、plus=冲刺五册都明显更贵，用户没有明确要求就不要升。' +
      '给已有课程追加课件用 appendTo（传原 jobId），未变的章节命中缓存不重算。',
    parameters: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: '课件路径（绝对路径或相对当前工作目录）' },
        appendTo: { type: 'string', description: '已有课程的 jobId：把 files 追加到这门课' },
        reportLevel: { type: 'string', enum: ['normal', 'max', 'plus'], description: '报告深度，默认 normal' },
        withVideos: { type: 'boolean', description: '是否检索 B 站网课，默认 true' },
        days: { type: 'number', description: 'PLUS：复习天数 1-60' },
        target: { type: 'number', description: 'PLUS：目标分 30-100' },
        minutes: { type: 'number', description: 'PLUS：每天分钟 30-600' },
      },
      additionalProperties: false,
    },
    output: OUT,
    async execute(args = {}) {
      try {
        return wrap(await api.ingest(args))
      } catch (error) {
        return fail(error?.message || error)
      }
    },
  })

  add({
    name: 'course_status',
    description:
      '查询任务进度：状态、阶段、章节完成数、失败章节、警告、OCR 覆盖，以及 next（下一步该调哪个工具）。' +
      '返回 status=running 就继续等（间隔 5–15 秒），done 后去 course_outline；不要重复 course_ingest。',
    parameters: {
      type: 'object',
      properties: { jobId: { type: 'string', description: 'course_ingest 返回的 jobId' } },
      required: ['jobId'],
      additionalProperties: false,
    },
    output: OUT,
    async execute(args = {}) {
      try {
        return wrap(await api.status(args.jobId))
      } catch (error) {
        return fail(error?.message || error)
      }
    },
  })

  add({
    name: 'course_outline',
    description:
      '课程目录：各章标题、页码范围、字数、要点数、是否离线兜底。先看目录再决定读哪章——不要一次读全部章节正文。' +
      '给了 syllabus（考纲/大纲文件路径）时附覆盖率：各章命中、没覆盖到的考点、总覆盖率，用于判断复习缺口。',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '任务 id' },
        syllabus: { type: 'string', description: '可选：考纲文件路径（pptx/pdf/docx/md/txt），用于算覆盖率' },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
    output: OUT,
    async execute(args = {}) {
      try {
        return wrap(await api.outline(args.jobId, args.syllabus))
      } catch (error) {
        return fail(error?.message || error)
      }
    },
  })

  add({
    name: 'course_read',
    description:
      `读一章课件正文（带页码，可续读）。默认返回 ${LIMITS.defaultReadChars} 字、上限 ${LIMITS.maxReadChars} 字；` +
      'truncated=true 时用 nextOffset 作为 offset 继续，不要重复读同一段。讲解必须以这里或 course_ask 的原文为依据。',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '任务 id' },
        chapter: { type: 'number', description: '章号（course_outline 的 chapter 字段，从 1 开始）' },
        offset: { type: 'number', description: '从第几个字符开始，默认 0；续读用上次的 nextOffset' },
        maxChars: { type: 'number', description: `本次最多返回多少字（400–${LIMITS.maxReadChars}，默认 ${LIMITS.defaultReadChars}）` },
      },
      required: ['jobId', 'chapter'],
      additionalProperties: false,
    },
    output: OUT,
    async execute(args = {}) {
      try {
        return wrap(await api.read(args.jobId, args.chapter, { offset: args.offset, maxChars: args.maxChars }))
      } catch (error) {
        return fail(error?.message || error)
      }
    },
  })

  add({
    name: 'course_ask',
    description:
      '在课件里做本地 BM25 检索（不花模型费）：返回最相关的原文片段 + 章号 + 页码，用于回答「课件里怎么定义 X」。' +
      '课件里没有就会返回空 answers，此时直说「课件里没写」，不要编。',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '任务 id' },
        question: { type: 'string', description: '问题或关键词（中文即可）' },
        topK: { type: 'number', description: '返回几条片段，默认 3，上限 4' },
      },
      required: ['jobId', 'question'],
      additionalProperties: false,
    },
    output: OUT,
    async execute(args = {}) {
      try {
        return wrap(await api.ask(args.jobId, args.question, args.topK))
      } catch (error) {
        return fail(error?.message || error)
      }
    },
  })

  add({
    name: 'course_export',
    description:
      '导出成果并给出文件路径：md=报告全文路径（附预览）、pdf=排版好的 PDF、csv=Anki 卡片、json=给其他插件读的结构化课程。' +
      '用户要「发我 / 保存 / 打印」时用它，然后把 path 告诉用户。',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '任务 id' },
        format: { type: 'string', enum: ['md', 'pdf', 'csv', 'json'], description: '导出格式，默认 md' },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
    output: OUT,
    async execute(args = {}) {
      try {
        return wrap(await api.export(args.jobId, args.format))
      } catch (error) {
        return fail(error?.message || error)
      }
    },
  })

  add({
    name: 'course_library',
    description: '历史课程列表（最多 20 条）：jobId、课程名、状态、章节数、是否有报告。用户没给 jobId 时先查这里。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: '条数，默认 10，上限 20' } },
      additionalProperties: false,
    },
    output: OUT,
    async execute(args = {}) {
      try {
        return wrap(await api.library(args.limit))
      } catch (error) {
        return fail(error?.message || error)
      }
    },
  })

  add({
    name: 'course_cancel',
    description: '取消一个正在跑的任务（用户说不必等了、或明显跑错文件时）。已结束的任务返回 cancelled=false 与当前状态。',
    parameters: {
      type: 'object',
      properties: { jobId: { type: 'string', description: '任务 id' } },
      required: ['jobId'],
      additionalProperties: false,
    },
    output: OUT,
    async execute(args = {}) {
      try {
        return wrap(await api.cancel(args.jobId))
      } catch (error) {
        return fail(error?.message || error)
      }
    },
  })

  return disposers
}
