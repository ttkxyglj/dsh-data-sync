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
  portableConfig,
  readJson,
  resolveConfig,
  slugify,
  writeJsonAtomic,
} from './lib/util.js'
import { collectFiles, previewRows } from './lib/collect.js'
import {
  aheadBehind,
  commitAndPush,
  createPrivateRepo,
  ensureRepo,
  gitLog,
  repoState,
  resetToRemote,
  verifyRepoPrivate,
} from './lib/git.js'
import {
  applyPull,
  backupNow,
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

/** Read `storageDir` out of the memory plugin row in the profile patch. */
async function detectMemoryDir(cfg) {
  const patch = path.join(cfg.dshHome, 'profiles', cfg.profile, 'cordis.patch.yml')
  try {
    const text = await fsp.readFile(patch, 'utf8')
    const match = /^\s*storageDir:\s*['"]?([^'"\r\n#]+)['"]?\s*$/m.exec(text)
    if (match && match[1].trim() !== '') return path.resolve(match[1].trim())
  } catch {
    // patch absent: fall through to the portable default
  }
  return cfg.memoryDir
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
      const saved = await readJson(cfg.configPath, null)
      const patchMemoryDir = rawConfig && typeof rawConfig === 'object' && typeof rawConfig.memoryDir === 'string' ? rawConfig.memoryDir.trim() : ''
      const savedMemoryDir = saved && typeof saved.memoryDir === 'string' ? saved.memoryDir.trim() : ''
      cfg = mergeSaved(cfg, saved)
      if (patchMemoryDir === '' && savedMemoryDir === '') cfg.memoryDir = await detectMemoryDir(cfg)
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
    if (typeof input.memoryDir === 'string' && input.memoryDir.trim() !== '') next.memoryDir = path.resolve(input.memoryDir.trim())
    if (input.sources && typeof input.sources === 'object') {
      next.sources = {
        config: typeof input.sources.config === 'boolean' ? input.sources.config : cfg.sources.config,
        memory: typeof input.sources.memory === 'boolean' ? input.sources.memory : cfg.sources.memory,
        skills: typeof input.sources.skills === 'boolean' ? input.sources.skills : cfg.sources.skills,
      }
    }
    if (Array.isArray(input.workspaceRoots)) {
      next.workspaceRoots = input.workspaceRoots
        .filter((row) => row && typeof row.path === 'string' && row.path.trim() !== '')
        .map((row) => ({
          label: typeof row.label === 'string' && row.label.trim() !== '' ? row.label.trim() : slugify(row.path),
          path: path.resolve(row.path),
        }))
    }
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

  /** The git clone plus the remote snapshot, ready to read. */
  async function loadRemote() {
    if (!cfg.repoUrl) throw fail('NO_REPO', 'no repository URL is configured yet')
    const token = await currentToken()
    await ensureRepo(cfg, token, log)
    return { token, ...(await resetToRemote(cfg, token)) }
  }

  async function guardPrivate(token) {
    if (!token) return { isPrivate: false, verified: false }
    try {
      const info = await verifyRepoPrivate(cfg.repoUrl, token)
      if (info.exists && info.isPrivate === false) {
        throw fail(
          'PUBLIC_REPO',
          `the repository ${info.fullName} is public. This snapshot contains machine names, the plugin list and the memory store — make it private in GitHub settings first.`,
        )
      }
      return { isPrivate: info.isPrivate, verified: info.exists }
    } catch (error) {
      if (error && error.code === 'PUBLIC_REPO') throw error
      return { isPrivate: false, verified: false, error: messageOf(error) }
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
      let remote = st.remote || null
      if (input.refreshRemote === true && cfg.repoUrl && exists(path.join(cfg.repoDir, '.git'))) {
        await exclusive(async () => {
          try {
            await ensureRepo(cfg, token, log)
            const counts = await aheadBehind(cfg, token)
            remote = { checkedAt: Date.now(), ahead: counts.ahead, behind: counts.behind, headCommit: '', error: '' }
            await state.patch({ remote })
          } catch (error) {
            remote = { checkedAt: Date.now(), ahead: 0, behind: 0, headCommit: '', error: messageOf(error) }
            await state.patch({ remote })
          }
        })
      }
      const interval = cfg.autoBackup.intervalHours * 3600 * 1000
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
          nextAt: st.autoBackup && st.autoBackup.lastRunAt ? st.autoBackup.lastRunAt + interval : 0,
          lastError: (st.autoBackup && st.autoBackup.lastError) || '',
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
      await saveConfig(request)
      return await service.status({})
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
        if (collected.secretFindings.length > 0 && !cfg.allowSecrets) {
          const first = collected.secretFindings.slice(0, 3).map((row) => `${row.path}:${row.line} (${row.kind})`).join(', ')
          throw fail(
            'SECRETS_FOUND',
            `refusing to push: ${collected.secretFindings.length} credential-shaped value(s) found — ${first}. Remove them, or turn on "allow secrets" in the plugin config if they are placeholders.`,
          )
        }
        const snapshotId = newSnapshotId()
        if (input.dryRun === true) {
          return {
            snapshotId,
            count: collected.count,
            bytes: collected.bytes,
            commit: '',
            pushed: false,
            upToDate: false,
            dryRun: true,
            durationMs: Date.now() - started,
            warnings: collected.warnings,
            secretFindings: collected.secretFindings,
          }
        }
        const privacy = await guardPrivate(token)
        const { cloned, branchExists } = await ensureRepo(cfg, token, log)
        const digest = payloadDigest(collected)
        const existing = await readJson(path.join(cfg.repoDir, 'manifest.json'), null)
        const repo = await repoState(cfg, token)
        if (
          existing
          && typeof existing.digest === 'string'
          && existing.digest === digest
          && repo.clean
          && repo.ahead === 0
        ) {
          const unchangedId = existing.snapshotId || snapshotId
          await state.patch({
            lastPush: { at: Date.now(), snapshotId: unchangedId, commit: repo.head, count: collected.count, bytes: collected.bytes },
          })
          await log.append('info', `push skipped: payload unchanged since ${unchangedId}`)
          return {
            snapshotId: unchangedId,
            count: collected.count,
            bytes: collected.bytes,
            commit: repo.head,
            pushed: false,
            upToDate: true,
            dryRun: false,
            durationMs: Date.now() - started,
            warnings: collected.warnings,
            secretFindings: collected.secretFindings,
          }
        }
        const manifest = buildManifest(cfg, collected, snapshotId)
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
        const warnings = [...collected.warnings, ...writeWarnings]
        if (!branchExists && !cloned) warnings.push(`created a new local branch "${cfg.branch}"; confirm the remote branch name matches`)
        if (privacy.verified && !privacy.isPrivate) warnings.push('visibility could not be confirmed as private')
        return {
          snapshotId,
          count: collected.count,
          bytes: collected.bytes,
          commit: result.commit,
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
      const { manifest, commit } = await loadRemote()
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
        const { manifest, commit } = await loadRemote()
        if (!manifest) throw fail('NO_SNAPSHOT', 'the remote branch has no snapshot to apply yet')
        const mappings = withOverrides(buildMappings(cfg, manifest), input.mappings)
        const plan = await planPull(cfg, manifest, mappings)
        if (input.apply !== true) {
          return {
            applied: false,
            snapshotId: manifest.snapshotId || '',
            backupId: '',
            added: plan.actions.filter((row) => row.action === 'add').length,
            updated: plan.actions.filter((row) => row.action === 'update').length,
            skipped: plan.skipped,
            mappings: mappings.map((row) => ({ from: row.from, to: row.to })),
            warnings: ['dry run: nothing was written'],
          }
        }
        const willCreate = plan.actions.filter((row) => row.action === 'add' && row.target).map((row) => row.target)
        const backup = await backupNow(cfg, { reason: 'pre-pull', willCreate })
        await state.patch({ lastBackup: { at: Date.now(), id: backup.id, reason: 'pre-pull', count: backup.count } })
        const applied = await applyPull(cfg, manifest, mappings)
        await state.patch({
          lastPull: { at: Date.now(), snapshotId: manifest.snapshotId || '', count: applied.added.length + applied.updated.length },
          remote: { checkedAt: Date.now(), ahead: 0, behind: 0, headCommit: commit, error: '' },
        })
        await log.append('info', `pull ${manifest.snapshotId}: ${applied.added.length} added, ${applied.updated.length} updated, backup ${backup.id}`)
        return {
          applied: true,
          snapshotId: manifest.snapshotId || '',
          backupId: backup.id,
          added: applied.added.length,
          updated: applied.updated.length,
          skipped: applied.skipped,
          mappings: mappings.map((row) => ({ from: row.from, to: row.to })),
          warnings: [],
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
        await log.append('info', `rollback ${input.id}: ${result.restored} file(s) restored`)
        return { id: String(input.id || ''), restored: result.restored, backupId: result.safetyBackupId }
      })
    },

    async history(request) {
      await ready()
      const input = request && typeof request === 'object' ? request : {}
      if (!exists(path.join(cfg.repoDir, '.git'))) return { commits: [], error: 'the repository has not been cloned on this machine yet' }
      try {
        const token = await currentToken()
        const commits = await gitLog(cfg, token, clampInt(input.limit, 20, 1, 100))
        return { commits, error: '' }
      } catch (error) {
        return { commits: [], error: messageOf(error) }
      }
    },

    async init(request) {
      await ready()
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
      return {
        repoUrl: cfg.repoUrl,
        branch: cfg.branch,
        created,
        isPrivate: privacy.isPrivate,
        cloned: cloned || exists(path.join(cfg.repoDir, '.git')),
        bootstrapped: true,
        warnings,
      }
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
  data_sync_push: 'Push snapshot',
  data_sync_pull: 'Pull snapshot',
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
          repoUrl: { type: 'string', description: 'Private git repository URL, for example https://github.com/you/DSH-Sync-Data.git' },
          branch: { type: 'string', description: 'Branch to push/pull, default main.' },
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
        'Snapshot this machine (configuration, memory, skills per the configured sources) into the private repository and push a commit. Refuses to push when the secret screen finds a credential-shaped value. Pass `dryRun: true` to see what would travel without touching git. Use it on the machine being left, before wiping it.',
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
        'Apply the snapshot in the private repository to this machine, with the recorded absolute paths remapped to local paths. `apply: false` (the default) only previews the plan: per-file add/update/same and the mapping table. A real apply takes a local backup first; `backupId` names it for a rollback. Use it on the new machine after installing the plugin and connecting the repository.',
      parameters: {
        type: 'object',
        properties: {
          apply: { type: 'boolean', description: 'false (default) = preview only; true = back up and write the files.' },
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
