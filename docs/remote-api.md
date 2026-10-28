# Data Sync — Remote API contract (Host ↔ Client)

Package: `@local/dsh-data-sync` · remote namespace: `dataSync` · settings section id: `data-sync`

The Host half (`index.js`) and the Client half (`client.js`) declare the **same** descriptor list.
Every method is `invocation: { kind: 'direct' }`, its one parameter is a JSON object named
`request` (`source: 'json'`, strict codec), and its result is a JSON object (strict codec).
A call resolves to the method's return value, or rejects with `Error` whose `code` is the Host
failure code. All failures are thrown, never returned as `{ ok: false }`.

## Methods

| id | method | request | result |
|---|---|---|---|
| `#dataSync/status` | `status` | `StatusRequest` | `Status` |
| `#dataSync/saveConfig` | `saveConfig` | `ConfigRequest` | `Status` |
| `#dataSync/preview` | `preview` | `PreviewRequest` | `Preview` |
| `#dataSync/push` | `push` | `PushRequest` | `PushResult` |
| `#dataSync/pullPlan` | `pullPlan` | `PullPlanRequest` | `PullPlan` |
| `#dataSync/pull` | `pull` | `PullRequest` | `PullResult` |
| `#dataSync/backup` | `backup` | `BackupRequest` | `BackupResult` |
| `#dataSync/backups` | `backups` | `BackupsRequest` | `BackupList` |
| `#dataSync/rollback` | `rollback` | `RollbackRequest` | `RollbackResult` |
| `#dataSync/history` | `history` | `HistoryRequest` | `History` |
| `#dataSync/verify` | `verify` | `VerifyRequest` | `VerifyResult` |
| `#dataSync/init` | `init` | `InitRequest` | `InitResult` |

## Types

```ts
type StatusRequest = { refreshRemote?: boolean }

type Status = {
  configured: boolean            // repoUrl is non-empty
  repoUrl: string
  branch: string
  profile: string
  deviceName: string
  dataDir: string                // where the local clone, backups and state live
  dshHome: string
  profileDir: string
  memoryDir: string
  sources: { config: boolean; memory: boolean; skills: boolean }
  workspaceRoots: Array<{ label: string; path: string }>
  pathMappings: Array<{ from: string; to: string }>
  keepSnapshots: number
  autoBackup: { enabled: boolean; intervalHours: number; nextAt: number; lastError: string }
  remoteRetention: {
    enabled: boolean
    days: number
    keepLast: number             // newest versions that are never pruned
    last: null | { at: number; pruned: number; kept: number; days: number; keepLast: number; head: string }
  }
  tokenPresent: boolean          // never send the token itself to the browser
  lastPush: null | { at: number; snapshotId: string; commit: string; count: number; bytes: number }
  lastPull: null | { at: number; snapshotId: string; count: number }
  lastBackup: null | { at: number; id: string; reason: string; count: number }
  backupCount: number
  backupBytes: number
  remote: null | { checkedAt: number; ahead: number; behind: number; headCommit: string; error: string }
  logTail: string[]              // last ~20 log lines, plain text
  warnings: string[]
}

type PreviewRequest = Record<string, never>
type PullPlanRequest = { commit?: string; mappings?: Array<{ from: string; to: string }> }
type BackupRequest = Record<string, never>
type BackupsRequest = Record<string, never>

type ConfigRequest = {
  repoUrl?: string; branch?: string; profile?: string
  token?: string; tokenClear?: boolean
  sources?: { config?: boolean; memory?: boolean; skills?: boolean }
  memoryDir?: string
  workspaceRoots?: Array<{ label: string; path: string }>
  pathMappings?: Array<{ from: string; to: string }>
  keepSnapshots?: number
  autoBackup?: { enabled?: boolean; intervalHours?: number }
  remoteRetention?: { enabled?: boolean; days?: number; keepLast?: number }
  deviceName?: string
}

type FileRow = { path: string; source: 'config' | 'memory' | 'skills' | 'workspace'; size: number }
type Finding = { path: string; line: number; kind: string }

type Preview = {
  snapshotId: string
  count: number
  bytes: number
  bySource: { config: number; memory: number; skills: number; workspace: number }
  files: FileRow[]               // capped at 300
  truncated: boolean
  warnings: string[]
  secretFindings: Finding[]
}

type PushRequest = { message?: string; dryRun?: boolean }
type PushResult = {
  snapshotId: string
  count: number
  bytes: number
  commit: string                 // '' when nothing changed / dry run
  pushed: boolean
  upToDate: boolean
  dryRun: boolean
  durationMs: number
  warnings: string[]
  secretFindings: Finding[]
}

type PullPlan = {
  remoteSnapshotId: string       // '' when the remote has no snapshot yet
  remoteCommit: string
  remoteCreatedAt: number
  localSnapshotId: string        // last snapshot this machine pushed/pulled
  actions: Array<{ path: string; action: 'add' | 'update' | 'same'; source: string; size: number; localSize: number; target: string }>
  mappings: Array<{ from: string; to: string; auto: boolean }>
  workspaceMap: Array<{ label: string; path: string }>
  warnings: string[]
  secretFindings: Finding[]
}

type PullRequest = {
  apply?: boolean                // false = plan only (same as pullPlan)
  commit?: string                // apply this snapshot from the remote history instead of the branch head
  mappings?: Array<{ from: string; to: string }>   // one-shot override
}
type PullResult = {
  applied: boolean               // false when it was a plan, or when the remote already matched this machine
  snapshotId: string
  backupId: string               // '' when nothing was written
  added: number
  updated: number
  skipped: Array<{ path: string; reason: string }>
  mappings: Array<{ from: string; to: string }>
  warnings: string[]
}

type BackupResult = { backupId: string; count: number; bytes: number; path: string }
type BackupList = {
  backups: Array<{ id: string; at: number; reason: string; count: number; bytes: number }>
  totalBytes: number
}
type RollbackRequest = { id: string }
type RollbackResult = { id: string; restored: number; backupId: string; skipped: string[] }

type HistoryRequest = { limit?: number }
type History = {
  commits: Array<{ hash: string; date: string; message: string; snapshotId: string }>
  error: string
}

type VerifyRequest = { commit?: string; local?: boolean }
type VerifyResult = {
  ok: boolean                    // every payload matched the manifest
  snapshotId: string
  createdAt: number
  remoteCommit: string
  profile: string
  checked: number                // payloads read back
  verifiedBytes: number
  issues: Array<{ path: string; problem: string }>   // manifest/payload problems
  drift: Array<{ path: string; action: 'add' | 'update'; target: string; size: number; localSize: number }>
  warnings: string[]
}

type InitRequest = { repoUrl?: string; branch?: string; createPrivateName?: string }
type InitResult = {
  repoUrl: string; branch: string; created: boolean; isPrivate: boolean
  cloned: boolean; bootstrapped: boolean; warnings: string[]
}
```

