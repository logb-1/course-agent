/**
 * The single source of truth for the tool surface.
 *
 * Name, model-facing description, parameters, side-effect class and the call it
 * maps to live here once. `core/agent-tools.js` registers exactly this table;
 * `docs/agent-contract.md` and `evals/` read the same names. Adding a tool is a
 * one-line edit here plus its implementation on the service — not three edits
 * that can disagree.
 *
 * `effect` is not decoration: `read` tools are safe to call repeatedly while a
 * job runs, `write` tools change stored state (a retry may duplicate work).
 */

/** @typedef {'read'|'write'} ToolEffect */

export const TOOL_SPECS = [
  {
    name: 'course_health',
    effect: 'read',
    description:
      '课程助手环境自检：模型、OCR 引擎、PDF 导出是否可用，以及数据目录与限额。' +
      '每个会话第一次用课程助手前调用一次；返回 ok=false 时不要继续建档，先说明缺什么。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    call: (api) => api.health(),
  },
  {
    name: 'course_ingest',
    effect: 'write',
    description:
      '建档：把课件（pptx/pdf/docx/md/txt，也可 .ppt/.doc/.xls）解析成章节目录、分章知识点和报告。' +
      '异步：立刻返回 jobId，之后用 course_status 轮询，不要在这里等。' +
      'reportLevel 默认 normal（便宜）；max=复习资料、plus=冲刺五册都明显更贵，用户没有明确要求就不要升——' +
      '这些级别必须带 confirm: true 才会执行，否则返回 code=needs_confirm。' +
      '给已有课程追加课件用 appendTo（传原 jobId），未变的章节命中缓存不重算。' +
      '同一批文件、同一级别重复调用会返回同一个 jobId（reused=true），不要以为出错而再建一次。',
    parameters: {
      type: 'object',
      properties: {
        files: { type: 'array', items: { type: 'string' }, description: '课件路径（绝对路径或相对当前工作目录）' },
        appendTo: { type: 'string', description: '已有课程的 jobId：把 files 追加到这门课' },
        reportLevel: { type: 'string', enum: ['normal', 'max', 'plus'], description: '报告深度，默认 normal' },
        confirm: { type: 'boolean', description: '用户明确同意 max/plus 的额外成本时传 true' },
        withVideos: { type: 'boolean', description: '是否检索 B 站网课，默认 true' },
        days: { type: 'number', description: 'PLUS：复习天数 1-60' },
        target: { type: 'number', description: 'PLUS：目标分 30-100' },
        minutes: { type: 'number', description: 'PLUS：每天分钟 30-600' },
      },
      additionalProperties: false,
    },
    call: (api, args) => api.ingest(args),
  },
  {
    name: 'course_status',
    effect: 'read',
    description:
      '查询任务进度：状态、阶段、章节完成数、失败章节、警告、OCR 覆盖、本轮已花的模型调用/缓存命中/工具序列，以及 next（下一步该调哪个工具）。' +
      '返回 status=running 就继续等（间隔 5–15 秒），done 后去 course_outline；不要重复 course_ingest。',
    parameters: {
      type: 'object',
      properties: { jobId: { type: 'string', description: 'course_ingest 返回的 jobId' } },
      required: ['jobId'],
      additionalProperties: false,
    },
    call: (api, args) => api.status(args.jobId),
  },
  {
    name: 'course_outline',
    effect: 'read',
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
    call: (api, args) => api.outline(args.jobId, args.syllabus),
  },
  {
    name: 'course_read',
    effect: 'read',
    description:
      '读一章课件正文（每段带 [pN] 页码标记，可续读）。默认返回 6000 字、上限 12000 字；' +
      'truncated=true 时用 nextOffset 作为 offset 继续，不要重复读同一段。讲解必须以这里或 course_ask 的原文为依据。',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '任务 id' },
        chapter: { type: 'number', description: '章号（course_outline 的 chapter 字段，从 1 开始）' },
        offset: { type: 'number', description: '从第几个字符开始，默认 0；续读用上次的 nextOffset' },
        maxChars: { type: 'number', description: '本次最多返回多少字（400–12000，默认 6000）' },
      },
      required: ['jobId', 'chapter'],
      additionalProperties: false,
    },
    call: (api, args) => api.read(args.jobId, args.chapter, { offset: args.offset, maxChars: args.maxChars }),
  },
  {
    name: 'course_ask',
    effect: 'read',
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
    call: (api, args) => api.ask(args.jobId, args.question, args.topK),
  },
  {
    name: 'course_export',
    effect: 'read',
    description:
      '导出成果并给出文件路径：md=报告全文路径（附预览）、pdf=排版好的 PDF、csv=Anki 卡片、json=给其他插件读的结构化课程。' +
      '只有 status=done 的任务能导出（否则 code=job_not_ready）；用户要「发我 / 保存 / 打印」时用它，然后把 path 告诉用户。',
    parameters: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: '任务 id' },
        format: { type: 'string', enum: ['md', 'pdf', 'csv', 'json'], description: '导出格式，默认 md' },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
    call: (api, args) => api.export(args.jobId, args.format),
  },
  {
    name: 'course_library',
    effect: 'read',
    description: '历史课程列表（最多 20 条）：jobId、课程名、状态、章节数、是否有报告。用户没给 jobId 时先查这里。',
    parameters: {
      type: 'object',
      properties: { limit: { type: 'number', description: '条数，默认 10，上限 20' } },
      additionalProperties: false,
    },
    call: (api, args) => api.library(args.limit),
  },
  {
    name: 'course_cancel',
    effect: 'write',
    description: '取消一个正在跑的任务（用户说不必等了、或明显跑错文件时）。已结束的任务返回 cancelled=false 与当前状态。',
    parameters: {
      type: 'object',
      properties: { jobId: { type: 'string', description: '任务 id' } },
      required: ['jobId'],
      additionalProperties: false,
    },
    call: (api, args) => api.cancel(args.jobId),
  },
]

export const TOOL_NAMES = TOOL_SPECS.map((spec) => spec.name)

export const WRITE_TOOLS = TOOL_SPECS.filter((spec) => spec.effect === 'write').map((spec) => spec.name)

export function specOf(name) {
  return TOOL_SPECS.find((spec) => spec.name === name)
}
