/**
 * DSH Data Sync — collector.
 *
 * A finite whitelist, never "walk everything and exclude". Every category is
 * named explicitly, a deny-list runs in front of every tree walk, and a secret
 * screen inspects the text payload before a snapshot is allowed to leave the
 * machine.
 */
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import {
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  isTextName,
  messageOf,
  posix,
  sha256,
  slugify,
} from './util.js'

/** Home-level configuration documents, relative to `$DSH_HOME`. */
const HOME_CONFIG_FILES = ['settings.yaml', 'AGENTS.md', 'cordis.patch.yml']

/** Per-profile documents that make the plugin stack reproducible. */
function profileConfigFiles(profile) {
  const base = `profiles/${profile}`
  return [
    `${base}/package.json`,
    `${base}/cordis.patch.yml`,
    `${base}/cordis.yml`,
    `${base}/pnpm-lock.yaml`,
    `${base}/pnpm-workspace.yaml`,
    `${base}/.dsh-market/state.json`,
  ]
}

/** Skill / preset trees under `$DSH_HOME`. */
const HOME_SKILL_TREES = ['skills', '.agent-presets', 'agents']

/** Trees inside each configured workspace root. */
const WORKSPACE_TREES = ['.dsh/skills', '.dsh/agents', '.dsh/agent-presets', '.dsh/commands']

const DENY_DIRS = new Set(['.git', 'node_modules', 'secrets', '.venv', 'venv', '__pycache__', 'dist', 'build', '.pnpm', 'cache'])
const DENY_FILES = new Set([
  '.credentials.yaml',
  'credentials.json',
  '.env',
  'id_rsa',
  'id_ed25519',
  '.anonymous-user-id',
  'cookies.json',
])
const DENY_PATTERNS = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|pfx|p12|keystore|jks)$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /\.(log|sqlite3?|db|db-wal|db-shm|ldb)$/i,
  /^\.DS_Store$/i,
  /^token(\.json)?$/i,
]

/** Why a path is refused, or `''` when it is allowed. */
export function denialReason(rel) {
  const segments = posix(rel).split('/').filter((row) => row !== '')
  for (const segment of segments.slice(0, -1)) {
    if (DENY_DIRS.has(segment.toLowerCase())) return `denied directory "${segment}"`
  }
  const base = segments.length > 0 ? segments[segments.length - 1] : ''
  const lower = base.toLowerCase()
  if (DENY_FILES.has(lower)) return `denied file "${base}"`
  for (const pattern of DENY_PATTERNS) {
    if (pattern.test(base)) return `denied pattern "${base}"`
  }
  return ''
}

/**
 * Collect every file the configured sources ask for.
 *
 * Returns `{ snapshotId, files, warnings, secretFindings, bySource, count, bytes }`
 * where each file is `{ source, rel, abs, size, sha256 }`.
 */
