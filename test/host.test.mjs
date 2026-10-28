/**
 * DSH Data Sync — host service tests.
 *
 * Runs the real Host plugin (`plugin/index.js`) against a fake Cordis context:
 * the service it `provide`s is the same object the tools and the Remote
 * namespace call, so this exercises the whole Host half without a Harness.
 *
 *   node --test test/host.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { apply, inject, name, remoteContribution } from '../index.js'
import { ensureDir } from '../lib/util.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TMP_ROOT = path.join(HERE, '..', '.tmp-test')

async function makeTemp(label) {
  const dir = path.join(TMP_ROOT, `host-${label}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`)
  await ensureDir(dir)
  return dir
}

async function write(file, text) {
  await ensureDir(path.dirname(file))
  await fsp.writeFile(file, text, 'utf8')
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

/** A Cordis-shaped context that records what the plugin registers. */
function fakeContext() {
  const provided = new Map()
  const tools = []
  const sections = []
  const ctx = {
    effect(fn) {
      const cleanup = fn()
      return () => {
        if (typeof cleanup === 'function') cleanup()
      }
    },
    provide(namespace, service) {
      provided.set(namespace, service)
      return service
    },
    on() {
      return () => {}
    },
    get() {
      throw new Error('service not available in the fake context')
    },
    typert: { register(contribution) { return contribution } },
    systemPrompt: { section(section) { sections.push(section); return () => {} } },
    tools: { register(definition) { tools.push(definition); return () => {} } },
  }
  return { ctx, provided, tools, sections }
}

test('the plugin exposes its declared surface', () => {
  assert.equal(name, 'data-sync')
  assert.deepEqual(inject, ['tools', 'typert', 'systemPrompt'])
  assert.equal(remoteContribution.descriptors.length, 12)
  const methods = remoteContribution.descriptors.map((row) => row.method)
  assert.deepEqual(methods, [
    'status', 'saveConfig', 'preview', 'push', 'pullPlan', 'pull',
    'backup', 'backups', 'rollback', 'history', 'verify', 'init',
  ])
})

test('the host half registers nine tools and provides the service', () => {
  const { ctx, provided, tools } = fakeContext()
  apply(ctx, {})
  const service = provided.get('dataSync')
  assert.ok(service, 'the dataSync service is provided')
  assert.ok(service.typertRemote, 'the service carries its typertRemote binding')
  assert.deepEqual(tools.map((row) => row.name).sort(), [
    'data_sync_backup', 'data_sync_configure', 'data_sync_history', 'data_sync_init',
    'data_sync_pull', 'data_sync_push', 'data_sync_rollback', 'data_sync_status',
    'data_sync_verify',
  ])
})

