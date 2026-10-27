/**
 * DSH Data Sync — shared utilities.
 *
 * Paths, config resolution, atomic JSON, the local state/config/credential
 * files and the append-only log. Nothing here touches the network or git.
 */
import path from 'node:path'
import os from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { promises as fsp, existsSync } from 'node:fs'

export const PACKAGE = '@local/dsh-data-sync'
export const NS = 'dataSync'
export const SCHEMA = 'dsh-data-sync/1'

/** A single file larger than this is skipped with a warning. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024
/** A snapshot larger than this is refused; it is not what this plugin is for. */
export const MAX_TOTAL_BYTES = 96 * 1024 * 1024

export const TEXT_EXTENSIONS = new Set([
  '.json', '.json5', '.jsonc', '.yaml', '.yml', '.md', '.txt', '.toml',
  '.ini', '.cfg', '.conf', '.sh', '.ps1', '.js', '.mjs', '.cjs', '.ts', '.css',
])

/* ------------------------------------------------------------- primitives */

export function posix(value) {
  return String(value).split(path.sep).join('/')
}

export function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

export function shortId() {
  return randomBytes(3).toString('hex')
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export function messageOf(error) {
  if (!error) return 'unknown error'
  const text = typeof error === 'string' ? error : error.message || String(error)
  return text.replace(/\s+/g, ' ').trim()
}

export function clampInt(value, fallback, min, max) {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(max, Math.max(min, n))
}

export function toBool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** True when `target` is `root` itself or strictly inside it. */
export function pathInside(root, target) {
  if (!root || !target) return false
  const rel = path.relative(path.resolve(root), path.resolve(target))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function isTextName(name) {
  const ext = path.extname(String(name || '')).toLowerCase()
  if (TEXT_EXTENSIONS.has(ext)) return true
  return ext === ''
}

export function homeDir() {
  return process.env.USERPROFILE || os.homedir()
}

export function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv !== '' ? fromEnv : path.join(homeDir(), '.dsh')
}

export function defaultProfile() {
  const fromEnv = typeof process.env.DSH_PROFILE === 'string' ? process.env.DSH_PROFILE.trim() : ''
  return fromEnv !== '' ? fromEnv : 'web'
}

export function slugify(value) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug !== '' ? slug : 'workspace'
}

/* ------------------------------------------------------------------- files */

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true })
  return dir
}

