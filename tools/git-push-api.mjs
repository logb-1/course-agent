// Push a local commit's tree to GitHub through the REST API.
// Used when git over HTTPS to github.com is blocked but api.github.com works.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const [, , repo, branch, dir] = process.argv
const token = process.env.GH_TOKEN
if (!repo || !branch || !dir || !token) {
  console.error('usage: GH_TOKEN=... node push-api.mjs <owner/repo> <branch> <dir>')
  process.exit(2)
}

const api = 'https://api.github.com'
const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'user-agent': 'course-agent-push',
  'content-type': 'application/json',
}

async function call(method, path, body, attempt = 1) {
  const res = await fetch(api + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  if (!res.ok) {
    if (attempt <= 3 && (res.status >= 500 || res.status === 429)) {
      await new Promise((r) => setTimeout(r, 1000 * attempt))
      return call(method, path, body, attempt + 1)
    }
    throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 400)}`)
  }
  return text ? JSON.parse(text) : {}
}

const list = execFileSync('git', ['ls-files', '-s', '-z'], { cwd: dir, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean)
  .map((line) => {
    const [meta, path] = line.split('\t')
    const mode = meta.split(' ')[0]
    return { path, mode: mode === '100755' ? '100755' : '100644' }
  })

console.log(`files: ${list.length}`)

const entries = []
let done = 0
const queue = [...list]

// GitHub refuses blob creation while the repository has no commits at all.
async function ensureSeed() {
  const branches = await call('GET', `/repos/${repo}/branches`).catch(() => [])
  if (Array.isArray(branches) && branches.length > 0) return
  console.log('repository is empty: seeding a placeholder commit')
  await call('PUT', `/repos/${repo}/contents/.bootstrap`, {
    message: 'chore: bootstrap repository',
    content: Buffer.from('course-agent\n').toString('base64'),
  })
  for (let i = 0; i < 10; i += 1) {
    await new Promise((r) => setTimeout(r, 1500))
    const again = await call('GET', `/repos/${repo}/branches`).catch(() => [])
    if (Array.isArray(again) && again.length > 0) return
  }
  throw new Error('repository stayed empty after seeding')
}

await ensureSeed()

async function worker() {
  for (;;) {
    const item = queue.shift()
    if (!item) return
    const bytes = readFileSync(join(dir, item.path))
    let blob
    for (let attempt = 1; ; attempt += 1) {
      try {
        blob = await call('POST', `/repos/${repo}/git/blobs`, {
          content: bytes.toString('base64'),
          encoding: 'base64',
        })
        break
      } catch (error) {
        if (!String(error.message).includes('409') || attempt > 5) throw error
        await new Promise((r) => setTimeout(r, 1500 * attempt))
      }
    }
    entries.push({ path: item.path, mode: item.mode, type: 'blob', sha: blob.sha })
    done += 1
    if (done % 20 === 0) console.log(`uploaded ${done}/${list.length}`)
  }
}

await Promise.all([worker(), worker(), worker(), worker()])
entries.sort((a, b) => (a.path < b.path ? -1 : 1))

const message = execFileSync('git', ['log', '-1', '--pretty=%B'], { cwd: dir, encoding: 'utf8' }).trim()
const author = {
  name: execFileSync('git', ['log', '-1', '--pretty=%an'], { cwd: dir, encoding: 'utf8' }).trim(),
  email: execFileSync('git', ['log', '-1', '--pretty=%ae'], { cwd: dir, encoding: 'utf8' }).trim(),
  date: execFileSync('git', ['log', '-1', '--pretty=%aI'], { cwd: dir, encoding: 'utf8' }).trim(),
}

const tree = await call('POST', `/repos/${repo}/git/trees`, { tree: entries })
const commit = await call('POST', `/repos/${repo}/git/commits`, {
  message,
  tree: tree.sha,
  author,
  committer: author,
  parents: [],
})
console.log(`commit ${commit.sha}`)

try {
  await call('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha })
  console.log(`created ref refs/heads/${branch}`)
} catch (error) {
  if (!String(error.message).includes('422')) throw error
  await call('PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha: commit.sha, force: true })
  console.log(`updated ref refs/heads/${branch}`)
}
console.log('done')
