/**
 * DSH Data Sync — git transport.
 *
 * The repository is the transport, not a storage engine: history, diffs and
 * conflict detection come from git itself. Every command is spawned directly
 * (no shell, no interactive prompt) and its output is capped and redacted.
 */
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { spawn } from 'node:child_process'
import { exists, ensureDir, messageOf } from './util.js'

const OUTPUT_LIMIT = 1024 * 1024
const DEFAULT_TIMEOUT = 180000

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/** Basic-auth header for the token, never placed in a URL or a log line. */
function authArgs(token, repoUrl) {
  if (!token) return []
  // The stored token is a GitHub token: attaching the header to every command
  // for a non-GitHub remote would send it to that host as well.
  let host = ''
  try {
    host = new URL(String(repoUrl || '')).hostname.toLowerCase()
  } catch {
    host = ''
  }
  if (host !== 'github.com' && !host.endsWith('.github.com')) return []
  const encoded = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')
  return ['-c', `http.extraheader=AUTHORIZATION: basic ${encoded}`]
}

function redact(text, token) {
  if (!token) return text
  const encoded = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64')
  return String(text).split(token).join('***').split(encoded).join('***')
}

/** A branch name is spliced into refspecs, so keep it a plain ref name. */
export function assertBranch(cfg) {
  const branch = String(cfg.branch || '')
  if (branch === '' || branch.startsWith('-') || !/^[A-Za-z0-9._\/-]+$/.test(branch)) {
    throw fail('BRANCH_INVALID', `"${branch}" is not a usable branch name`)
  }
  return branch
}

/**
 * Run git. Resolves `{ code, stdout, stderr }`; rejects only when git itself is
 * missing or the process cannot start.
 */
export function runGit(args, options = {}) {
  const { cwd, token, repoUrl, timeout = DEFAULT_TIMEOUT } = options
  const prefix = authArgs(token, repoUrl)
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn('git', [...prefix, ...args], {
        cwd,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GCM_INTERACTIVE: 'never',
          LC_ALL: 'C',
        },
      })
    } catch (error) {
      reject(fail('GIT_MISSING', `git could not be started: ${messageOf(error)}`))
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        // On Windows `git` is a wrapper: killing only the direct child leaves
        // git-remote-https running and an index.lock behind.
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        } else {
          child.kill('SIGKILL')
        }
      } catch {
        // already gone
      }
      reject(fail('GIT_TIMEOUT', `git ${args[0] || ''} did not finish within ${Math.round(timeout / 1000)}s`))
    }, timeout)

    child.stdout.on('data', (chunk) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error.code === 'ENOENT' ? fail('GIT_MISSING', 'git is not installed or not on PATH') : error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        code: typeof code === 'number' ? code : 1,
        stdout: redact(stdout, token),
        stderr: redact(stderr, token),
      })
    })
  })
}

function gitFailure(action, result) {
  const detail = (result.stderr || result.stdout || '').trim().split(/\r?\n/).slice(-6).join(' | ')
  return fail('GIT_FAILED', `git ${action} failed (exit ${result.code})${detail ? `: ${detail}` : ''}`)
}

/* ------------------------------------------------------------------ repository */

/** Parse `https://github.com/owner/repo(.git)` and `git@github.com:owner/repo.git`. */
export function parseRepoUrl(repoUrl) {
  const text = String(repoUrl || '').trim()
  const https = /^https?:\/\/([^/]+)\/([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/i.exec(text)
  if (https) return { host: https[1].toLowerCase(), owner: https[2], name: https[3] }
  const ssh = /^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/i.exec(text)
  if (ssh) return { host: ssh[1].toLowerCase(), owner: ssh[2], name: ssh[3] }
  return null
}

/** Refuse credentials embedded in the URL: they would end up in `.git/config`. */
export function assertCleanUrl(repoUrl) {
  if (/^[a-z+]+:\/\/[^/]*@/i.test(String(repoUrl || ''))) {
    throw fail('CREDENTIAL_IN_URL', 'the repository URL contains credentials; remove them and use the token field instead')
  }
}

async function lsRemoteHeads(cfg, token) {
  const result = await runGit(['ls-remote', '--heads', 'origin'], { cwd: cfg.repoDir, token, repoUrl: cfg.repoUrl })
  if (result.code !== 0) return { ok: false, heads: [], result }
  const heads = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const [, ref] = line.split(/\s+/)
      return ref ? ref.replace('refs/heads/', '') : ''
    })
    .filter((name) => name !== '')
  return { ok: true, heads, result }
}

/**
 * Make sure `cfg.repoDir` is a clone of `cfg.repoUrl` on `cfg.branch`.
 * Resolves `{ cloned, branchExists }`.
 */