export async function readJson(file, fallback = null) {
  try {
    const text = await fsp.readFile(file, 'utf8')
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

/** Write JSON through a same-directory temporary file plus rename. */
export async function writeJsonAtomic(file, value) {
  await ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${shortId()}.tmp`
  const text = `${JSON.stringify(value, null, 2)}\n`
  await fsp.writeFile(tmp, text, 'utf8')
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fsp.rename(tmp, file)
      return
    } catch (error) {
      if (attempt === 3) throw error
      await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1)))
    }
  }
}

/* ------------------------------------------------------------------ config */

/**
 * Resolve the patch-provided config into the full shape. A saved
 * `dataDir/config.json` (written by the Settings page) is merged on top later
 * by `mergeSaved`, so the profile patch stays the portable default and the UI
 * never has to rewrite `cordis.patch.yml`.
 */
export function resolveConfig(raw) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  // `dshHome` is not part of the portable config: it exists so tests and tools
  // can point the collector at a fixture without rewriting the environment.
  const explicitHome = typeof cfg.dshHome === 'string' && cfg.dshHome.trim() !== '' ? path.resolve(cfg.dshHome) : ''
  const dsh = explicitHome !== '' ? explicitHome : dshHome()
  const profile = typeof cfg.profile === 'string' && cfg.profile.trim() !== '' ? cfg.profile.trim() : defaultProfile()
  const dataDir = typeof cfg.dataDir === 'string' && cfg.dataDir.trim() !== '' ? path.resolve(cfg.dataDir) : path.join(dsh, 'dsh-data-sync')
  const sources = cfg.sources && typeof cfg.sources === 'object' ? cfg.sources : {}
  const auto = cfg.autoBackup && typeof cfg.autoBackup === 'object' ? cfg.autoBackup : {}
  const resolved = {
    dshHome: dsh,
    profile,
    profileDir: path.join(dsh, 'profiles', profile),
    dataDir,
    repoDir: path.join(dataDir, 'repo'),
    backupDir: path.join(dataDir, 'backups'),
    statePath: path.join(dataDir, 'state.json'),
    configPath: path.join(dataDir, 'config.json'),
    credentialsPath: path.join(dataDir, 'credentials.json'),
    logPath: path.join(dataDir, 'sync.log'),
    repoUrl: typeof cfg.repoUrl === 'string' ? cfg.repoUrl.trim() : '',
    branch: typeof cfg.branch === 'string' && cfg.branch.trim() !== '' ? cfg.branch.trim() : 'main',
    deviceName: typeof cfg.deviceName === 'string' && cfg.deviceName.trim() !== '' ? cfg.deviceName.trim() : os.hostname(),
    sources: {
      config: toBool(sources.config, true),
      memory: toBool(sources.memory, true),
      skills: toBool(sources.skills, true),
    },
    memoryDir: typeof cfg.memoryDir === 'string' && cfg.memoryDir.trim() !== '' ? path.resolve(cfg.memoryDir) : '',
    workspaceRoots: Array.isArray(cfg.workspaceRoots)
      ? cfg.workspaceRoots
          .filter((row) => row && typeof row.path === 'string' && row.path.trim() !== '')
          .map((row) => ({
            label: typeof row.label === 'string' && row.label.trim() !== '' ? row.label.trim() : slugify(row.path),
            path: path.resolve(row.path),
          }))
      : [],
    pathMappings: Array.isArray(cfg.pathMappings)
      ? cfg.pathMappings
          .filter((row) => row && typeof row.from === 'string' && row.from !== '')
          .map((row) => ({ from: row.from, to: typeof row.to === 'string' ? row.to : '' }))
      : [],
    keepSnapshots: clampInt(cfg.keepSnapshots, 10, 1, 99),
    autoBackup: {
      enabled: toBool(auto.enabled, false),
      intervalHours: clampInt(auto.intervalHours, 24, 1, 24 * 30),
    },
    allowSecrets: toBool(cfg.allowSecrets, false),
  }
  if (resolved.memoryDir === '') resolved.memoryDir = path.join(dsh, 'storages', 'memory')
  return resolved
}

/** Merge a saved config document (from `dataDir/config.json`) over the patch config. */
export function mergeSaved(cfg, saved) {
  if (!saved || typeof saved !== 'object') return cfg
  const merged = { ...cfg }
  for (const key of ['repoUrl', 'branch', 'profile', 'memoryDir', 'deviceName']) {
    if (typeof saved[key] === 'string' && saved[key].trim() !== '') merged[key] = key === 'memoryDir' ? path.resolve(saved[key]) : saved[key].trim()
  }
  if (saved.sources && typeof saved.sources === 'object') {
    merged.sources = {
      config: toBool(saved.sources.config, cfg.sources.config),
      memory: toBool(saved.sources.memory, cfg.sources.memory),
      skills: toBool(saved.sources.skills, cfg.sources.skills),
    }
  }
  if (Array.isArray(saved.workspaceRoots)) {
    merged.workspaceRoots = saved.workspaceRoots
      .filter((row) => row && typeof row.path === 'string' && row.path.trim() !== '')
      .map((row) => ({
        label: typeof row.label === 'string' && row.label.trim() !== '' ? row.label.trim() : slugify(row.path),
        path: path.resolve(row.path),
      }))
  }
  if (Array.isArray(saved.pathMappings)) {
    merged.pathMappings = saved.pathMappings
      .filter((row) => row && typeof row.from === 'string' && row.from !== '')
      .map((row) => ({ from: row.from, to: typeof row.to === 'string' ? row.to : '' }))
  }
  if (Number.isFinite(saved.keepSnapshots)) merged.keepSnapshots = clampInt(saved.keepSnapshots, 10, 1, 99)
  if (saved.autoBackup && typeof saved.autoBackup === 'object') {
    merged.autoBackup = {
      enabled: toBool(saved.autoBackup.enabled, cfg.autoBackup.enabled),
      intervalHours: clampInt(saved.autoBackup.intervalHours, cfg.autoBackup.intervalHours, 1, 24 * 30),
    }
  }
  if (typeof saved.allowSecrets === 'boolean') merged.allowSecrets = saved.allowSecrets
  return merged
}

/** The subset of the resolved config that is written back to `config.json`. */
export function portableConfig(cfg) {
  return {
    repoUrl: cfg.repoUrl,
    branch: cfg.branch,
    profile: cfg.profile,
    deviceName: cfg.deviceName,
    memoryDir: cfg.memoryDir,
    sources: cfg.sources,
    workspaceRoots: cfg.workspaceRoots,
    pathMappings: cfg.pathMappings,
    keepSnapshots: cfg.keepSnapshots,
    autoBackup: cfg.autoBackup,
    allowSecrets: cfg.allowSecrets,
  }
}

/* -------------------------------------------------------------------- log */

export function createLog(logPath, limit = 400) {
  let chain = Promise.resolve()
  async function append(level, text) {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${String(text).replace(/\s+/g, ' ').trim()}`
    chain = chain
      .then(async () => {
        await ensureDir(path.dirname(logPath))
        let existing = ''
        try {
          existing = await fsp.readFile(logPath, 'utf8')
        } catch {
          existing = ''
        }
        const lines = existing.split(/\r?\n/).filter((row) => row !== '')
        lines.push(line)
        const kept = lines.slice(-limit)
        await fsp.writeFile(logPath, `${kept.join('\n')}\n`, 'utf8')
      })
      .catch(() => {})
    return chain
  }
  async function tail(count = 20) {
    try {
      const text = await fsp.readFile(logPath, 'utf8')
      return text.split(/\r?\n/).filter((row) => row !== '').slice(-count)
    } catch {
      return []
    }
  }
  return { append, tail }
}

/* ------------------------------------------------------------------ state */

const EMPTY_STATE = {
  deviceId: '',
  lastPush: null,
  lastPull: null,
  lastBackup: null,
  autoBackup: { lastRunAt: 0, lastError: '' },
  remote: null,
}

export function createState(statePath) {
  let cache = null
  async function read() {
    if (cache) return cache
    const saved = await readJson(statePath, null)
    const state = { ...EMPTY_STATE, ...(saved && typeof saved === 'object' ? saved : {}) }
    if (!state.autoBackup || typeof state.autoBackup !== 'object') state.autoBackup = { lastRunAt: 0, lastError: '' }
    if (typeof state.deviceId !== 'string' || state.deviceId === '') {
      state.deviceId = randomBytes(8).toString('hex')
      await writeJsonAtomic(statePath, state).catch(() => {})
    }
    cache = state
    return state
  }
  async function patch(partial) {
    const state = { ...(await read()), ...partial }
    cache = state
    await writeJsonAtomic(statePath, state)
    return state
  }
  return { read, patch }
}

/* ------------------------------------------------------------ credentials */

export function createCredentials(credentialsPath, log) {
  async function readToken() {
    const saved = await readJson(credentialsPath, null)
    return saved && typeof saved.token === 'string' && saved.token.trim() !== '' ? saved.token.trim() : ''
  }
  async function writeToken(token) {
    const clean = typeof token === 'string' ? token.trim() : ''
    if (clean === '') {
      await fsp.rm(credentialsPath, { force: true }).catch(() => {})
      return false
    }
    await writeJsonAtomic(credentialsPath, { token: clean, updatedAt: Date.now() })
    try {
      await fsp.chmod(credentialsPath, 0o600)
    } catch {
      // Windows has no meaningful mode bits; the file stays local either way.
    }
    if (log) await log.append('info', 'credential file updated')
    return true
  }
  return { readToken, writeToken }
}

export function exists(file) {
  return existsSync(file)
}
