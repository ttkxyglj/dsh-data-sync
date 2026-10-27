/**
 * DSH Data Sync — Host half.
 *
 * Moves a DeepSeek Harness installation between machines through a private git
 * repository: a finite whitelist of configuration, memory and skill files is
 * snapshotted into the repository, and a pull puts it back with the recorded
 * absolute paths remapped to this machine. A local backup rotation protects
 * every pull, and git history is the remote version history.
 *
 * Shape: one service (`dataSync`) exposed as tools, a Remote namespace for the
 * Settings page, and a background scheduler for automatic backups.
 */
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import {
  NS,
  PACKAGE,
  clampInt,
  createCredentials,
  createLog,
  createState,
  ensureDir,
  exists,
  mergeSaved,
  messageOf,
  normalizeWorkspaceRoots,
  portableConfig,
  readJson,
  resolveConfig,
  writeJsonAtomic,
} from './lib/util.js'
import { collectFiles, previewRows } from './lib/collect.js'
import {
  aheadBehind,
  commitAndPush,
  createPrivateRepo,
  ensureRepo,
  fetchRemote,
  gitLog,
  pruneRemoteHistory,
  repoState,
  resetToRemote,
  verifyRepoPrivate,
} from './lib/git.js'
import {
  applyPull,
  backupNow,
  backupTargets,
  bootstrapDigest,
  buildMappings,
  buildManifest,
  listBackups,
  newSnapshotId,
  payloadDigest,
  planPull,
  rollbackTo,
  writeSnapshotTree,
} from './lib/snapshot.js'