## Versions and retention

- Every successful push appends one commit to the branch; each commit is a complete
  snapshot, so `history()` lists the versions and `pull({ commit })` restores one of them.
- `pull({ apply: true })` without `commit` applies the **newest** snapshot — that is the
  "restore today's version on the new machine" path.
- `remoteRetention` (default: enabled, 3 days, newest 3 versions) prunes snapshots older than
  the window from the branch after a successful push, replaying the retained trees with
  `commit-tree` and force-pushing with `--force-with-lease`. The newest `keepLast` snapshots
  are always kept, even when they are older than the window. A rejected force push (protected
  branch, or another machine pushed in between) restores the local branch and reports the
  failure — nothing is lost.
- `verify({ commit })` re-reads every payload in the repository and checks its checksum and
  size against the manifest, recomputes the manifest digest from its own file list, and
  reports the files whose local content differs from the snapshot. It is the "prove the
  backup before wiping the machine" step; the Settings page calls it *Verify snapshot*.
- `memoryDir` is the storage directory of the memory plugin itself (`storageDir`, holding
  `memories.json` + `MEMORY.md`), not a second copy. The Host detects it from the installed
  memory bundle's patch; a configured path that no longer exists is replaced by the
  detected one, and an empty value means "detect again".
- Path mappings whose `from` is a Windows drive path are matched case-insensitively
  (`d:\DSH-Memory` matches `D:\dsh-memory`), POSIX mappings stay case-sensitive.
- Repositories snapshotted by this plugin carry `install.ps1` / `install.sh` under
  `bootstrap/dsh-data-sync/`, so the new machine installs the plugin with one command
  before the pull.

## Client page contract

Register into `settings.section` with `id: 'data-sync'`, `order: 26`, `label` a locale thunk,
`inject: () => ({ api })`, where `api` wraps `callRemote` exactly like `@local/dsh-memory`'s
`client.js` (same `ctx.remote.$mount(remote)` + lazy namespace acquisition pattern — copy it).

Page content, top to bottom:

1. **Header**: title, one-line subtitle (device · repo · last push) and a refresh button.
2. **Connection card**: repo URL, branch, token (password input, placeholder says "stored" when
   `tokenPresent`), a "clear token" checkbox, and buttons: *Save*, *Connect / initialize*
   (`init`). Show `remote.ahead/behind/error`.
3. **Scope card**: three checkboxes (config / memory / skills), memory dir input, workspace root
   rows (path + add/remove), saved with *Save*.
4. **Path rewrites card**: editable `from → to` rows (starting from `status.pathMappings`), which
   are saved through `saveConfig` and travel with the snapshot.
5. **Actions card**: *Preview* (`preview`) → counts + warnings + secret findings + the file list
   (collapsed by default); *Push now* (`push`); *Check remote* (`pullPlan`) → action list
   (add/update/same counts) + mapping rows; *Apply pull* (`pull {apply:true}`) with a confirm step
   that names the backup that will be taken. Show per-action result lines (success/error), and say
   "nothing was written" when `applied` comes back `false`. Never `alert()`.
6. **Backups card**: `backups()` list (time · reason · count · size) each with a *Roll back*
   button behind an inline confirm; below it the remote history (`history`) if configured, each
   commit with an inline-confirmed *Apply this version* (`pull {apply:true, commit}`).
7. **Schedule card**: auto-backup enable + interval hours select (1/6/12/24/168) and next run,
   plus the remote retention toggle and window in days (newest version always kept).
8. **Log card**: device, data directory, and the collapsible log tail.

Refresh behaviour: a 60-second background refresh must not run while an action is in flight, and
must never re-enable a button the action disabled; it must also leave an edited form alone (the
form is dirty until Save), or a typed value or a ticked "clear token" box would be silently
reverted. Every result's `warnings[]` is rendered, not discarded: it is the only place the Host
says "the repository visibility is unverified", "the snapshot came from another profile" or
"the memory source collected nothing". A refresh that fails after the page loaded shows an inline
error instead of a blank page.

Rules: no `alert`/`confirm`/`prompt`; inline confirm state; every button disables while running;
render errors in an accessible `role="alert"` line; route all visible text through the client
locale dictionaries (en + zh, `ctx.locale.register`); styles in one injected `<style>` element
tagged `data-plugin="dsh-data-sync"`, class prefix `dsh-sync-`; inherit theme tokens
(`--dsw-alias-*` variables, the same set dsh-memory uses) rather than hard-coded colors; no
external assets; no DOM access outside the section.
