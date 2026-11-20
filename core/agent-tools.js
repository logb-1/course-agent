/**
 * The agent surface of course-agent.
 *
 * One tool with nine actions made the model carry an action switch in its head
 * and made every failure look alike. These are the atomic replacements: one
 * verb per tool, explicit parameters, bounded returns, and a `next` field that
 * names the tool to call after this one.
 *
 * Three rules hold for everything here:
 *   • nothing blocks for minutes — ingest returns a jobId, the model polls;
 *   • no tool returns more than a screenful — chapter text is paged by
 *     `offset`, reports are previewed and exported to a path;
 *   • failures are structured (code/retryable/hint), because a model cannot
 *     branch on a Chinese sentence, and every call lands in the job's trace so
 *     "why was that slow" has an answer.
 *
 * The surface itself — names, descriptions, parameters, side effects — lives in
 * `core/tool-spec.js`. This file only turns that table into registrations, so a
 * new tool cannot be half-declared.
 *
 * `api` is the courseAgent service provided by index.js, which is also
 * what the HTTP panel uses.
 */

import { TOOL_SPECS } from './tool-spec.js'
import { CODES, failure } from './error.js'
import { argsHash } from './trace.js'

export { TOOL_NAMES, WRITE_TOOLS, specOf } from './tool-spec.js'

const text = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
const output = (schema) => ({ schema, render: (_args, value) => text(value) })
const OUT = output({ type: 'object', additionalProperties: true })

/** Standard envelope so the model can branch on ok without guessing. */
const done = (value) => ({ ok: true, ...(value && typeof value === 'object' ? value : { value }) })
/** The api returns a view on success and `{ok:false, code}` on failure. */
const wrap = (value) => (value && value.ok === false ? value : done(value))

const INTERNAL_HINT = '同一个调用重试一次通常能过；连续失败就 course_health 自检，再把 reason 原文告诉用户'

/**
 * Run one tool body: convert a thrown error into a structured failure, time it,
 * and append one line to the job trace. Never throws — a tool that throws gives
 * the model nothing to reason about.
 */
async function run(api, name, args, body) {
  const started = Date.now()
  let result
  try {
    result = await body()
  } catch (error) {
    result = failure(CODES.internal, error?.message || String(error), { hint: INTERNAL_HINT })
  }
  const ms = Date.now() - started
  try {
    const jobId =
      String(args?.jobId || '') || (typeof result?.jobId === 'string' ? result.jobId : '')
    api.noteToolCall?.(jobId, {
      at: new Date().toISOString(),
      tool: name,
      argsHash: argsHash(args),
      ok: result?.ok !== false,
      code: result?.ok === false ? result.code : undefined,
      ms,
    })
  } catch {
    // a trace failure must never fail the call
  }
  return result
}

/**
 * @param {object} ctx plugin context (only `tools` is used)
 * @param {object} api courseAgent service provided by the plugin
 * @returns {Array<Function>} disposers
 */
export function registerCourseTools(ctx, api) {
  const disposers = []
  for (const spec of TOOL_SPECS) {
    disposers.push(
      ctx.tools.register({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output: OUT,
        async execute(args = {}) {
          return wrap(await run(api, spec.name, args, () => spec.call(api, args)))
        },
      }),
    )
  }
  return disposers
}
