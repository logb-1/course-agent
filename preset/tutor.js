/**
 * Preset half of the course tutor (P0).
 *
 * Mounted inside the `course` preset realm. Prompt wording lives in the
 * persona row of `cordis.patch.yml` — one source of truth, and it reloads
 * with the patch instead of staying cached in the module graph.
 *
 * This plugin keeps only the activation-time probe: prove that a
 * preset-realm plugin can reach the Host plugin package. The Host layer now
 * registers the atomic `course_*` tools and provides the `courseAssistant`
 * service, so anything this preset grows later is a thin tool over that
 * service, not a second pipeline.
 *
 * It deliberately does not re-register the tools — they are Host
 * registrations and are already visible here.
 */

export const name = 'course-tutor'

export function apply(ctx) {
  import('dsh-course-assistant')
    .then((mod) => {
      ctx.logger?.info?.(
        `[course-tutor] preset realm -> host package ok (apply: ${typeof mod.apply}, name: mod.name || 'n/a')`,
      )
    })
    .catch((error) => {
      ctx.logger?.warn?.(`[course-tutor] preset realm -> host package failed: ${error?.message || error}`)
    })
}