test('push, plan, pull and rollback work through the service', async () => {
  const root = await makeTemp('service')
  const home = path.join(root, 'home')
  const memory = path.join(root, 'memory')
  const bare = path.join(root, 'remote.git')
  await ensureDir(bare)
  git(bare, ['init', '--bare', '-q'])

  await write(path.join(home, 'profiles', 'desktop', 'package.json'), '{"dependencies":{"x":"link:D:/old/x"}}')
  await write(path.join(home, 'settings.yaml'), 'theme: light\n')
  await write(path.join(memory, 'memories.json'), '{"entries":[{"text":"keep me"}]}')

  const { ctx, provided } = fakeContext()
  apply(ctx, {
    dshHome: home,
    profile: 'desktop',
    dataDir: path.join(root, 'data'),
    memoryDir: memory,
    repoUrl: bare,
    branch: 'main',
    pathMappings: [{ from: 'D:\\old', to: 'D:\\new' }],
  })
  const service = provided.get('dataSync')

  const initial = await service.status({})
  assert.equal(initial.configured, true)
  assert.equal(initial.tokenPresent, false)
  assert.equal(initial.sources.config, true)

  const preview = await service.preview({})
  assert.ok(preview.count >= 3)
  assert.equal(preview.secretFindings.length, 0)

  const dry = await service.push({ dryRun: true })
  assert.equal(dry.dryRun, true)
  assert.equal(dry.pushed, false)
  assert.equal(dry.commit, '')

  const pushed = await service.push({ message: 'moving house' })
  assert.equal(pushed.pushed, true)
  assert.ok(pushed.commit.length >= 7)
  assert.ok(pushed.count >= 3)

  const again = await service.push({})
  assert.equal(again.upToDate, true, 'a second push with no changes is a no-op')

  const plan = await service.pullPlan({})
  assert.equal(plan.remoteSnapshotId, pushed.snapshotId)
  assert.ok(plan.actions.length >= 3)
  assert.ok(plan.actions.some((row) => row.action === 'same'), 'unchanged files are recognised')
  assert.equal(plan.actions.filter((row) => row.action === 'update').length, 1, 'only the file carrying the mapped path differs')
  const mapping = plan.mappings.find((row) => row.from === 'D:\\old')
  assert.ok(mapping, 'the recorded rule travels with the snapshot')

  const previewPull = await service.pull({})
  assert.equal(previewPull.applied, false)
  assert.equal(previewPull.updated, 1)
  assert.equal(previewPull.added, 0)

  const applied = await service.pull({ apply: true })
  assert.equal(applied.applied, true)
  assert.equal(applied.updated, 1)
  assert.ok(applied.backupId)
  const remapped = await fsp.readFile(path.join(home, 'profiles', 'desktop', 'package.json'), 'utf8')
  assert.match(remapped, /D:\/new\/x/, 'the service remapped the path it applied')

  const verified = await service.verify({ local: true })
  assert.equal(verified.ok, true)
  assert.equal(verified.snapshotId, pushed.snapshotId)
  assert.ok(verified.checked >= 3)
  assert.equal(verified.issues.length, 0)
  assert.equal(verified.drift.length, 0, 'after the pull this machine matches the snapshot')

  const history = await service.history({ limit: 5 })
  assert.ok(history.commits.length >= 1)
  assert.match(history.commits[0].message, /snapshot:/)

  const backup = await service.backup({})
  assert.ok(backup.backupId)
  const listed = await service.backups({})
  assert.ok(listed.backups.length >= 2, 'the pre-pull backup and the manual one are both kept')

  const rolled = await service.rollback({ id: backup.backupId })
  assert.equal(rolled.id, backup.backupId)
  assert.ok(rolled.restored >= 3)

  const remote = await service.status({ refreshRemote: true })
  assert.equal(remote.remote.error, '')
})

test('the secret screen stops a push through the service', async () => {
  const root = await makeTemp('secret')
  const home = path.join(root, 'home')
  const memory = path.join(root, 'memory')
  const bare = path.join(root, 'remote.git')
  await ensureDir(bare)
  git(bare, ['init', '--bare', '-q'])
  await write(path.join(home, 'settings.yaml'), 'apiKey: ghp_0123456789abcdefghijABCDEFGHIJ\n')
  await write(path.join(memory, 'memories.json'), '{"entries":[]}')

  const { ctx, provided } = fakeContext()
  apply(ctx, { dshHome: home, profile: 'desktop', dataDir: path.join(root, 'data'), memoryDir: memory, repoUrl: bare })
  const service = provided.get('dataSync')
  await assert.rejects(() => service.push({}), (error) => error.code === 'SECRETS_FOUND')
})

test('an empty selection is refused instead of wiping the remote', async () => {
  const root = await makeTemp('empty')
  const home = path.join(root, 'home')
  const memory = path.join(root, 'memory')
  const bare = path.join(root, 'remote.git')
  await ensureDir(bare)
  git(bare, ['init', '--bare', '-q'])

  const { ctx, provided } = fakeContext()
  apply(ctx, {
    dshHome: home,
    profile: 'desktop',
    dataDir: path.join(root, 'data'),
    memoryDir: memory,
    repoUrl: bare,
    sources: { config: false, memory: false, skills: false },
  })
  const service = provided.get('dataSync')
  await assert.rejects(() => service.push({}), (error) => error.code === 'EMPTY_SNAPSHOT')
})

