/**
 * Preset half of the course tutor.
 *
 * Mounted inside the `course` preset realm. Prompt wording lives in the persona
 * row of `cordis.patch.yml` — one source of truth, and it reloads with the
 * patch instead of staying cached in the module graph.
 *
 * The Host plugin owns the pipeline and the `courseAgent` service; this plugin
 * owns *visibility*. Registering the nine tools from this fiber (instead of
 * from the Host plugin) is what keeps them out of every other session's tool
 * list: a scoped registration belongs to the preset that made it.
 *
 * `inject` must stay a plain array. Cordis reads an object declaration as a
 * name → intercept-config map, so `{ required: [...], optional: [...] }` makes
 * it wait for services literally named `required` and `optional` — the preset
 * then mounts as "waiting for required, optional" and never becomes selectable.
 * Optional dependencies are therefore read through `ctx.get()` below.
 */

export const name = 'course-tutor'

export const inject = ['systemPrompt']

export function apply(ctx) {
  const register = () => {
    const api = ctx.get('courseAgent')
    if (!api || typeof api.registerTools !== 'function') {
      ctx.logger?.warn?.('[course-tutor] courseAgent 还没就绪，本次会话暂时没有 course_* 工具')
      return
    }
    try {
      const disposers = api.registerTools(ctx) || []
      ctx.effect(() => () => {
        for (const dispose of disposers) {
          try {
            dispose?.()
          } catch {}
        }
      })
    } catch (error) {
      ctx.logger?.warn?.(`[course-tutor] 注册 course_* 工具失败：${error?.message || error}`)
    }
  }

  // `courseAgent` is optional, so wait for its availability rather than assuming
  // the Host plugin mounted first; the callback fires immediately when present.
  if (ctx.get('courseAgent')) register()
  else ctx.inject(['courseAgent'], register)
}