/* ------------------------------------------------------------------ config */

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function humanBytes(bytes) {
  const value = Number(bytes) || 0
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / 1024 / 1024).toFixed(1)} MiB`
}

/** Read `storageDir` out of a patch file, or '' when it is not there. */
async function readStorageDirFromPatch(file) {
  try {
    const text = await fsp.readFile(file, 'utf8')
    const match = /^\s*storageDir:\s*['"]?([^'"\r\n#]+)['"]?\s*$/m.exec(text)
    return match && match[1].trim() !== '' ? path.resolve(match[1].trim()) : ''
  } catch {
    return ''
  }
}

/** Patch files of installed bundles, where a plugin may keep its own config. */
async function bundlePatchFiles(dshHome, profile) {
  const roots = [path.join(dshHome, 'profiles', profile, 'node_modules'), path.join(dshHome, 'node_modules')]
  const files = []
  const read = async (dir) => {
    let entries = []
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      // `link:` installs are directory symlinks/junctions on Windows, and
      // Dirent.isDirectory() is false for them — which is exactly how the memory
      // plugin is installed on this machine.
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (entry.name.startsWith('.')) continue
      if (entry.name.startsWith('@')) {
        let scoped = []
        try {
          scoped = await fsp.readdir(path.join(dir, entry.name), { withFileTypes: true })
        } catch {
          continue
        }
        for (const inner of scoped) {
          if (inner.isDirectory() || inner.isSymbolicLink()) files.push(path.join(dir, entry.name, inner.name, 'cordis.patch.yml'))
        }
      } else {
        files.push(path.join(dir, entry.name, 'cordis.patch.yml'))
      }
    }
  }
  for (const root of roots) await read(root)
  return files
}

/**
 * Find the memory store of the installed memory plugin. The `storageDir` may be
 * written in the profile patch, in the home patch, or in the installed bundle's
 * own patch — on this machine it is the bundle one, so reading only
 * `profiles/<profile>/cordis.patch.yml` silently pointed at a directory that
 * does not exist and the push "succeeded" without any memory file.
 */
async function detectMemoryDir(cfg) {
  const env = String(process.env.DSH_MEMORY_DIR || '').trim()
  const candidates = [
    await readStorageDirFromPatch(path.join(cfg.dshHome, 'cordis.patch.yml')),
    env !== '' ? path.resolve(env) : '',
    await readStorageDirFromPatch(path.join(cfg.dshHome, 'profiles', cfg.profile, 'cordis.patch.yml')),
  ]
  for (const file of await bundlePatchFiles(cfg.dshHome, cfg.profile)) {
    const found = await readStorageDirFromPatch(file)
    if (found !== '') candidates.push(found)
  }
  const usable = candidates.find((candidate) => candidate !== '' && exists(candidate))
  if (usable) return usable
  return candidates.find((candidate) => candidate !== '') || cfg.memoryDir
}

/**
 * Infer the profile this installation belongs to: the host may already have the
 * profile directory and pass it as a launch argument (DSH_PROFILE is only
 * guaranteed inside model shell calls), so prefer the profile that actually has
 * this bundle installed.
 */
async function inferProfile(dshHome, log) {
  const root = path.join(dshHome, 'profiles')
  let entries = []
  try {
    entries = await fsp.readdir(root, { withFileTypes: true })
  } catch {
    return ''
  }
  const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  if (dirs.length === 0) return ''
  const matches = []
  for (const dir of dirs) {
    try {
      const pkg = JSON.parse(await fsp.readFile(path.join(root, dir, 'package.json'), 'utf8'))
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }
      if (Object.prototype.hasOwnProperty.call(deps, PACKAGE)) matches.push(dir)
    } catch {
      // profile without a readable package.json: not a candidate
    }
  }
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    await log.append('warn', `several profiles install ${PACKAGE} (${matches.join(', ')}); set the profile explicitly in Settings`)
    return ''
  }
  return dirs.length === 1 ? dirs[0] : ''
}

/* ----------------------------------------------------------------- runtime */

function createRuntime(rawConfig) {
  const base = resolveConfig(rawConfig)
  const log = createLog(base.logPath)
  const state = createState(base.statePath)
  const credentials = createCredentials(base.credentialsPath, log)
  let cfg = base
  let readyPromise = null
  let busy = null

  async function ready() {
    if (readyPromise) return readyPromise
    readyPromise = (async () => {
      await ensureDir(cfg.dataDir)
      const rawProfile = rawConfig && typeof rawConfig === 'object' && typeof rawConfig.profile === 'string' ? rawConfig.profile.trim() : ''
      if (rawProfile === '' && String(process.env.DSH_PROFILE || '').trim() === '') {
        const inferred = await inferProfile(cfg.dshHome, log)
        if (inferred !== '' && inferred !== cfg.profile) cfg = resolveConfig({ ...(rawConfig || {}), profile: inferred })
      }
      const saved = await readJson(cfg.configPath, null)
      const patchMemoryDir = rawConfig && typeof rawConfig === 'object' && typeof rawConfig.memoryDir === 'string' ? rawConfig.memoryDir.trim() : ''
      const savedMemoryDir = saved && typeof saved.memoryDir === 'string' ? saved.memoryDir.trim() : ''
      cfg = mergeSaved(cfg, saved)
      if (patchMemoryDir === '') {
        const detected = await detectMemoryDir(cfg)
        // A saved path that no longer exists (or is the portable fallback) must not
        // win over a memory store that is actually present: on this machine the
        // bundle patch says D:\dsh-memory while an older save stored the fallback.
        if (detected !== '' && detected !== cfg.memoryDir && !exists(cfg.memoryDir)) {
          await log.append('info', `memory directory resolved to ${detected} (configured ${cfg.memoryDir} does not exist)`)
          cfg.memoryDir = detected
        } else if (savedMemoryDir === '' && detected !== '') {
          cfg.memoryDir = detected
        }
      }
      return cfg
    })()
    return readyPromise
  }

  async function reload() {
    readyPromise = null
    return ready()
  }

  /** Serialize the operations that write the repository or this machine. */
  function exclusive(task) {
    const run = (busy || Promise.resolve()).then(task, task)
    busy = run.catch(() => {})
    return run
  }

  async function currentToken() {
    const token = await credentials.readToken()
    return token
  }

  async function saveConfig(request) {
    const input = request && typeof request === 'object' ? request : {}
    const next = { ...portableConfig(cfg) }
    if (typeof input.repoUrl === 'string') next.repoUrl = input.repoUrl.trim()
    if (typeof input.branch === 'string' && input.branch.trim() !== '') next.branch = input.branch.trim()
    if (typeof input.profile === 'string' && input.profile.trim() !== '') next.profile = input.profile.trim()
    if (typeof input.deviceName === 'string' && input.deviceName.trim() !== '') next.deviceName = input.deviceName.trim()
    if (typeof input.memoryDir === 'string') {
      const value = input.memoryDir.trim()
      // An empty value means "detect it again" rather than "keep the old one".
      next.memoryDir = value === '' ? '' : path.resolve(value)
    }
    if (input.sources && typeof input.sources === 'object') {
      next.sources = {
        config: typeof input.sources.config === 'boolean' ? input.sources.config : cfg.sources.config,
        memory: typeof input.sources.memory === 'boolean' ? input.sources.memory : cfg.sources.memory,
        skills: typeof input.sources.skills === 'boolean' ? input.sources.skills : cfg.sources.skills,
      }
    }
    if (Array.isArray(input.workspaceRoots)) next.workspaceRoots = normalizeWorkspaceRoots(input.workspaceRoots)
    if (Array.isArray(input.pathMappings)) {
      next.pathMappings = input.pathMappings
        .filter((row) => row && typeof row.from === 'string' && row.from.trim() !== '')
        .map((row) => ({ from: row.from.trim(), to: typeof row.to === 'string' ? row.to.trim() : '' }))
    }
    if (Number.isFinite(input.keepSnapshots)) next.keepSnapshots = clampInt(input.keepSnapshots, cfg.keepSnapshots, 1, 99)
    if (input.autoBackup && typeof input.autoBackup === 'object') {
      next.autoBackup = {
        enabled: typeof input.autoBackup.enabled === 'boolean' ? input.autoBackup.enabled : cfg.autoBackup.enabled,
        intervalHours: clampInt(input.autoBackup.intervalHours, cfg.autoBackup.intervalHours, 1, 24 * 30),
      }
    }
    if (input.remoteRetention && typeof input.remoteRetention === 'object') {
      next.remoteRetention = {
        enabled: typeof input.remoteRetention.enabled === 'boolean' ? input.remoteRetention.enabled : cfg.remoteRetention.enabled,
        days: clampInt(input.remoteRetention.days, cfg.remoteRetention.days, 1, 365),
      }
    }
    if (typeof input.allowSecrets === 'boolean') next.allowSecrets = input.allowSecrets
    await writeJsonAtomic(cfg.configPath, next)
    if (typeof input.token === 'string' && input.token.trim() !== '') {
      await credentials.writeToken(input.token)
    } else if (input.tokenClear === true) {
      await credentials.writeToken('')
    }
    await log.append('info', 'config saved')
    await reload()
    return cfg
  }

  /** The git clone plus a specific remote snapshot, ready to read. */
  async function loadRemote(commit) {
    if (!cfg.repoUrl) throw fail('NO_REPO', 'no repository URL is configured yet')
    const token = await currentToken()
    await ensureRepo(cfg, token, log)
    return { token, ...(await resetToRemote(cfg, token, commit)) }
  }

  async function guardPrivate(token) {
    if (!token) return { isPrivate: false, verified: false }
    try {
      const info = await verifyRepoPrivate(cfg.repoUrl, token)
      if (info.exists && info.isPrivate === false && info.unknown !== true) {
        throw fail(
          'PUBLIC_REPO',
          `the repository ${info.fullName} is public. This snapshot contains machine names, the plugin list and the memory store — make it private in GitHub settings first.`,
        )
      }
      return { isPrivate: info.isPrivate, verified: info.exists && info.unknown !== true }
    } catch (error) {
      if (error && error.code === 'PUBLIC_REPO') throw error
      return { isPrivate: false, verified: false, error: messageOf(error) }
    }
  }

  /** Prune remote snapshots older than the retention window (newest always kept). */
  async function applyRetention(token) {
    const warnings = []
    if (!cfg.remoteRetention.enabled || cfg.repoUrl === '') return { warnings, pruned: 0, head: '' }
    // Back-to-back pushes (auto backup plus a manual one) should not pay for a
    // fetch and a history scan each time.
    const st = await state.read()
    const lastAt = st.lastRetention && Number.isFinite(st.lastRetention.at) ? st.lastRetention.at : 0
    if (lastAt > 0 && Date.now() - lastAt < 10 * 60 * 1000) return { warnings, pruned: 0, head: '' }
    try {
      const result = await pruneRemoteHistory(cfg, token, { days: cfg.remoteRetention.days })
      if (result.pruned > 0) {
        const ids = result.snapshotIds.length > 0 ? ` (${result.snapshotIds.slice(0, 5).join(', ')})` : ''
        warnings.push(`remote retention: removed ${result.pruned} snapshot(s) older than ${cfg.remoteRetention.days} day(s)${ids}; the newest one is always kept`)
        await log.append('info', `retention: pruned ${result.pruned} remote snapshot(s), kept ${result.kept}`)
        await state.patch({
          lastRetention: { at: Date.now(), pruned: result.pruned, kept: result.kept, days: cfg.remoteRetention.days, head: result.head },
        })
      } else if (result.error) {
        warnings.push(`remote retention could not prune: ${result.error} — nothing was deleted`)
      }
      if (result.pruned === 0) {
        await state.patch({ lastRetention: { at: Date.now(), pruned: 0, kept: result.kept, days: cfg.remoteRetention.days, head: result.head } })
      }
      return { warnings, pruned: result.pruned, head: result.head }
    } catch (error) {
      warnings.push(`remote retention failed: ${messageOf(error)} — nothing was deleted`)
      return { warnings, pruned: 0, head: '' }
    }
  }

  /* --------------------------------------------------------------- service */

  const service = {
    async status(request) {
      await ready()
      const input = request && typeof request === 'object' ? request : {}
      const st = await state.read()
      const token = await currentToken()
      const backups = await listBackups(cfg)
      const warnings = []
      if (!cfg.repoUrl) warnings.push('no repository is configured yet')
      if (cfg.sources.memory && !exists(cfg.memoryDir)) warnings.push(`memory directory not found: ${cfg.memoryDir}`)
      if (!exists(path.join(cfg.repoDir, '.git')) && cfg.repoUrl) warnings.push('the repository has not been cloned on this machine yet')
      if (token === '' && cfg.repoUrl.includes('github.com')) warnings.push('no token is stored, so git falls back to your credential helper for https://github.com')
      let remote = st.remote || null
      if (input.refreshRemote === true && cfg.repoUrl && exists(path.join(cfg.repoDir, '.git'))) {
        await exclusive(async () => {
          try {
            await ensureRepo(cfg, token, log)
            const counts = await aheadBehind(cfg, token)
            remote = { checkedAt: Date.now(), ahead: counts.ahead, behind: counts.behind, headCommit: counts.remoteHead || counts.headCommit, error: '' }
            await state.patch({ remote })
          } catch (error) {
            remote = { checkedAt: Date.now(), ahead: 0, behind: 0, headCommit: '', error: messageOf(error) }
            await state.patch({ remote })
          }
        })
      }
      const interval = cfg.autoBackup.intervalHours * 3600 * 1000
      const lastRun = st.autoBackup && st.autoBackup.lastRunAt ? st.autoBackup.lastRunAt : 0
      return {
        configured: cfg.repoUrl !== '',
        repoUrl: cfg.repoUrl,
        branch: cfg.branch,
        profile: cfg.profile,
        deviceName: cfg.deviceName,
        dataDir: cfg.dataDir,
        dshHome: cfg.dshHome,
        profileDir: cfg.profileDir,
        memoryDir: cfg.memoryDir,
        sources: { ...cfg.sources },
        workspaceRoots: cfg.workspaceRoots.map((row) => ({ ...row })),
        pathMappings: cfg.pathMappings.map((row) => ({ ...row })),
        keepSnapshots: cfg.keepSnapshots,
        autoBackup: {
          enabled: cfg.autoBackup.enabled,
          intervalHours: cfg.autoBackup.intervalHours,
          nextAt: cfg.autoBackup.enabled && cfg.repoUrl !== '' ? (lastRun > 0 ? lastRun + interval : Date.now() + interval) : 0,
          lastError: (st.autoBackup && st.autoBackup.lastError) || '',
        },
        remoteRetention: {
          enabled: cfg.remoteRetention.enabled,
          days: cfg.remoteRetention.days,
          last: st.lastRetention || null,
        },
        tokenPresent: token !== '',
        lastPush: st.lastPush || null,
        lastPull: st.lastPull || null,
        lastBackup: st.lastBackup || null,
        backupCount: backups.length,
        backupBytes: backups.reduce((sum, row) => sum + row.bytes, 0),
        remote,
        logTail: await log.tail(20),
        warnings,
      }
    },

    async saveConfig(request) {
      await ready()
      return await exclusive(async () => {
        const previousRepo = cfg.repoUrl
        const previousBranch = cfg.branch
        const previousRetention = cfg.remoteRetention
        await saveConfig(request)
        // A different remote or branch makes the cached ahead/behind counters a
        // statement about a repository this machine no longer tracks.
        if (cfg.repoUrl !== previousRepo || cfg.branch !== previousBranch) await state.patch({ remote: null })
        // A changed retention window must take effect on the next push instead of
        // waiting for the debounce to expire.
        if (
          cfg.remoteRetention.enabled !== previousRetention.enabled ||
          cfg.remoteRetention.days !== previousRetention.days
        ) {
          await state.patch({ lastRetention: null })
        }
        return await service.status({})
      })
    },

    async preview() {
      await ready()
      const snapshotId = newSnapshotId()
      const collected = await collectFiles(cfg)
      const { rows, truncated } = previewRows(collected.files)
      const warnings = [...collected.warnings]
      if (collected.count === 0) warnings.push('nothing matched the current selection; check the sources and paths')
      return {
        snapshotId,
        count: collected.count,
        bytes: collected.bytes,
        bySource: collected.bySource,
        files: rows,
        truncated,
        warnings,
        secretFindings: collected.secretFindings,
      }
    },

    async push(request) {
      await ready()
      return await exclusive(async () => {
        const input = request && typeof request === 'object' ? request : {}
        if (!cfg.repoUrl) throw fail('NO_REPO', 'no repository URL is configured yet')
        const started = Date.now()
        const token = await currentToken()
        const collected = await collectFiles(cfg)
        if (collected.count === 0) {
          throw fail(
            'EMPTY_SNAPSHOT',
            'refusing to write an empty snapshot: no file matched the current selection. Check the sources, the memory directory and the workspace roots.',
          )
        }
        const findings = collected.secretFindings
        if (findings.length > 0 && !cfg.allowSecrets && input.dryRun !== true) {
          const first = findings.slice(0, 3).map((row) => `${row.path}:${row.line} (${row.kind})`).join(', ')
          throw fail(
            'SECRETS_FOUND',
            `refusing to push: ${findings.length} credential-shaped value(s) found — ${first}. Remove them, or turn on "allow secrets" in the plugin config if they are placeholders.`,
          )
        }
        const snapshotId = newSnapshotId()
        const baseWarnings = [...collected.warnings]
        if (cfg.sources.memory && (collected.bySource.memory || 0) === 0) {
          baseWarnings.push(`the memory source is enabled but no memory file was found under ${cfg.memoryDir} — the snapshot carries no memory`)
        }
        if (input.dryRun === true) {
          const warnings = [...baseWarnings]
          if (findings.length > 0 && !cfg.allowSecrets) {
            warnings.push(`a real push would be refused: ${findings.length} credential-shaped value(s) found`)
          }
          return {
            snapshotId,
            count: collected.count,
            bytes: collected.bytes,
            commit: '',
            pushed: false,
            upToDate: false,
            dryRun: true,
            durationMs: Date.now() - started,
            warnings,
            secretFindings: findings,
          }
        }
        const privacy = await guardPrivate(token)
        const privacyWarning = privacy.verified
          ? privacy.isPrivate ? '' : 'the repository is reachable but not confirmed private — GitHub reports it as public'
          : 'repository visibility could not be verified (no token or the GitHub API is unreachable); make sure it is private'
        if (privacyWarning !== '') baseWarnings.push(privacyWarning)
        const { cloned, branchExists } = await ensureRepo(cfg, token, log)
        const digest = payloadDigest(collected)
        const bootstrap = await bootstrapDigest()
        const existing = await readJson(path.join(cfg.repoDir, 'manifest.json'), null)
        const repo = await repoState(cfg, token)
        const samePayload = Boolean(existing) && typeof existing.digest === 'string' && existing.digest === digest
        const sameBootstrap = Boolean(existing) && typeof existing.bootstrapDigest === 'string' && existing.bootstrapDigest === bootstrap
        if (samePayload && sameBootstrap && repo.clean && repo.ahead === 0) {
          const unchangedId = existing.snapshotId || snapshotId
          // No new snapshot, but the retention window may still have expired.
          const retention = await applyRetention(token)
          await state.patch({
            lastPush: { at: Date.now(), snapshotId: unchangedId, commit: retention.head || repo.head, count: collected.count, bytes: collected.bytes },
          })
          await log.append('info', `push skipped: payload and plugin copy unchanged since ${unchangedId}`)
          return {
            snapshotId: unchangedId,
            count: collected.count,
            bytes: collected.bytes,
            commit: repo.head,
            pushed: false,
            upToDate: true,
            dryRun: false,
            durationMs: Date.now() - started,
            warnings: [...baseWarnings, 'payload and plugin copy unchanged — no commit was created', ...retention.warnings],
            secretFindings: findings,
          }
        }
        const manifest = buildManifest(cfg, collected, snapshotId, { bootstrapDigest: bootstrap })
        const writeWarnings = await writeSnapshotTree(cfg, manifest, collected)
        const message = typeof input.message === 'string' && input.message.trim() !== ''
          ? `snapshot: ${snapshotId} — ${input.message.trim()}`
          : `snapshot: ${snapshotId} — ${collected.count} files, ${humanBytes(collected.bytes)}`
        const result = await commitAndPush(cfg, token, message)
        await state.patch({
          lastPush: { at: Date.now(), snapshotId, commit: result.commit, count: collected.count, bytes: collected.bytes },
          remote: { checkedAt: Date.now(), ahead: 0, behind: 0, headCommit: result.commit, error: '' },
        })
        await log.append('info', `push ${snapshotId}: ${collected.count} files, ${humanBytes(collected.bytes)}, commit ${result.commit || 'none'}`)
        const retention = await applyRetention(token)
        const warnings = [...baseWarnings, ...writeWarnings, ...retention.warnings]
        if (!branchExists && !cloned) warnings.push(`created a new local branch "${cfg.branch}"; confirm the remote branch name matches`)
        return {
          snapshotId,
          count: collected.count,
          bytes: collected.bytes,
          commit: retention.pruned > 0 ? retention.head || result.commit : result.commit,
          pushed: result.pushed,
          upToDate: result.upToDate,
          dryRun: false,
          durationMs: Date.now() - started,
          warnings,
          secretFindings: collected.secretFindings,
        }
      })
    },

    async pullPlan(request) {
      await ready()
      return await exclusive(async () => {
      const input = request && typeof request === 'object' ? request : {}
      const { manifest, commit } = await loadRemote(input.commit)
      const st = await state.read()
      if (!manifest) {
        return {
          remoteSnapshotId: '',
          remoteCommit: commit,
          remoteCreatedAt: 0,
          localSnapshotId: (st.lastPull && st.lastPull.snapshotId) || (st.lastPush && st.lastPush.snapshotId) || '',
          actions: [],
          mappings: [],
          workspaceMap: [],
          warnings: ['the remote branch has no snapshot yet; push from the old machine first'],
          secretFindings: [],
        }
      }
      const mappings = withOverrides(buildMappings(cfg, manifest), input.mappings)
      const plan = await planPull(cfg, manifest, mappings)
      const warnings = []
      if (manifest.schema !== 'dsh-data-sync/1') warnings.push(`unknown snapshot schema: ${manifest.schema}`)
      if (manifest.profile !== cfg.profile) warnings.push(`the snapshot was pushed from profile "${manifest.profile}", this machine runs "${cfg.profile}"`)
      return {
        remoteSnapshotId: manifest.snapshotId || '',
        remoteCommit: commit,
        remoteCreatedAt: manifest.createdAt || 0,
        localSnapshotId: (st.lastPull && st.lastPull.snapshotId) || (st.lastPush && st.lastPush.snapshotId) || '',
        actions: plan.actions,
        mappings,
        workspaceMap: [...plan.workspaceMap.entries()].map(([label, root]) => ({ label, path: root })),
        warnings: [...warnings, ...(plan.skipped.length > 0 ? [`${plan.skipped.length} file(s) cannot be placed on this machine`] : [])],
        secretFindings: [],
      }
      })
    },

    async pull(request) {
      await ready()
      return await exclusive(async () => {
        const input = request && typeof request === 'object' ? request : {}
        const { manifest, commit } = await loadRemote(input.commit)
        if (!manifest) throw fail('NO_SNAPSHOT', 'the remote branch has no snapshot to apply yet')
        if (manifest.schema !== 'dsh-data-sync/1') {
          throw fail('MANIFEST_SCHEMA', `the remote snapshot uses schema "${manifest.schema}", this plugin understands "dsh-data-sync/1"`)
        }
        const mappings = withOverrides(buildMappings(cfg, manifest), input.mappings)
        const plan = await planPull(cfg, manifest, mappings)
        const mapped = mappings.map((row) => ({ from: row.from, to: row.to }))
        if (input.apply !== true) {
          return {
            applied: false,
            snapshotId: manifest.snapshotId || '',
            backupId: '',
            added: plan.actions.filter((row) => row.action === 'add').length,
            updated: plan.actions.filter((row) => row.action === 'update').length,
            skipped: plan.skipped,
            mappings: mapped,
            warnings: ['dry run: nothing was written'],
          }
        }
        const changes = plan.actions.filter((row) => row.action !== 'same')
        const skipWarnings = plan.skipped.length > 0
          ? [`${plan.skipped.length} file(s) cannot be placed on this machine: ${plan.skipped.slice(0, 3).map((row) => `${row.path} (${row.reason})`).join(', ')}`]
          : []
        if (changes.length === 0) {
          const warnings = skipWarnings.length > 0
            ? ['nothing could be written: every file in the snapshot was skipped', ...skipWarnings]
            : ['the remote snapshot already matches this machine; nothing was written and no backup was taken']
          return {
            applied: false,
            snapshotId: manifest.snapshotId || '',
            backupId: '',
            added: 0,
            updated: 0,
            skipped: plan.skipped,
            mappings: mapped,
            warnings,
          }
        }
        const willCreate = changes.filter((row) => row.action === 'add' && row.target).map((row) => row.target)
        // Back up exactly the files this pull will touch: a backup built from the
        // current-profile whitelist could miss a target and make the rollback
        // incomplete.
        const backup = await backupTargets(cfg, {
          reason: 'pre-pull',
          targets: changes.filter((row) => row.target).map((row) => ({ target: row.target, source: row.source, rel: row.path })),
          willCreate,
        })
        await state.patch({ lastBackup: { at: Date.now(), id: backup.id, reason: 'pre-pull', count: backup.count } })
        let applied = null
        try {
          applied = await applyPull(cfg, manifest, mappings, plan)
        } catch (error) {
          const restored = await rollbackTo(cfg, backup.id).catch(() => null)
          await log.append('error', `pull ${manifest.snapshotId} failed: ${messageOf(error)}; backup ${backup.id}${restored ? ` restored ${restored.restored} file(s)` : ' NOT restored'}`)
          throw fail(
            'APPLY_FAILED',
            `writing the snapshot failed: ${messageOf(error)}. Backup ${backup.id} was ${restored ? `restored (${restored.restored} file(s))` : 'NOT restored automatically'}; use data_sync_rollback with that id.`,
          )
        }
        const updates = {
          lastPull: { at: Date.now(), snapshotId: manifest.snapshotId || '', count: applied.added.length + applied.updated.length },
        }
        // A historical pull leaves the branch head where it was; recording it as
        // the checked head would make `status` describe the wrong commit.
        if (!input.commit) updates.remote = { checkedAt: Date.now(), ahead: 0, behind: 0, headCommit: commit, error: '' }
        await state.patch(updates)
        await log.append('info', `pull ${manifest.snapshotId}: ${applied.added.length} added, ${applied.updated.length} updated, backup ${backup.id}`)
        return {
          applied: true,
          snapshotId: manifest.snapshotId || '',
          backupId: backup.id,
          added: applied.added.length,
          updated: applied.updated.length,
          skipped: applied.skipped,
          mappings: mapped,
          warnings: skipWarnings,
        }
      })
    },

    async backup() {
      await ready()
      return await exclusive(async () => {
        const result = await backupNow(cfg, { reason: 'manual' })
        await state.patch({ lastBackup: { at: Date.now(), id: result.id, reason: 'manual', count: result.count } })
        await log.append('info', `backup ${result.id}: ${result.count} files, ${humanBytes(result.bytes)}`)
        return { backupId: result.id, count: result.count, bytes: result.bytes, path: result.dir }
      })
    },

    async backups() {
      await ready()
      const rows = await listBackups(cfg)
      return { backups: rows, totalBytes: rows.reduce((sum, row) => sum + row.bytes, 0) }
    },

    async rollback(request) {
      await ready()
      return await exclusive(async () => {
        const input = request && typeof request === 'object' ? request : {}
        const result = await rollbackTo(cfg, input.id)
        await log.append('info', `rollback ${input.id}: ${result.restored} file(s) restored, ${result.skipped.length} skipped`)
        return { id: String(input.id || ''), restored: result.restored, backupId: result.safetyBackupId, skipped: result.skipped }
      })
    },

    async history(request) {
      await ready()
      const input = request && typeof request === 'object' ? request : {}
      if (!exists(path.join(cfg.repoDir, '.git'))) return { commits: [], error: 'the repository has not been cloned on this machine yet' }
      try {
        const token = await currentToken()
        // Another machine may have pruned or pushed since this clone was made.
        await fetchRemote(cfg, token).catch(() => {})
        const commits = await gitLog(cfg, token, clampInt(input.limit, 20, 1, 100))
        return { commits, error: '' }
      } catch (error) {
        return { commits: [], error: messageOf(error) }
      }
    },

    async init(request) {
      await ready()
      // Connecting writes config.json and resets the clone, so it belongs in the
      // same queue as push/pull — otherwise a scheduled push can see cfg change
      // halfway through its own awaits.
      return await exclusive(async () => {
      const input = request && typeof request === 'object' ? request : {}
      const token = await currentToken()
      let created = false
      const warnings = []
      if (typeof input.createPrivateName === 'string' && input.createPrivateName.trim() !== '') {
        if (!token) throw fail('TOKEN_REQUIRED', 'creating a repository needs a GitHub token with repo scope')
        const repo = await createPrivateRepo(input.createPrivateName.trim(), token)
        created = true
        await saveConfig({ repoUrl: repo.url, branch: typeof input.branch === 'string' ? input.branch : cfg.branch })
      } else {
        if (typeof input.repoUrl === 'string' && input.repoUrl.trim() !== '') {
          await saveConfig({ repoUrl: input.repoUrl.trim(), branch: typeof input.branch === 'string' ? input.branch : cfg.branch })
        }
        if (!cfg.repoUrl) throw fail('NO_REPO', 'set a repository URL first')
      }
      const privacy = await guardPrivate(token)
      const { cloned } = await ensureRepo(cfg, token, log)
      if (!privacy.verified && cfg.repoUrl.includes('github.com')) {
        warnings.push('repository visibility could not be verified without a token; make sure it is private')
      }
      await log.append('info', `init ${cfg.repoUrl} (${cfg.branch})${created ? ' — created' : ''}`)
      let bootstrapped = false
      try {
        bootstrapped = !(await resetToRemote(cfg, token)).missing
      } catch {
        bootstrapped = false
      }
      return {
        repoUrl: cfg.repoUrl,
        branch: cfg.branch,
        created,
        isPrivate: privacy.isPrivate,
        cloned: cloned || exists(path.join(cfg.repoDir, '.git')),
        bootstrapped,
        warnings,
      }
      })
    },
  }

  function withOverrides(mappings, override) {
    if (!Array.isArray(override) || override.length === 0) return mappings
    const map = new Map(mappings.map((row) => [row.from, row]))
    for (const row of override) {
      if (!row || typeof row.from !== 'string' || row.from.trim() === '') continue
      map.set(row.from.trim(), { from: row.from.trim(), to: typeof row.to === 'string' ? row.to.trim() : '', auto: false })
    }
    return [...map.values()].sort((left, right) => right.from.length - left.from.length)
  }

  service.typertRemote = Object.freeze({ service, serviceKey: NS, namespace: NS })

  return { ready, service, log, state, cfg: () => cfg, currentToken, exclusive }
}

/* ------------------------------------------------------------ remote wiring */

function strictCodec(symbol) {
  return {
    mode: 'strict',
    typeSymbol: `${PACKAGE}#${symbol}`,
    schema: { parse: (value) => value },
    create: () => ({ parse: (value) => value }),
  }
}