test('an older snapshot can be applied by commit from the remote history', async () => {  const root = await makeTemp('older')
  const home = path.join(root, 'home')
  const memory = path.join(root, 'memory')
  const bare = path.join(root, 'remote.git')
  await ensureDir(bare)
  git(bare, ['init', '--bare', '-q'])
  await write(path.join(home, 'settings.yaml'), 'theme: light\n')
  await write(path.join(memory, 'memories.json'), '{"version":1}')

  const { ctx, provided } = fakeContext()
  apply(ctx, { dshHome: home, profile: 'desktop', dataDir: path.join(root, 'data'), memoryDir: memory, repoUrl: bare })
  const service = provided.get('dataSync')

  const first = await service.push({ message: 'v1' })
  assert.equal(first.pushed, true)
  await write(path.join(memory, 'memories.json'), '{"version":2}')
  const second = await service.push({ message: 'v2' })
  assert.equal(second.pushed, true)
  assert.notEqual(second.commit, first.commit)

  const plan = await service.pullPlan({ commit: first.commit })
  assert.equal(plan.remoteCommit, first.commit)
  assert.equal(plan.remoteSnapshotId, first.snapshotId)

  const applied = await service.pull({ apply: true, commit: first.commit })
  assert.equal(applied.applied, true)
  assert.equal(applied.updated, 1)
  const text = await fsp.readFile(path.join(memory, 'memories.json'), 'utf8')
  assert.match(text, /"version":1/)

  // A commit outside the branch history is refused instead of resetting to it.
  await assert.rejects(
    () => service.pull({ apply: true, commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }),
    (error) => error.code === 'COMMIT_NOT_FOUND' || error.code === 'COMMIT_UNREACHABLE',
  )
})

test('a linked bundle patch is scanned for the memory directory', async (t) => {
  const root = await makeTemp('memory-link')
  const home = path.join(root, 'home')
  const memory = path.join(root, 'memory')
  const pkg = path.join(root, 'pkg', '@local', 'dsh-memory')
  await write(path.join(pkg, 'cordis.patch.yml'), `- id: memory\n  config:\n    storageDir: '${memory.replace(/\\/g, '/')}'\n`)
  await write(path.join(memory, 'memories.json'), '{"entries":[]}')
  await ensureDir(path.join(home, 'profiles', 'desktop', 'node_modules', '@local'))
  const link = path.join(home, 'profiles', 'desktop', 'node_modules', '@local', 'dsh-memory')
  try {
    // `link:` installs are junctions on Windows and Dirent.isDirectory() is false
    // for them, which is exactly how this machine installs the memory plugin.
    await fsp.symlink(pkg, link, 'junction')
  } catch (error) {
    t.skip(`cannot create a junction here: ${error.message}`)
    return
  }
  const { ctx, provided } = fakeContext()
  apply(ctx, { dshHome: home, profile: 'desktop', dataDir: path.join(root, 'data') })
  const status = await provided.get('dataSync').status({})
  assert.equal(status.memoryDir, memory)
})

test('a stale saved memory directory is replaced by the detected one', async () => {
  const root = await makeTemp('memory-stale')
  const home = path.join(root, 'home')
  const memory = path.join(root, 'memory')
  const dataDir = path.join(root, 'data')
  await ensureDir(memory)
  // The bundle patch knows the real store; an older save persisted the fallback.
  await write(
    path.join(home, 'profiles', 'desktop', 'node_modules', '@local', 'dsh-memory', 'cordis.patch.yml'),
    `- id: memory\n  config:\n    storageDir: '${memory.replace(/\\/g, '/')}'\n`,
  )
  await write(path.join(memory, 'memories.json'), '{"entries":[]}')
  await write(
    path.join(dataDir, 'config.json'),
    JSON.stringify({ memoryDir: path.join(home, 'storages', 'memory'), profile: 'desktop' }),
  )

  const { ctx, provided } = fakeContext()
  apply(ctx, { dshHome: home, profile: 'desktop', dataDir })
  const service = provided.get('dataSync')
  const status = await service.status({})
  assert.equal(status.memoryDir, memory)

  // Clearing the field means "detect again", not "keep the old value".
  const cleared = await service.saveConfig({ memoryDir: '' })
  assert.equal(cleared.memoryDir, memory)
})