export async function ensureRepo(cfg, token, log) {
  if (!cfg.repoUrl) throw fail('NO_REPO', 'no repository URL is configured yet')
  assertCleanUrl(cfg.repoUrl)
  assertBranch(cfg)
  const repoDir = cfg.repoDir
  let cloned = false
  if (!exists(path.join(repoDir, '.git'))) {
    await ensureDir(path.dirname(repoDir))
    try {
      const stat = await fsp.stat(repoDir)
      if (stat.isDirectory()) {
        const entries = await fsp.readdir(repoDir)
        if (entries.length > 0) {
          throw fail('REPO_DIR_BUSY', `${repoDir} exists and is not empty; move it away or point dataDir elsewhere`)
        }
      }
    } catch (error) {
      if (error && error.code === 'REPO_DIR_BUSY') throw error
    }
    const cloneArgs = ['clone', '--no-tags', cfg.repoUrl, repoDir]
    const result = await runGit(cloneArgs, { cwd: path.dirname(repoDir), token, repoUrl: cfg.repoUrl, timeout: 300000 })
    if (result.code !== 0) throw gitFailure('clone', result)
    cloned = true
    if (log) await log.append('info', `cloned ${cfg.repoUrl} into ${repoDir}`)
  } else {
    const current = await runGit(['remote', 'get-url', 'origin'], { cwd: repoDir, token })
    const url = current.stdout.trim()
    if (current.code !== 0 || url !== cfg.repoUrl) {
      const setUrl = await runGit(['remote', 'set-url', 'origin', cfg.repoUrl], { cwd: repoDir, token })
      if (setUrl.code !== 0) throw gitFailure('remote set-url', setUrl)
      const setPush = await runGit(['remote', 'set-url', '--push', 'origin', cfg.repoUrl], { cwd: repoDir, token })
      if (setPush.code !== 0) throw gitFailure('remote set-url --push', setPush)
    }
    const fetch = await runGit(['fetch', '--prune', 'origin'], { cwd: repoDir, token, repoUrl: cfg.repoUrl })
    if (fetch.code !== 0) throw gitFailure('fetch', fetch)
  }
  await runGit(['config', 'user.name', cfg.deviceName], { cwd: repoDir, token })
  await runGit(['config', 'user.email', 'data-sync@localhost'], { cwd: repoDir, token })
  await runGit(['config', 'core.quotepath', 'off'], { cwd: repoDir, token })

  const remote = await lsRemoteHeads(cfg, token)
  const branchExists = remote.ok && remote.heads.includes(cfg.branch)
  if (branchExists) {
    const checkout = await runGit(['checkout', '-q', '-B', cfg.branch, `origin/${cfg.branch}`], { cwd: repoDir, token })
    if (checkout.code !== 0) throw gitFailure('checkout', checkout)
  } else {
    const checkout = await runGit(['checkout', '-q', '-B', cfg.branch], { cwd: repoDir, token })
    if (checkout.code !== 0) throw gitFailure('checkout', checkout)
  }
  return { cloned, branchExists }
}

/** Read `manifest.json` from the remote branch without touching the working tree. */
export async function readRemoteManifest(cfg, token) {
  const fetch = await runGit(['fetch', '--prune', 'origin'], { cwd: cfg.repoDir, token })
  if (fetch.code !== 0) throw gitFailure('fetch', fetch)
  const commitResult = await runGit(['rev-parse', `origin/${cfg.branch}`], { cwd: cfg.repoDir, token })
  const commit = commitResult.code === 0 ? commitResult.stdout.trim() : ''
  if (commit === '') return { manifest: null, commit: '', missing: true }
  const show = await runGit(['show', `origin/${cfg.branch}:manifest.json`], { cwd: cfg.repoDir, token })
  if (show.code !== 0) return { manifest: null, commit, missing: true }
  try {
    return { manifest: JSON.parse(show.stdout), commit, missing: false }
  } catch {
    throw fail('MANIFEST_INVALID', 'the repository contains a manifest.json that is not valid JSON')
  }
}

/**
 * Make the local clone mirror the remote branch: this plugin only ever commits
 * snapshots it is about to push, so nothing local can be lost here, and it lets
 * the caller read the payload straight from the working tree.
 */
