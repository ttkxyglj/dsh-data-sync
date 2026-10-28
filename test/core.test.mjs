/**
 * DSH Data Sync — core tests.
 *
 * Run with the bundled node:
 *   node --test test/core.test.mjs
 *
 * The git round-trip test uses a local bare repository, so it needs no network
 * and no credentials: it proves push → clone → remap → pull → rollback.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  applyPull,
  backupNow,
  backupTargets,
  buildManifest,
  buildMappings,
  listBackups,
  planPull,
  remapText,
  rollbackTo,
  verifySnapshot,
  writeSnapshotTree,
} from '../lib/snapshot.js'
import { collectFiles, denialReason, scanForSecrets } from '../lib/collect.js'
import { commitAndPush, ensureRepo, pruneRemoteHistory, resetToRemote, runGit } from '../lib/git.js'
import { ensureDir, mergeSaved, resolveConfig } from '../lib/util.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TMP_ROOT = path.join(HERE, '..', '.tmp-test')

async function makeTemp(name) {
  const dir = path.join(TMP_ROOT, `${name}-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`)
  await ensureDir(dir)
  return dir
}

async function write(file, text) {
  await ensureDir(path.dirname(file))
  await fsp.writeFile(file, text, 'utf8')
}

async function withEnv(key, value, task) {
  const before = process.env[key]
  process.env[key] = value
  try {
    return await task()
  } finally {
    if (before === undefined) delete process.env[key]
    else process.env[key] = before
  }
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result.stdout.trim()
}

test('the deny-list wins over every tree walk', () => {
  assert.match(denialReason('.credentials.yaml'), /denied/)
  assert.match(denialReason('profiles/desktop/.credentials.yaml'), /denied/)
  assert.match(denialReason('secrets/token.txt'), /denied/)
  assert.match(denialReason('.env.local'), /denied/)
  assert.match(denialReason('certs/server.pem'), /denied/)
  assert.match(denialReason('node_modules/pkg/index.js'), /denied/)
  assert.match(denialReason('memory.log'), /denied/)
  assert.equal(denialReason('profiles/desktop/package.json'), '')
  assert.equal(denialReason('memory/memories.json'), '')
})

test('path remapping keeps the separator and JSON escaping style', () => {
  const mappings = [
    { from: 'D:\\old\\work', to: 'E:\\new\\work', auto: false },
    { from: 'C:\\Users\\alice', to: 'C:\\Users\\bob', auto: true },
  ]
  const raw = remapText('root=D:\\old\\work\\proj\nother=E:\\new\\work\\proj', mappings)
  assert.equal(raw.text, 'root=E:\\new\\work\\proj\nother=E:\\new\\work\\proj')
  assert.ok(raw.replacements >= 1)

  const forward = remapText('link:D:/old/work/plugin', mappings)
  assert.equal(forward.text, 'link:E:/new/work/plugin')

  const json = remapText('{"path":"D:\\\\old\\\\work\\\\proj"}', mappings)
  assert.equal(json.text, '{"path":"E:\\\\new\\\\work\\\\proj"}')

  const untouched = remapText('nothing to see', mappings)
  assert.equal(untouched.replacements, 0)
})

test('remapping is a single pass, so a rule cannot rewrite another rule output', () => {
  const mappings = [
    { from: 'D:\\a', to: 'D:\\a2', auto: false },
    { from: 'D:\\a2', to: 'E:\\x', auto: false },
  ]
  const result = remapText('root=D:\\a\\file', mappings)
  assert.equal(result.text, 'root=D:\\a2\\file')
  assert.equal(result.replacements, 1)
})

test('the collector takes the whitelist and skips credentials, logs and huge files', async () => {
  const home = await makeTemp('home')
  const memory = await makeTemp('memory')
  await write(path.join(home, 'profiles', 'desktop', 'package.json'), '{"name":"p"}')
  await write(path.join(home, 'profiles', 'desktop', 'cordis.patch.yml'), '- id: memory\n')
  await write(path.join(home, 'profiles', 'desktop', '.credentials.yaml'), 'token: abc')
  await write(path.join(home, 'settings.yaml'), 'theme: light\n')
  await write(path.join(home, 'skills', 'demo', 'SKILL.md'), '# demo\n')
  await write(path.join(home, 'skills', 'demo', 'node_modules', 'x', 'index.js'), 'x')
  await write(path.join(memory, 'memories.json'), '{"version":5,"entries":[]}')
  await write(path.join(memory, 'MEMORY.md'), '# memory\n')
  await write(path.join(memory, 'memory.log'), 'noise\n')
  await write(path.join(home, 'profiles', 'desktop', 'big.json'), `${'x'.repeat(5 * 1024 * 1024)}`)

  const cfg = resolveConfig({ dshHome: home, dataDir: path.join(home, 'data'), memoryDir: memory, profile: 'desktop' })
  const collected = await collectFiles(cfg)
  const rels = collected.files.map((file) => `${file.source}:${file.rel}`).sort()
  assert.deepEqual(rels, [
    'config:profiles/desktop/cordis.patch.yml',
    'config:profiles/desktop/package.json',
    'config:settings.yaml',
    'memory:MEMORY.md',
    'memory:memories.json',
    'skills:skills/demo/SKILL.md',
  ])
  assert.equal(collected.secretFindings.length, 0)
})

test('the secret screen catches a real credential and ignores references', async () => {
  const home = await makeTemp('secrets')
  const memory = await makeTemp('secrets-memory')
  await write(path.join(home, 'settings.yaml'), 'apiKey: ghp_0123456789abcdefghijABCDEFGHIJ\nsafe: ${MY_TOKEN}\nenvRef: process.env.OPENAI_API_KEY\n')
  const cfg = resolveConfig({ dshHome: home, dataDir: path.join(home, 'data'), memoryDir: memory, profile: 'desktop' })
  const collected = await collectFiles(cfg)
  assert.equal(collected.secretFindings.length, 1)
  assert.equal(collected.secretFindings[0].kind, 'github-token')
})

test('push → clone → remap → pull → rollback round trip', async () => {
  const root = await makeTemp('roundtrip')
  const sourceHome = path.join(root, 'home-a')
  const sourceMemory = path.join(root, 'memory-a')
  const targetHome = path.join(root, 'home-b')
  const targetMemory = path.join(root, 'memory-b')
  const bare = path.join(root, 'remote.git')
  await ensureDir(bare)
  git(bare, ['init', '--bare', '-q'])

  await write(path.join(sourceHome, 'profiles', 'desktop', 'package.json'), '{"dependencies":{"@local/x":"link:D:/old/work/x"}}')
  await write(path.join(sourceHome, 'profiles', 'desktop', 'cordis.patch.yml'), '- id: memory\n  config:\n    storageDir: \'' + sourceMemory + '\'\n')
  await write(path.join(sourceHome, 'skills', 'demo', 'SKILL.md'), 'skill at D:/old/work\n')
  await write(path.join(sourceMemory, 'memories.json'), '{"project":"D:\\\\old\\\\work\\\\proj"}')
  await write(path.join(sourceMemory, 'MEMORY.md'), '# memory\n')

  const cfgA = resolveConfig({
    dshHome: sourceHome,
    dataDir: path.join(root, 'data-a'),
    memoryDir: sourceMemory,
    profile: 'desktop',
    repoUrl: bare,
    branch: 'main',
    pathMappings: [{ from: 'D:\\old\\work', to: 'D:\\new\\work' }],
  })
  cfgA.dshHome = sourceHome
  cfgA.profileDir = path.join(sourceHome, 'profiles', 'desktop')

  const collected = await collectFiles(cfgA)
  assert.ok(collected.count >= 4)
  const manifest = buildManifest(cfgA, collected, '20261027-000000-abcdef')
  await ensureRepo(cfgA, '', null)
  await writeSnapshotTree(cfgA, manifest, collected)
  const pushed = await commitAndPush(cfgA, '', 'test snapshot')
  assert.equal(pushed.pushed, true)

  const cfgB = resolveConfig({
    dshHome: targetHome,
    dataDir: path.join(root, 'data-b'),
    memoryDir: targetMemory,
    profile: 'desktop',
    repoUrl: bare,
    branch: 'main',
  })
  cfgB.dshHome = targetHome
  cfgB.profileDir = path.join(targetHome, 'profiles', 'desktop')
  await ensureRepo(cfgB, '', null)
  const remote = await resetToRemote(cfgB, '')
  assert.ok(remote.manifest, 'the remote snapshot must be readable')

  const mappings = buildMappings(cfgB, remote.manifest)
  const plan = await planPull(cfgB, remote.manifest, mappings)
  assert.ok(plan.actions.every((row) => row.action === 'add'), 'every file is new on the target machine')
  const backup = await backupNow(cfgB, { reason: 'pre-pull', willCreate: plan.actions.map((row) => row.target) })
  assert.ok(backup.id)
  const applied = await applyPull(cfgB, remote.manifest, mappings)
  assert.equal(applied.added.length, plan.actions.length)

  const packageJson = await fsp.readFile(path.join(targetHome, 'profiles', 'desktop', 'package.json'), 'utf8')
  assert.match(packageJson, /D:\/new\/work\/x/, 'the link: dependency is remapped to the new path')
  const memories = await fsp.readFile(path.join(targetMemory, 'memories.json'), 'utf8')
  assert.ok(!memories.includes('D:\\\\old\\\\work'), 'the escaped JSON path is remapped too')

  const backups = await listBackups(cfgB)
  assert.equal(backups.length, 1)
  const rolled = await rollbackTo(cfgB, backup.id)
  assert.equal(rolled.restored, 0, 'nothing existed before the pull, so there was nothing to restore')
  await assert.rejects(fsp.stat(path.join(targetHome, 'profiles', 'desktop', 'package.json')))
})

test('the backup rotation keeps only the configured number of copies', async () => {
  const home = await makeTemp('rotation-home')
  const memory = await makeTemp('rotation-memory')
  await write(path.join(home, 'settings.yaml'), 'theme: light\n')
  await write(path.join(memory, 'memories.json'), '{"entries":[]}')
  const cfg = resolveConfig({ dshHome: home, dataDir: path.join(home, 'data'), memoryDir: memory, profile: 'desktop', keepSnapshots: 2 })
  cfg.dshHome = home
  for (let index = 0; index < 4; index += 1) {
    await backupNow(cfg, { reason: `manual-${index}` })
  }
  const rows = await listBackups(cfg)
  assert.equal(rows.length, 2)
})

test('a rollback never prunes the backup it is restoring from', async () => {
  const home = await makeTemp('protect-home')
  const memory = await makeTemp('protect-memory')
  await write(path.join(home, 'settings.yaml'), 'version: one\n')
  const cfg = resolveConfig({ dshHome: home, dataDir: path.join(home, 'data'), memoryDir: memory, profile: 'desktop', keepSnapshots: 1 })
  const first = await backupNow(cfg, { reason: 'first' })
  await write(path.join(home, 'settings.yaml'), 'version: two\n')
  const rolled = await rollbackTo(cfg, first.id)
  assert.equal(rolled.restored, 1, 'the safety backup must not evict the target of the rollback')
  const text = await fsp.readFile(path.join(home, 'settings.yaml'), 'utf8')
  assert.match(text, /version: one/)
})

test('a profile change moves the derived profile directory', () => {
  const base = resolveConfig({ dshHome: path.join(TMP_ROOT, 'profile-home'), profile: 'web' })
  const merged = mergeSaved(base, { profile: 'desktop' })
  assert.equal(merged.profile, 'desktop')
  assert.equal(merged.profileDir, path.join(base.dshHome, 'profiles', 'desktop'))
})

test('a manifest path that escapes the repository is refused', async () => {
  const home = await makeTemp('traversal-home')
  const memory = await makeTemp('traversal-memory')
  const cfg = resolveConfig({ dshHome: home, dataDir: path.join(home, 'data'), memoryDir: memory, profile: 'desktop' })
  const manifest = {
    schema: 'dsh-data-sync/1',
    snapshotId: 'x',
    paths: { dshHome: home, memoryDir: memory },
    files: [
      { path: '../../outside.txt', source: 'config', rel: 'outside.txt', sha256: '0', size: 1 },
      { path: 'C:/Windows/win.ini', source: 'config', rel: 'win.ini', sha256: '0', size: 1 },
    ],
  }
  const plan = await planPull(cfg, manifest, [])
  assert.equal(plan.actions.length, 0)
  assert.equal(plan.skipped.length, 2)
  assert.match(plan.skipped[0].reason, /invalid entry/)
})

test('remapping respects path boundaries', () => {
  const mappings = [{ from: 'D:\\dsh', to: 'E:\\x', auto: false }]
  assert.equal(remapText('D:\\dsh-workplace-data', mappings).text, 'D:\\dsh-workplace-data')
  assert.equal(remapText('D:\\dsh-memory', mappings).text, 'D:\\dsh-memory')
  assert.equal(remapText('D:\\dsh\\a', mappings).text, 'E:\\x\\a')
  assert.equal(remapText('"D:\\\\dsh\\\\a"', mappings).text, '"E:\\\\x\\\\a"')
})

test('drive-letter mappings are case-insensitive, POSIX ones are not', () => {
  const windows = [{ from: 'D:\\dsh-memory', to: 'E:\\mem' }]
  assert.equal(remapText('d:\\DSH-MEMORY\\memories.json', windows).text, 'E:\\mem\\memories.json')
  assert.equal(remapText('D:/Dsh-Memory/x', windows).text, 'E:/mem/x')
  assert.equal(remapText('D:\\dsh-memory-backup', windows).text, 'D:\\dsh-memory-backup', 'the boundary still applies')
  const posix = [{ from: '/home/alice', to: '/home/bob' }]
  assert.equal(remapText('/Home/Alice/x', posix).text, '/Home/Alice/x', 'POSIX paths stay case-sensitive')
  assert.equal(remapText('/home/alice/x', posix).text, '/home/bob/x')
})

test('the secret screen understands JSON credentials', async () => {
  const dir = await makeTemp('json-secret')
  const file = path.join(dir, 'state.json')
  await write(file, '{\n  "password": "hunter2hunter2hunter2",\n  "apiKey": "ghp_0123456789abcdefghijABCDEFGHIJ"\n}\n')
  const stat = await fsp.stat(file)
  const findings = await scanForSecrets([{ rel: 'state.json', abs: file, size: stat.size }])
  assert.ok(findings.some((row) => row.line === 2), 'a JSON password must be found')
  assert.ok(findings.some((row) => row.line === 3), 'a JSON api key must be found')
})

test('a pre-pull backup of the exact targets can be rolled back', async () => {
  const home = await makeTemp('targets-home')
  const target = path.join(home, 'profiles', 'desktop', 'package.json')
  await write(target, '{"v":1}')
  const cfg = resolveConfig({ dshHome: home, dataDir: path.join(home, 'data'), profile: 'desktop' })
  const backup = await backupTargets(cfg, {
    reason: 'pre-pull',
    targets: [{ target, source: 'config', rel: 'profiles/desktop/package.json' }],
    willCreate: [],
  })
  assert.equal(backup.count, 1)
  await write(target, '{"v":2}')
  const rolled = await rollbackTo(cfg, backup.id)
  assert.equal(rolled.restored, 1)
  assert.equal(await fsp.readFile(target, 'utf8'), '{"v":1}')
})

test('entries from another profile are skipped instead of overwriting it', async () => {
  const home = await makeTemp('other-profile')
  const memory = await makeTemp('other-profile-memory')
  const cfg = resolveConfig({ dshHome: home, dataDir: path.join(home, 'data'), memoryDir: memory, profile: 'desktop' })
  const manifest = {
    schema: 'dsh-data-sync/1',
    snapshotId: 's',
    profile: 'headless',
    paths: { dshHome: home, memoryDir: memory },
    files: [
      { path: 'files/config/profiles/headless/package.json', source: 'config', rel: 'profiles/headless/package.json', sha256: '0', size: 1 },
    ],
  }
  const plan = await planPull(cfg, manifest, [])
  assert.equal(plan.actions.length, 0)
  assert.match(plan.skipped[0].reason, /belongs to profile "headless"/)
})

test('remote retention drops old snapshots and always keeps the newest', async () => {
  const root = await makeTemp('retention')
  const bare = path.join(root, 'remote.git')
  await ensureDir(bare)
  git(bare, ['init', '--bare', '-q'])
  const home = path.join(root, 'home')
  await ensureDir(home)
  const cfg = resolveConfig({ dshHome: home, dataDir: path.join(root, 'data'), profile: 'desktop', repoUrl: bare })
  await ensureRepo(cfg, '', null)
  const now = Date.now()
  const iso = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString()
  const commitSnapshot = async (id, daysAgo) => {
    await write(path.join(cfg.repoDir, 'payload.txt'), id)
    await runGit(['add', '-A'], { cwd: cfg.repoDir })
    const made = await runGit(['commit', '-q', '-m', `snapshot: ${id} — test`], {
      cwd: cfg.repoDir,
      env: { GIT_AUTHOR_DATE: iso(daysAgo), GIT_COMMITTER_DATE: iso(daysAgo) },
    })
    assert.equal(made.code, 0)
    const pushed = await runGit(['push', 'origin', 'HEAD:refs/heads/main'], { cwd: cfg.repoDir })
    assert.equal(pushed.code, 0)
    return id
  }
  const first = await commitSnapshot('20260101-000000-aaaaaa', 6)
  const second = await commitSnapshot('20260102-000000-bbbbbb', 4)
  await commitSnapshot('20261027-000000-cccccc', 1)
  await commitSnapshot('20261027-120000-dddddd', 0)

  const result = await pruneRemoteHistory(cfg, '', { days: 3, now })
  assert.equal(result.pruned, 2)
  assert.deepEqual([...result.snapshotIds].sort(), [first, second].sort())
  assert.equal(git(bare, ['rev-list', '--count', 'main']), '2')
  assert.equal(git(bare, ['show', 'main:payload.txt']), '20261027-120000-dddddd')
  assert.equal(git(bare, ['log', '-1', '--format=%s', 'main']).includes('20261027-120000-dddddd'), true)

  // The newest snapshot survives even when it is itself older than the window.
  const later = await pruneRemoteHistory(cfg, '', { days: 1, now: now + 30 * 86400000 })
  assert.equal(later.pruned, 1)
  assert.equal(git(bare, ['rev-list', '--count', 'main']), '1')
  assert.equal(git(bare, ['show', 'main:payload.txt']), '20261027-120000-dddddd')
})

test('retention keeps the newest versions even when they are older than the window', async () => {
  const root = await makeTemp('retention-keep')
  const bare = path.join(root, 'remote.git')
  await ensureDir(bare)
  git(bare, ['init', '--bare', '-q'])
  const home = path.join(root, 'home')
  await ensureDir(home)
  const cfg = resolveConfig({ dshHome: home, dataDir: path.join(root, 'data'), profile: 'desktop', repoUrl: bare })
  await ensureRepo(cfg, '', null)
  const now = Date.now()
  const iso = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString()
  const commitSnapshot = async (id, daysAgo) => {
    await write(path.join(cfg.repoDir, 'payload.txt'), id)
    await runGit(['add', '-A'], { cwd: cfg.repoDir })
    const made = await runGit(['commit', '-q', '-m', `snapshot: ${id} — test`], {
      cwd: cfg.repoDir,
      env: { GIT_AUTHOR_DATE: iso(daysAgo), GIT_COMMITTER_DATE: iso(daysAgo) },
    })
    assert.equal(made.code, 0)
    const pushed = await runGit(['push', 'origin', 'HEAD:refs/heads/main'], { cwd: cfg.repoDir })
    assert.equal(pushed.code, 0)
    return id
  }
  await commitSnapshot('20260101-000000-aaaaaa', 10)
  await commitSnapshot('20260102-000000-bbbbbb', 9)
  await commitSnapshot('20260103-000000-cccccc', 8)
  const sevenDays = await commitSnapshot('20260104-000000-dddddd', 7)
  const newest = await commitSnapshot('20261028-000000-eeeeee', 1)

  // Window is 3 days, but the newest two versions are kept regardless of age.
  const result = await pruneRemoteHistory(cfg, '', { days: 3, keepLast: 2, now })
  assert.equal(result.pruned, 3)
  assert.equal(git(bare, ['rev-list', '--count', 'main']), '2')
  assert.equal(git(bare, ['show', 'main:payload.txt']), newest)
  const subjects = git(bare, ['log', '--format=%s', 'main']).split('\n')
  assert.ok(subjects.some((line) => line.includes(sevenDays)), 'the second newest version survives the window')
})

test('verify re-reads every payload and reports a tampered snapshot', async () => {
  const root = await makeTemp('verify')
  const home = path.join(root, 'home')
  const memory = path.join(root, 'memory')
  const bare = path.join(root, 'remote.git')
  await ensureDir(bare)
  git(bare, ['init', '--bare', '-q'])
  await write(path.join(home, 'settings.yaml'), 'theme: light\n')
  await write(path.join(memory, 'memories.json'), '{"entries":["D:\\\\old\\\\work"]}')
  const cfg = resolveConfig({ dshHome: home, dataDir: path.join(root, 'data'), memoryDir: memory, profile: 'desktop', repoUrl: bare })
  const collected = await collectFiles(cfg)
  const manifest = buildManifest(cfg, collected, '20261028-000000-aaaaaa')
  await ensureRepo(cfg, '', null)
  await writeSnapshotTree(cfg, manifest, collected)
  await commitAndPush(cfg, '', 'test snapshot')
  const remote = await resetToRemote(cfg, '')
  assert.ok(remote.manifest)
  const mappings = buildMappings(cfg, remote.manifest)
  const plan = await planPull(cfg, remote.manifest, mappings)

  const report = await verifySnapshot(cfg, remote.manifest, mappings, plan)
  assert.equal(report.ok, true)
  assert.ok(report.checked >= 2)
  assert.equal(report.issues.length, 0)
  assert.equal(report.drift.length, 0, 'the machine matches its own snapshot')

  const entry = remote.manifest.files.find((row) => row.rel === 'memories.json')
  assert.ok(entry)
  await fsp.writeFile(path.join(cfg.repoDir, ...entry.path.split('/')), '{"entries":["tampered"]}')
  const broken = await verifySnapshot(cfg, remote.manifest, mappings, plan)
  assert.equal(broken.ok, false)
  assert.equal(broken.issues.length >= 1, true)
  assert.match(broken.issues[0].problem, /checksum|size/)
})

test('a commit whose push failed is pushed on the next attempt', async () => {
  const root = await makeTemp('ahead')
  const bare = path.join(root, 'remote.git')
  await ensureDir(bare)
  git(bare, ['init', '--bare', '-q'])
  const home = path.join(root, 'home')
  await ensureDir(home)
  const cfg = resolveConfig({ dshHome: home, dataDir: path.join(root, 'data'), profile: 'desktop', repoUrl: bare })
  await ensureRepo(cfg, '', null)
  await write(path.join(cfg.repoDir, 'manifest.json'), '{"schema":"dsh-data-sync/1"}')
  await runGit(['add', '-A'], { cwd: cfg.repoDir })
  const commit = await runGit(['commit', '-q', '-m', 'snapshot: manual'], { cwd: cfg.repoDir })
  assert.equal(commit.code, 0)
  const result = await commitAndPush(cfg, '', 'snapshot: no-op')
  assert.equal(result.pushed, true)
  assert.equal(result.recovered, true)
  assert.equal(git(bare, ['rev-parse', 'main']), result.commit)
})