test('a second machine pulls the newest pushed snapshot, or an older one by commit', async () => {
  const root = await makeTemp('second-machine')
  const bare = path.join(root, 'remote.git')
  await ensureDir(bare)
  git(bare, ['init', '--bare', '-q'])
  const homeA = path.join(root, 'homeA')
  const memoryA = path.join(root, 'memoryA')
  await write(path.join(homeA, 'settings.yaml'), 'theme: light\n')
  await write(path.join(memoryA, 'memories.json'), '{"version":1}')

  const a = fakeContext()
  apply(a.ctx, {
    dshHome: homeA,
    profile: 'desktop',
    dataDir: path.join(root, 'dataA'),
    memoryDir: memoryA,
    repoUrl: bare,
    remoteRetention: { enabled: true, days: 3 },
  })
  const sa = a.provided.get('dataSync')
  const first = await sa.push({ message: 'yesterday' })
  assert.equal(first.pushed, true)
  await write(path.join(memoryA, 'memories.json'), '{"version":2}')
  const second = await sa.push({ message: 'today' })
  assert.equal(second.pushed, true)
  assert.ok(!second.warnings.some((row) => row.includes('retention failed')))
  const statusA = await sa.status({})
  assert.equal(statusA.remoteRetention.enabled, true)
  assert.equal(statusA.remoteRetention.days, 3)

  // A fresh machine with no repository: pull without naming a version means "the
  // newest pushed snapshot" (today's), and the mapping relocates the memory store.
  const homeB = path.join(root, 'homeB')
  const memoryB = path.join(root, 'memoryB')
  await ensureDir(homeB)
  const b = fakeContext()
  apply(b.ctx, { dshHome: homeB, profile: 'desktop', dataDir: path.join(root, 'dataB'), memoryDir: memoryB, repoUrl: bare })
  const sb = b.provided.get('dataSync')
  const applied = await sb.pull({ apply: true })
  assert.equal(applied.applied, true)
  const latest = JSON.parse(await fsp.readFile(path.join(memoryB, 'memories.json'), 'utf8'))
  assert.equal(latest.version, 2)

  const history = await sb.history({})
  assert.ok(history.commits.length >= 2)
  const ids = history.commits.map((row) => row.snapshotId)
  assert.ok(ids.includes(first.snapshotId), 'yesterday\ns snapshot is listed')
  assert.ok(ids.includes(second.snapshotId), 'today\ns snapshot is listed')

  // Yesterday's version is still reachable by commit.
  const older = await sb.pull({ apply: true, commit: first.commit })
  assert.equal(older.applied, true)
  const restored = JSON.parse(await fsp.readFile(path.join(memoryB, 'memories.json'), 'utf8'))
  assert.equal(restored.version, 1)
})

test('the memory directory is detected from an installed bundle patch', async () => {
  const root = await makeTemp('memory-detect')
  const home = path.join(root, 'home')
  const memory = path.join(root, 'memory')
  const bare = path.join(root, 'remote.git')
  await ensureDir(bare)
  git(bare, ['init', '--bare', '-q'])
  // The profile patch has no storageDir; the installed memory bundle does, which
  // is how the real installation stores it.
  await write(path.join(home, 'profiles', 'desktop', 'cordis.patch.yml'), '- id: memory\n')
  await write(
    path.join(home, 'profiles', 'desktop', 'node_modules', '@local', 'dsh-memory', 'cordis.patch.yml'),
    `- id: memory\n  config:\n    storageDir: '${memory.replace(/\\/g, '/')}'\n`,
  )
  await write(path.join(home, 'profiles', 'desktop', 'package.json'), JSON.stringify({ name: 'profile', dependencies: { '@local/dsh-data-sync': 'link:.' } }))
  await write(path.join(memory, 'memories.json'), '{"entries":[]}')
  await write(path.join(memory, 'MEMORY.md'), '# Memory\n')

  const { ctx, provided } = fakeContext()
  apply(ctx, { dshHome: home, profile: 'desktop', dataDir: path.join(root, 'data'), repoUrl: bare })
  const service = provided.get('dataSync')
  const status = await service.status({})
  assert.equal(status.memoryDir, memory)
  const preview = await service.preview({})
  assert.ok(preview.bySource.memory >= 2, 'both memory files must be collected')
  const pushed = await service.push({})
  assert.equal(pushed.pushed, true)
  assert.ok(!pushed.warnings.some((row) => row.includes('no memory file was found')), 'no false empty-memory warning')
})