export async function resetToRemote(cfg, token, commit) {
  assertBranch(cfg)
  const fetch = await runGit(['fetch', '--prune', 'origin'], { cwd: cfg.repoDir, token, repoUrl: cfg.repoUrl })
  if (fetch.code !== 0) throw gitFailure('fetch', fetch)
  const remote = await lsRemoteHeads(cfg, token)
  if (!remote.ok || !remote.heads.includes(cfg.branch)) {
    return { manifest: null, commit: '', missing: true }
  }
  let target = `origin/${cfg.branch}`
  if (typeof commit === 'string' && commit.trim() !== '') {
    const wanted = commit.trim()
    const verify = await runGit(['rev-parse', '--verify', `${wanted}^{commit}`], { cwd: cfg.repoDir, token })
    if (verify.code !== 0) throw fail('COMMIT_NOT_FOUND', `the repository has no commit "${wanted}"`)
    const resolved = verify.stdout.trim()
    const ancestor = await runGit(['merge-base', '--is-ancestor', resolved, `origin/${cfg.branch}`], { cwd: cfg.repoDir, token })
    if (ancestor.code !== 0) throw fail('COMMIT_UNREACHABLE', 'that commit is not part of the remote branch history')
    target = resolved
  }
  const reset = await runGit(['reset', '--hard', target], { cwd: cfg.repoDir, token })
  if (reset.code !== 0) throw gitFailure('reset', reset)
  const commitResult = await runGit(['rev-parse', 'HEAD'], { cwd: cfg.repoDir, token })
  const headCommit = commitResult.code === 0 ? commitResult.stdout.trim() : ''
  let manifest = null
  try {
    manifest = JSON.parse(await fsp.readFile(path.join(cfg.repoDir, 'manifest.json'), 'utf8'))
  } catch {
    manifest = null
  }
  return { manifest, commit: headCommit, missing: manifest === null }
}

/**
 * Working-tree cleanliness plus the local commit position, so a push whose
 * payload is unchanged can be skipped instead of adding an empty history entry.
 */
export async function repoState(cfg, token) {
  const status = await runGit(['status', '--porcelain'], { cwd: cfg.repoDir, token })
  const head = await runGit(['rev-parse', 'HEAD'], { cwd: cfg.repoDir, token })
  const counts = await runGit(['rev-list', '--count', `origin/${cfg.branch}..HEAD`], { cwd: cfg.repoDir, token })
  return {
    clean: status.code === 0 && status.stdout.trim() === '',
    head: head.code === 0 ? head.stdout.trim() : '',
    ahead: counts.code === 0 ? Number.parseInt(counts.stdout.trim(), 10) || 0 : 0,
  }
}

/** Stage everything, commit when something changed, and push. */
export async function commitAndPush(cfg, token, message) {
  assertBranch(cfg)
  const push = async (sha) => {
    const result = await runGit(['push', 'origin', `HEAD:${cfg.branch}`], { cwd: cfg.repoDir, token, repoUrl: cfg.repoUrl, timeout: 300000 })
    if (result.code !== 0) {
      const detail = (result.stderr || result.stdout || '').trim().split(/\r?\n/).slice(-4).join(' | ')
      throw fail(
        'PUSH_REJECTED',
        `the remote rejected the push${detail ? `: ${detail}` : ''}. The remote has commits this machine does not have; check the remote and apply a pull before pushing again.`,
      )
    }
    return sha
  }
  const add = await runGit(['add', '-A'], { cwd: cfg.repoDir, token })
  if (add.code !== 0) throw gitFailure('add', add)
  const staged = await runGit(['diff', '--cached', '--quiet'], { cwd: cfg.repoDir, token })
  if (staged.code === 0) {
    // Nothing new to commit — but a previous run may have committed and then
    // failed to push, which leaves the local branch ahead of the remote. Pushing
    // that commit is the difference between "the remote has it" and a lie.
    const head = await runGit(['rev-parse', 'HEAD'], { cwd: cfg.repoDir, token })
    const sha = head.code === 0 ? head.stdout.trim() : ''
    // `origin/<branch>..HEAD` is unusable before the remote branch exists, so
    // count commits that no remote ref contains instead.
    const ahead = await runGit(['rev-list', '--count', 'HEAD', '--not', '--remotes'], { cwd: cfg.repoDir, token })
    const count = ahead.code === 0 ? Number.parseInt(ahead.stdout.trim(), 10) || 0 : 0
    if (count > 0) {
      await push(sha)
      return { commit: sha, pushed: true, upToDate: false, recovered: true }
    }
    return { commit: sha, pushed: false, upToDate: true }
  }
  const commit = await runGit(['commit', '-q', '-m', message], { cwd: cfg.repoDir, token })
  if (commit.code !== 0) throw gitFailure('commit', commit)
  const head = await runGit(['rev-parse', 'HEAD'], { cwd: cfg.repoDir, token })
  const sha = head.code === 0 ? head.stdout.trim() : ''
  await push(sha)
  return { commit: sha, pushed: true, upToDate: false }
}