const codecs = {
  StatusRequest: strictCodec('StatusRequest'),
  Status: strictCodec('Status'),
  ConfigRequest: strictCodec('ConfigRequest'),
  PreviewRequest: strictCodec('PreviewRequest'),
  Preview: strictCodec('Preview'),
  PushRequest: strictCodec('PushRequest'),
  PushResult: strictCodec('PushResult'),
  PullPlanRequest: strictCodec('PullPlanRequest'),
  PullPlan: strictCodec('PullPlan'),
  PullRequest: strictCodec('PullRequest'),
  PullResult: strictCodec('PullResult'),
  BackupRequest: strictCodec('BackupRequest'),
  BackupResult: strictCodec('BackupResult'),
  BackupsRequest: strictCodec('BackupsRequest'),
  BackupList: strictCodec('BackupList'),
  RollbackRequest: strictCodec('RollbackRequest'),
  RollbackResult: strictCodec('RollbackResult'),
  HistoryRequest: strictCodec('HistoryRequest'),
  History: strictCodec('History'),
  InitRequest: strictCodec('InitRequest'),
  InitResult: strictCodec('InitResult'),
}

function descriptor(method, requestSymbol, resultSymbol) {
  return {
    id: `${PACKAGE}#${NS}/${method}`,
    service: NS,
    namespace: NS,
    method,
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: codecs[requestSymbol] }],
    result: codecs[resultSymbol],
  }
}

