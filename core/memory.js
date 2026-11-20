/**
 * Course memory: what the tutor must not ask twice.
 *
 * A 讲解 session starts cold every time: which course, what 目标分, how many days
 * left, which chapters were already explained, which mistakes were already made.
 * Without this file the agent re-asks all of it, and the 错题本 the contract has
 * been promising since P2 never exists.
 *
 * It is one small JSON file next to the jobs (`<dataDir>/memory.json`), keyed by
 * a hash of the course title so the same课件 always lands on the same course even
 * after a rebuild or a rename of the job. Everything is bounded: a memory that
 * grows without limit becomes a second context problem.
 *
 * Deliberate omissions: no cached 正文 (that is what jobs and the search index
 * are for), no scores the user did not state (silence beats invention — a memory
 * that guesses exam dates is worse than one that asks).
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const MEMORY_FILE = 'memory.json'

export const LIMITS = {
  courses: 12,
  progress: 200,
  mistakes: 80,
  jobs: 5,
  recallMistakes: 5,
  titleChars: 80,
  questionChars: 160,
  noteChars: 400
}

export const CHAPTER_STATES = ['read', 'explained', 'quizzed']

const RANK = { read: 1, explained: 2, quizzed: 3 }

export const rankOf = (state) => RANK[state] || 0

export const bestOf = (left, right) => (rankOf(right) > rankOf(left) ? right : left)

const clip = (value, max) => String(value ?? '').trim().slice(0, max)

const clamp = (value, low, high, fallback) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(high, Math.max(low, Math.round(number)))
}

/** Same课件 → same course, no matter which job or which session. */
export function courseIdFrom(title) {
  const key = clip(title, LIMITS.titleChars).replace(/\s+/g, ' ').toLowerCase()
  if (!key) return ''
  return createHash('sha1').update(key).digest('hex').slice(0, 8)
}

/** Goal fields are clamped, not trusted: a typo of 9999 天 is not a plan. */
export function mergeGoal(goal, patch = {}) {
  const base = goal && typeof goal === 'object' ? goal : {}
  const next = { ...base }
  if ('target' in patch) {
    const target = clamp(patch.target, 0, 750, null)
    if (target === null) delete next.target
    else next.target = target
  }
  if ('days' in patch) {
    const days = clamp(patch.days, 1, 365, null)
    if (days === null) delete next.days
    else next.days = days
  }
  if ('minutes' in patch) {
    const minutes = clamp(patch.minutes, 0, 1440, null)
    if (minutes === null) delete next.minutes
    else next.minutes = minutes
  }
  if ('level' in patch) {
    if (['normal', 'max', 'plus'].includes(patch.level)) next.level = patch.level
    else delete next.level
  }
  if ('note' in patch) {
    const note = clip(patch.note, LIMITS.noteChars)
    if (note) next.note = note
    else delete next.note
  }
  return next
}

export function normalizeMistake(input = {}) {
  const chapter = clamp(input.chapter, 0, 999, 0)
  const page = clamp(input.page, 0, 9999, 0)
  const question = clip(input.question, LIMITS.questionChars)
  const note = clip(input.note, LIMITS.noteChars)
  const tag = clip(input.tag, 24)
  if (!question && !note) return null
  return { chapter, page, question, note, tag, at: input.at || new Date().toISOString() }
}

const mistakeKey = (mistake) => `${mistake.chapter}|${mistake.page}|${mistake.question}`

/** Drop junk, clamp sizes, keep the newest course first. */
export function normalizeMemory(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const courses = {}
  for (const [id, course] of Object.entries(source.courses || {})) {
    if (!course || typeof course !== 'object') continue
    const title = clip(course.title, LIMITS.titleChars)
    const key = clip(id, 16) || courseIdFrom(title)
    if (!key) continue
    const progress = {}
    for (const [index, state] of Object.entries(course.progress || {}).slice(0, LIMITS.progress)) {
      const chapter = clamp(index, 0, 999, 0)
      if (!chapter || !CHAPTER_STATES.includes(state)) continue
      progress[chapter] = state
    }
    const seen = new Set()
    const mistakes = []
    for (const entry of Array.isArray(course.mistakes) ? course.mistakes : []) {
      const mistake = normalizeMistake(entry)
      if (!mistake) continue
      const dedupe = mistakeKey(mistake)
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      mistakes.push(mistake)
      if (mistakes.length >= LIMITS.mistakes) break
    }
    courses[key] = {
      id: key,
      title,
      goal: mergeGoal(course.goal),
      progress,
      mistakes,
      jobs: (Array.isArray(course.jobs) ? course.jobs : []).filter((job) => typeof job === 'string').slice(0, LIMITS.jobs),
      updatedAt: course.updatedAt || new Date().toISOString()
    }
  }
  const trimmed = Object.fromEntries(
    Object.entries(courses)
      .sort((left, right) => String(right[1].updatedAt).localeCompare(String(left[1].updatedAt)))
      .slice(0, LIMITS.courses)
  )
  const active = source.activeCourse && trimmed[source.activeCourse] ? source.activeCourse : ''
  return { version: 1, activeCourse: active, courses: trimmed }
}

const pathOf = (dataDir) => join(dataDir, MEMORY_FILE)