export async function collectFiles(cfg) {
  const files = []
  const warnings = []
  const seen = new Set()
  const bySource = { config: 0, memory: 0, skills: 0, workspace: 0 }

  let total = 0

  async function addFile(source, rel, abs) {
    const key = `${source}:${rel}`
    if (seen.has(key)) {
      warnings.push(`skipped ${rel}: duplicates an earlier entry from another root`)
      return
    }
    if (rel.includes('..') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) {
      warnings.push(`skipped ${rel}: this path cannot be represented in a snapshot`)
      return
    }
    const reason = denialReason(rel)
    if (reason !== '') {
      warnings.push(`skipped ${rel}: ${reason}`)
      return
    }
    let stat
    try {
      stat = await fsp.lstat(abs)
    } catch {
      return
    }
    if (stat.isSymbolicLink()) {
      warnings.push(`skipped ${rel}: symbolic link`)
      return
    }
    if (!stat.isFile()) return
    if (stat.size > MAX_FILE_BYTES) {
      warnings.push(`skipped ${rel}: ${(stat.size / 1024 / 1024).toFixed(1)} MiB exceeds the ${(MAX_FILE_BYTES / 1024 / 1024).toFixed(0)} MiB per-file limit`)
      return
    }
    let buffer
    try {
      buffer = await fsp.readFile(abs)
    } catch (error) {
      warnings.push(`skipped ${rel}: ${messageOf(error)}`)
      return
    }
    total += buffer.length
    if (total > MAX_TOTAL_BYTES) {
      const error = new Error(`the selection is larger than the ${(MAX_TOTAL_BYTES / 1024 / 1024).toFixed(0)} MiB snapshot limit`)
      error.code = 'SNAPSHOT_TOO_LARGE'
      throw error
    }
    seen.add(key)
    files.push({ source, rel, abs, size: buffer.length, sha256: sha256(buffer) })
    bySource[source] = (bySource[source] || 0) + 1
  }

  async function walkTree(source, rootAbs, relBase, depth = 0) {
    if (depth > 8) {
      warnings.push(`skipped ${relBase}: deeper than 8 levels`)
      return
    }
    let entries
    try {
      entries = await fsp.readdir(rootAbs, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = path.join(rootAbs, entry.name)
      const rel = relBase === '' ? entry.name : `${relBase}/${entry.name}`
      if (denialReason(rel) !== '') continue
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        await walkTree(source, abs, rel, depth + 1)
      } else if (entry.isFile()) {
        await addFile(source, rel, abs)
      }
    }
  }

  async function addIfExists(source, rel, abs) {
    try {
      const stat = await fsp.stat(abs)
      if (stat.isFile()) await addFile(source, rel, abs)
    } catch {
      // absent files are simply not part of the snapshot
    }
  }

  if (cfg.sources.config) {
    for (const rel of [...HOME_CONFIG_FILES, ...profileConfigFiles(cfg.profile)]) {
      await addIfExists('config', rel, path.join(cfg.dshHome, rel))
    }
  }

  if (cfg.sources.skills) {
    for (const tree of HOME_SKILL_TREES) {
      const abs = path.join(cfg.dshHome, tree)
      try {
        const stat = await fsp.stat(abs)
        if (stat.isDirectory()) await walkTree('skills', abs, tree)
      } catch {
        // tree absent
      }
    }
    for (const root of cfg.workspaceRoots) {
      const label = slugify(root.label)
      for (const tree of WORKSPACE_TREES) {
        const abs = path.join(root.path, tree)
        try {
          const stat = await fsp.stat(abs)
          if (stat.isDirectory()) await walkTree('workspace', abs, `${label}/${posix(tree)}`)
        } catch {
          // tree absent
        }
      }
      await addIfExists('workspace', `${label}/AGENTS.md`, path.join(root.path, 'AGENTS.md'))
    }
  }

  if (cfg.sources.memory) {
    let entries = []
    try {
      entries = await fsp.readdir(cfg.memoryDir, { withFileTypes: true })
    } catch {
      warnings.push(`memory directory not found: ${cfg.memoryDir}`)
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!/\.(json|md)$/i.test(entry.name)) continue
      await addFile('memory', entry.name, path.join(cfg.memoryDir, entry.name))
    }
  }

  files.sort((left, right) => (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : left.source < right.source ? -1 : 1))
  const bytes = files.reduce((sum, file) => sum + file.size, 0)
  return {
    files,
    warnings,
    bySource,
    count: files.length,
    bytes,
    secretFindings: await scanForSecrets(files),
  }
}

/* ------------------------------------------------------------ secret screen */

const SCAN_LIMIT_BYTES = 2 * 1024 * 1024

const SECRET_PATTERNS = [
  { kind: 'private-key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { kind: 'github-token', pattern: /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { kind: 'openai-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { kind: 'aws-key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'slack-token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: 'google-key', pattern: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
]

const GENERIC_PATTERN = /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret[_-]?key|client[_-]?secret|refresh[_-]?token|password|passwd|bearer)\b["']?\s*[:=]\s*["']?([^\s"',}]{12,})["']?/i

/** Values that are references or placeholders, not secrets. */
function isReferenceValue(value) {
  const text = String(value || '').trim()
  if (text === '') return true
  if (/^\$[{]?[A-Za-z_][A-Za-z0-9_]*[}]?$/.test(text)) return true
  if (/^(process\.env|import\.meta\.env)\b/.test(text)) return true
  if (/^[<{]/.test(text)) return true
  if (/^(your[-_]|xxx|example|placeholder|changeme|change-me|redacted|none|null|true|false|todo)/i.test(text)) return true
  if (/^[A-Z][A-Z0-9_]{5,}$/.test(text)) return true // ENV_VAR_NAME
  if (/\/(bin|usr|home)\//.test(text) || /^[A-Za-z]:[\\/]/.test(text)) return true // a path
  return false
}

/** Screen every text payload for credential-shaped strings. */
export async function scanForSecrets(files) {
  const findings = []
  for (const file of files) {
    if (!isTextName(file.rel) || file.size > SCAN_LIMIT_BYTES) continue
    let text
    try {
      text = await fsp.readFile(file.abs, 'utf8')
    } catch {
      continue
    }
    const lines = text.split(/\r?\n/)
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (line.length > 4000) continue
      for (const { kind, pattern } of SECRET_PATTERNS) {
        if (pattern.test(line)) findings.push({ path: file.rel, line: index + 1, kind })
      }
      const generic = GENERIC_PATTERN.exec(line)
      if (generic && !isReferenceValue(generic[2])) {
        const kind = `credential:${generic[1].toLowerCase()}`
        if (!findings.some((row) => row.path === file.rel && row.line === index + 1)) {
          findings.push({ path: file.rel, line: index + 1, kind })
        }
      }
    }
    if (findings.length > 200) break
  }
  return findings.slice(0, 200)
}

/** List the file rows a preview shows, capped for the wire. */
export function previewRows(files, limit = 300) {
  const rows = files.slice(0, limit).map((file) => ({ path: file.rel, source: file.source, size: file.size }))
  return { rows, truncated: files.length > limit }
}