export const remoteContribution = {
  package: PACKAGE,
  descriptors: [
    descriptor('status', 'StatusRequest', 'Status'),
    descriptor('saveConfig', 'ConfigRequest', 'Status'),
    descriptor('preview', 'PreviewRequest', 'Preview'),
    descriptor('push', 'PushRequest', 'PushResult'),
    descriptor('pullPlan', 'PullPlanRequest', 'PullPlan'),
    descriptor('pull', 'PullRequest', 'PullResult'),
    descriptor('backup', 'BackupRequest', 'BackupResult'),
    descriptor('backups', 'BackupsRequest', 'BackupList'),
    descriptor('rollback', 'RollbackRequest', 'RollbackResult'),
    descriptor('history', 'HistoryRequest', 'History'),
    descriptor('init', 'InitRequest', 'InitResult'),
  ],
}

/* -------------------------------------------------------------------- tools */

const GUIDANCE = [
  '## DSH data sync (this machine)',
  '- A `@local/dsh-data-sync` plugin can snapshot this harness (profile config, memory store, skills) into a private git repository and restore it on another machine with absolute paths remapped.',
  '- Use `data_sync_status` before claiming anything about the sync state; `data_sync_push` writes a snapshot, `data_sync_pull` (apply: false) only previews what a pull would change.',
  '- `data_sync_pull` without `commit` applies the newest snapshot on the branch (for example the version pushed today); `data_sync_pull` with a `commit` from `data_sync_history` applies an older version instead.',
  '- The `memoryDir` of this plugin is the storage directory of the memory plugin (its `storageDir`: `memories.json` + `MEMORY.md`), not a second copy. Never point it somewhere else; leave it empty to detect it from the installed memory plugin.',
  '- Remote retention is on by default (3 days): a successful push prunes snapshots older than the window from the branch and always keeps the newest one. Set `remoteRetention` through `data_sync_configure` to change it.',
  '- Never invent a repository URL or token, and never enable "allow secrets": the snapshot deliberately excludes credentials.',
].join('\n')