function atomicWrite(path, value) {
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

/**
 * Resolve a reference the model may hold: a course id, the exact title it saw,
 * or a fragment of it ("实验3"). Exact match wins; a fragment must be unique, so
 * ambiguity is reported instead of silently picking a course.
 */
export function resolveCourse(memory, ref) {
  const want = clip(ref, LIMITS.titleChars)
  if (!want) {
    const active = memory.activeCourse ? memory.courses[memory.activeCourse] : null
    return { course: active || null, ambiguous: [] }
  }
  if (memory.courses[want]) return { course: memory.courses[want], ambiguous: [] }
  const exact = Object.values(memory.courses).find((course) => course.title === want)
  if (exact) return { course: exact, ambiguous: [] }
  const lower = want.toLowerCase()
  const matches = Object.values(memory.courses).filter((course) => course.title.toLowerCase().includes(lower))
  if (matches.length === 1) return { course: matches[0], ambiguous: [] }
  return { course: null, ambiguous: matches.map((course) => ({ id: course.id, title: course.title })) }
}

export function createMemory({ dataDir, now = () => new Date().toISOString() } = {}) {
  if (!dataDir) throw new Error('createMemory: dataDir is required')
  const file = pathOf(dataDir)

  const read = () => {
    try {
      return normalizeMemory(JSON.parse(readFileSync(file, 'utf8')))
    } catch {
      return normalizeMemory({})
    }
  }

  const write = (memory) => {
    try {
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
      const next = normalizeMemory(memory)
      atomicWrite(file, next)
      return next
    } catch {
      // Memory is a convenience: losing a goal line must never fail a 讲解.
      return null
    }
  }

  const touch = (course) => {
    course.updatedAt = now()
    return course
  }

  const ensure = (memory, ref) => {
    const { course, ambiguous } = resolveCourse(memory, ref)
    if (course) return { course, ambiguous }
    const title = clip(ref, LIMITS.titleChars)
    if (!title || ambiguous.length) return { course: null, ambiguous }
    const id = courseIdFrom(title)
    if (!id) return { course: null, ambiguous }
    const created = { id, title, goal: {}, progress: {}, mistakes: [], jobs: [], updatedAt: now() }
    memory.courses[id] = created
    return { course: created, ambiguous: [] }
  }

  const mutate = (ref, change) => {
    const memory = read()
    const { course, ambiguous } = ensure(memory, ref)
    if (!course) return { ok: false, ambiguous }
    change(course)
    touch(course)
    if (!memory.activeCourse) memory.activeCourse = course.id
    const saved = write(memory)
    return { ok: Boolean(saved), course, memory: saved || memory }
  }

  return {
    file,
    read,
    list: () => Object.values(read().courses),
    active: () => {
      const memory = read()
      return memory.activeCourse ? memory.courses[memory.activeCourse] || null : null
    },
    setActive(ref) {
      const memory = read()
      const { course } = resolveCourse(memory, ref)
      if (!course) return { ok: false }
      memory.activeCourse = course.id
      return { ok: Boolean(write(memory)), course }
    },
    upsert({ title, id } = {}) {
      const memory = read()
      const key = clip(id, 16) || courseIdFrom(title)
      if (!key) return null
      const existing = memory.courses[key]
      if (existing) {
        if (title) existing.title = clip(title, LIMITS.titleChars)
        touch(existing)
      } else {
        memory.courses[key] = {
          id: key,
          title: clip(title, LIMITS.titleChars),
          goal: {},
          progress: {},
          mistakes: [],
          jobs: [],
          updatedAt: now()
        }
      }
      if (!memory.activeCourse) memory.activeCourse = key
      write(memory)
      return memory.courses[key]
    },
    setGoal(ref, patch) {
      return mutate(ref, (course) => {
        course.goal = mergeGoal(course.goal, patch)
      })
    },
    markChapter(ref, chapter, state) {
      if (!CHAPTER_STATES.includes(state)) return { ok: false }
      return mutate(ref, (course) => {
        const index = clamp(chapter, 1, 999, 0)
        if (!index) return
        course.progress[index] = bestOf(course.progress[index], state)
      })
    },
    addMistake(ref, input) {
      const mistake = normalizeMistake(input)
      if (!mistake) return { ok: false, reason: 'empty mistake' }
      return mutate(ref, (course) => {
        const key = mistakeKey(mistake)
        course.mistakes = [mistake, ...course.mistakes.filter((entry) => mistakeKey(entry) !== key)].slice(0, LIMITS.mistakes)
      })
    },
    clearMistakes(ref) {
      return mutate(ref, (course) => {
        course.mistakes = []
      })
    },
    noteJob(ref, jobId) {
      if (!jobId) return { ok: false }
      return mutate(ref, (course) => {
        course.jobs = [jobId, ...course.jobs.filter((id) => id !== jobId)].slice(0, LIMITS.jobs)
      })
    },
    /** What `course_recall` returns: small, typed, and quiet when empty. */
    recall(ref, { mistakes = LIMITS.recallMistakes } = {}) {
      const memory = read()
      const { course, ambiguous } = resolveCourse(memory, ref)
      if (!course) {
        const titles = Object.values(memory.courses).map((entry) => ({ id: entry.id, title: entry.title }))
        return { ok: false, course: null, ambiguous, known: titles }
      }
      const limit = clamp(mistakes, 0, 20, LIMITS.recallMistakes)
      const chapters = Object.entries(course.progress)
        .map(([index, state]) => ({ chapter: Number(index), state }))
        .sort((left, right) => left.chapter - right.chapter)
      return {
        ok: true,
        course: { id: course.id, title: course.title, updatedAt: course.updatedAt },
        goal: course.goal,
        progress: {
          done: chapters.filter((row) => rankOf(row.state) >= rankOf('explained')).length,
          touched: chapters.length,
          chapters
        },
        mistakes: {
          total: course.mistakes.length,
          recent: limit ? course.mistakes.slice(0, limit) : []
        },
        jobs: course.jobs
      }
    }
  }
}