export async function gitLog(cfg, token, limit) {
  const count = Math.min(100, Math.max(1, limit || 20))
  const result = await runGit(['log', `-n${count}`, '--format=%H%x1f%aI%x1f%s', 'HEAD'], { cwd: cfg.repoDir, token })
  if (result.code !== 0) return []
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const [hash, date, subject] = line.split('\u001f')
      const match = /snapshot[ :]+([0-9]{8}-[0-9]{6}-[0-9a-f]{6})/i.exec(subject || '')
      return { hash: hash || '', date: date || '', message: subject || '', snapshotId: match ? match[1] : '' }
    })
}

export async function aheadBehind(cfg, token) {
  const result = await runGit(['rev-list', '--left-right', '--count', `origin/${cfg.branch}...HEAD`], { cwd: cfg.repoDir, token })
  const head = await runGit(['rev-parse', 'HEAD'], { cwd: cfg.repoDir, token })
  const remoteHead = await runGit(['rev-parse', `origin/${cfg.branch}`], { cwd: cfg.repoDir, token })
  if (result.code !== 0) return { behind: 0, ahead: 0, headCommit: '', remoteHead: '' }
  const [behind, ahead] = result.stdout.trim().split(/\s+/).map((value) => Number.parseInt(value, 10) || 0)
  return {
    behind: behind || 0,
    ahead: ahead || 0,
    headCommit: head.code === 0 ? head.stdout.trim() : '',
    remoteHead: remoteHead.code === 0 ? remoteHead.stdout.trim() : '',
  }
}

/* --------------------------------------------------------------- GitHub API */

function parseGitHubRepo(repoUrl) {
  const parsed = parseRepoUrl(repoUrl)
  if (!parsed || parsed.host !== 'github.com') return null
  return parsed
}

async function githubRequest(method, url, token) {
  if (!token) throw fail('TOKEN_REQUIRED', 'this action needs a GitHub token')
  let response
  try {
    response = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'dsh-data-sync',
        'content-type': 'application/json',
      },
      body: method === 'POST' ? JSON.stringify({}) : undefined,
      signal: AbortSignal.timeout(15000),
    })
  } catch (error) {
    throw fail('NETWORK', `GitHub API is unreachable: ${messageOf(error)}`)
  }
  if (response.status === 401) throw fail('TOKEN_INVALID', 'GitHub rejected the token (401)')
  if (response.status === 403) throw fail('TOKEN_FORBIDDEN', 'the token is not allowed to do this (403)')
  if (response.status === 404) return { status: 404, json: null }
  if (!response.ok) throw fail('GITHUB_API', `GitHub API returned ${response.status}`)
  const json = await response.json().catch(() => null)
  return { status: response.status, json }
}

/** `{ exists, isPrivate, fullName }` for a github.com repository URL. */
export async function verifyRepoPrivate(repoUrl, token) {
  const parsed = parseGitHubRepo(repoUrl)
  if (!parsed) return { exists: false, isPrivate: false, fullName: '' }
  if (!token) return { exists: false, isPrivate: false, fullName: `${parsed.owner}/${parsed.name}` }
  const { status, json } = await githubRequest('GET', `https://api.github.com/repos/${parsed.owner}/${parsed.name}`, token)
  if (status === 404) return { exists: false, isPrivate: false, fullName: `${parsed.owner}/${parsed.name}` }
  if (!json || typeof json.private !== 'boolean') {
    // A proxy portal or an unexpected payload: do not claim the repository is public.
    return { exists: true, isPrivate: false, unknown: true, fullName: (json && json.full_name) || `${parsed.owner}/${parsed.name}` }
  }
  return { exists: true, isPrivate: json.private, fullName: json.full_name || `${parsed.owner}/${parsed.name}` }
}

/** Create a **private** repository for the signed-in token and return its URL. */
export async function createPrivateRepo(name, token, description) {
  const clean = String(name || '').trim()
  if (!/^[A-Za-z0-9._-]+$/.test(clean)) throw fail('INVALID_NAME', 'the repository name may only contain letters, digits, dot, dash and underscore')
  let response
  try {
    response = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'dsh-data-sync',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: clean, private: true, auto_init: false, description: description || 'DeepSeek Harness configuration and memory snapshot (created by DSH Data Sync)' }),
      signal: AbortSignal.timeout(20000),
    })
  } catch (error) {
    throw fail('NETWORK', `GitHub API is unreachable: ${messageOf(error)}`)
  }
  const json = await response.json().catch(() => null)
  if (response.status === 401) throw fail('TOKEN_INVALID', 'GitHub rejected the token (401)')
  if (response.status === 422) throw fail('REPO_EXISTS', 'a repository with this name already exists for the account')
  if (!response.ok) throw fail('GITHUB_API', `GitHub API returned ${response.status}`)
  if (!json || json.private !== true) throw fail('NOT_PRIVATE', 'GitHub did not confirm the created repository is private')
  return { url: json.html_url, fullName: json.full_name }
}