function toolOutput() {
  return {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  }
}

function presentCall(title) {
  return (args) => ({ card: 'generic', title, kind: 'other', rawInput: args })
}

const TOOL_TITLES = {
  data_sync_status: 'Data sync status',
  data_sync_configure: 'Configure data sync',
  data_sync_init: 'Connect data sync repository',
  data_sync_push: 'Push snapshot',
  data_sync_pull: 'Pull snapshot',
  data_sync_history: 'Snapshot history',
  data_sync_backup: 'Back up now',
  data_sync_rollback: 'Roll back to backup',
}

/* ------------------------------------------------------------------- apply */

export const name = 'data-sync'
export const inject = ['tools', 'typert', 'systemPrompt']

export function apply(ctx, rawConfig) {
  const runtime = createRuntime(rawConfig)
  const { service, log, state, cfg } = runtime

  ctx.effect(() => ctx.provide(NS, service), 'data-sync: service')
  ctx.effect(() =>
    ctx.typert.register({
      package: PACKAGE,
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: remoteContribution.descriptors,
    }),
  )
  ctx.effect(() => ctx.systemPrompt.section({ name: 'data-sync:guidance', order: 960, text: GUIDANCE }))

  /* -------------------------------------------------------------- scheduler */

  async function tick() {
    try {
      const config = await runtime.ready()
      if (!config.autoBackup.enabled || !config.repoUrl) return
      const current = await state.read()
      const lastRun = current.autoBackup && current.autoBackup.lastRunAt ? current.autoBackup.lastRunAt : 0
      if (Date.now() - lastRun < config.autoBackup.intervalHours * 3600 * 1000) return
      const token = await runtime.currentToken()
      const privacy = token ? await verifyRepoPrivate(config.repoUrl, token).catch(() => null) : null
      if (privacy && privacy.exists && privacy.isPrivate === false) {
        await state.patch({ autoBackup: { lastRunAt: Date.now(), lastError: 'the repository is public; automatic backup is suspended' } })
        return
      }
      await service.push({ message: 'automatic backup' })
      await state.patch({ autoBackup: { lastRunAt: Date.now(), lastError: '' } })
    } catch (error) {
      const message = messageOf(error)
      await state.patch({ autoBackup: { lastRunAt: Date.now(), lastError: message } }).catch(() => {})
      await log.append('warn', `automatic backup failed: ${message}`).catch(() => {})
    }
  }

  const timer = setInterval(() => {
    tick().catch(() => {})
  }, 60 * 1000)
  if (typeof timer.unref === 'function') timer.unref()
  ctx.effect(() => () => clearInterval(timer), 'data-sync: scheduler')
  runtime.ready().then(() => tick().catch(() => {})).catch(() => {})

  /* ------------------------------------------------------------------ tools */

  ctx.effect(() =>
    ctx.tools.register({
      name: 'data_sync_status',
      description:
        'Report the DSH data-sync state of this machine: configured repository, profile, sources, last push/pull/backup, backup rotation size, the remote ahead/behind counters, and the plugin log tail. Read-only. Use it before answering questions about migration or backup state, and after any sync action.',
      parameters: {
        type: 'object',
        properties: {
          refreshRemote: { type: 'boolean', description: 'Contact the remote to recompute ahead/behind. Default false (cached).' },
        },
        additionalProperties: false,
      },
      output: toolOutput(),
      presentCall: presentCall(TOOL_TITLES.data_sync_status),
      async execute(args) {
        return await service.status({ refreshRemote: Boolean(args && args.refreshRemote) })
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'data_sync_configure',
      description:
        'Change the DSH data-sync configuration: the private repository URL, branch, which sources travel (config / memory / skills), the memory store directory, workspace roots, path mappings and the automatic backup schedule. A token can be stored here too; it is written to a local credential file and never enters a snapshot. Use `data_sync_init` to create a repository and clone it.',
      parameters: {
        type: 'object',
        properties: {
          repoUrl: { type: 'string', description: 'Private git repository URL, for example https://github.com/you/DSH-Sync-Data.git. An empty string clears it.' },
          branch: { type: 'string', description: 'Branch to push/pull, default main.' },
          profile: { type: 'string', description: 'Harness profile to snapshot, for example desktop. Default: detected from $DSH_PROFILE or from the profile that installs this plugin.' },
          token: { type: 'string', description: 'GitHub token with repo scope. Stored only in the local credential file.' },
          tokenClear: { type: 'boolean', description: 'Forget the stored token.' },
          sources: {
            type: 'object',
            properties: {
              config: { type: 'boolean', description: 'Profile and $DSH_HOME configuration documents.' },
              memory: { type: 'boolean', description: 'Long-term memory store (memories.json, MEMORY.md).' },
              skills: { type: 'boolean', description: 'Skills, agent presets, AGENTS.md and per-workspace skill trees.' },
            },
            additionalProperties: false,
          },
          memoryDir: { type: 'string', description: 'Memory store directory, when it is not the detected one.' },
          workspaceRoots: {
            type: 'array',
            description: 'Workspace roots whose skills and instruction files travel.',
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, path: { type: 'string' } },
              required: ['path'],
              additionalProperties: false,
            },
          },
          pathMappings: {
            type: 'array',
            description: 'Explicit old-path → new-path rewrites applied after a pull, in addition to the automatic ones.',
            items: {
              type: 'object',
              properties: { from: { type: 'string' }, to: { type: 'string' } },
              required: ['from', 'to'],
              additionalProperties: false,
            },
          },
          keepSnapshots: { type: 'integer', minimum: 1, maximum: 99, description: 'How many local backups to keep, default 10.' },
          autoBackup: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              intervalHours: { type: 'integer', minimum: 1, maximum: 720 },
            },
            additionalProperties: false,
          },
          remoteRetention: {
            type: 'object',
            description: 'How many days of remote versions to keep. After a successful push, older snapshots are pruned from the branch history; the newest is always kept.',
            properties: {
              enabled: { type: 'boolean', description: 'Default true.' },
              days: { type: 'integer', minimum: 1, maximum: 365, description: 'Default 3.' },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      output: toolOutput(),
      presentCall: presentCall(TOOL_TITLES.data_sync_configure),
      async execute(args) {
        return await service.saveConfig(args || {})
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'data_sync_push',
      description:
        'Snapshot this machine (configuration, memory, skills per the configured sources) into the private repository and push a commit. Refuses to push when the secret screen finds a credential-shaped value. After a successful push, snapshots older than the retention window are pruned from the remote branch (the newest is always kept). Pass `dryRun: true` to see what would travel without touching git. Use it on the machine being left, before wiping it.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Optional note appended to the snapshot commit message.' },
          dryRun: { type: 'boolean', description: 'Collect and report only; no repository write, no commit, no push.' },
        },
        additionalProperties: false,
      },
      output: toolOutput(),
      presentCall: presentCall(TOOL_TITLES.data_sync_push),
      async execute(args) {
        return await service.push(args || {})
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'data_sync_pull',
      description:
        'Apply the snapshot in the private repository to this machine, with the recorded absolute paths remapped to local paths. Without `commit` it applies the newest snapshot on the branch — "the version pushed today" after today\'s push. `apply: false` (the default) only previews the plan: per-file add/update/same, the remote snapshot id and the mapping table. A real apply takes a local backup first; `backupId` names it for a rollback. Pass `commit` (from data_sync_history) to apply an older snapshot instead. Use it on the new machine after installing the plugin and connecting the repository.',
      parameters: {
        type: 'object',
        properties: {
          apply: { type: 'boolean', description: 'false (default) = preview only; true = back up and write the files.' },
          commit: { type: 'string', description: 'Optional commit hash from the remote history; applies that snapshot instead of the branch head.' },
          mappings: {
            type: 'array',
            description: 'One-shot old-path → new-path overrides for this pull only.',
            items: {
              type: 'object',
              properties: { from: { type: 'string' }, to: { type: 'string' } },
              required: ['from', 'to'],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      output: toolOutput(),
      presentCall: presentCall(TOOL_TITLES.data_sync_pull),
      async execute(args) {
        return await service.pull(args || {})
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'data_sync_init',
      description:
        'Connect this machine to a private git repository: store the URL (and branch), verify it is private when a token is available, and clone it. Pass `createPrivateName` to create a brand-new private GitHub repository with the stored token first. Use it once per machine, before the first push; `data_sync_configure` sets a URL without cloning.',
      parameters: {
        type: 'object',
        properties: {
          repoUrl: { type: 'string', description: 'Repository URL to connect, for example https://github.com/you/DSH-Sync-Data.git' },
          branch: { type: 'string', description: 'Branch to push/pull, default keeps the configured one.' },
          createPrivateName: { type: 'string', description: 'Create a new private repository with this name on the token account, then connect it.' },
        },
        additionalProperties: false,
      },
      output: toolOutput(),
      presentCall: presentCall(TOOL_TITLES.data_sync_init),
      async execute(args) {
        return await service.init(args || {})
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'data_sync_history',
      description:
        'List the snapshots in the remote history (commit, date, message and snapshot id). Pass one of the returned commit hashes to `data_sync_pull` with `apply: true` to restore that version. Use it when the user asks what was backed up when, or wants to go back to an earlier snapshot.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 100, description: 'How many commits to list, default 20.' },
        },
        additionalProperties: false,
      },
      output: toolOutput(),
      presentCall: presentCall(TOOL_TITLES.data_sync_history),
      async execute(args) {
        return await service.history(args || {})
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'data_sync_backup',
      description:
        'Copy the current configuration, memory and skill payload into the local backup rotation without touching the remote. Use it before risky manual edits or before applying a pull from another machine.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: toolOutput(),
      presentCall: presentCall(TOOL_TITLES.data_sync_backup),
      async execute() {
        return await service.backup()
      },
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'data_sync_rollback',
      description:
        'Restore one local backup created by this plugin: its files are written back and files that the following pull created are removed. A safety backup of the current state is taken first, and its id is returned. Use `data_sync_status`/backups to find an id; never guess one.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'Backup id, as listed by status or the Settings page.' } },
        required: ['id'],
        additionalProperties: false,
      },
      output: toolOutput(),
      presentCall: presentCall(TOOL_TITLES.data_sync_rollback),
      async execute(args) {
        return await service.rollback(args || {})
      },
    }),
  )
}
