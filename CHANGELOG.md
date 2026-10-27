# Changelog

## 0.3.0 — 2026-10-27

An independent audit of 0.2.0 found a theme the first two passes had missed: where the
plugin cannot confirm something (repository visibility, payload integrity, the profile,
the memory store, whether git really pushed), it tended to finish anyway and return
success. Everything below was reproduced first; each fix has a test or a documented
contract change.

### Fixed — "it said it worked" (P0)

- **The memory store was silently not backed up.** `storageDir` is written in the installed
  memory bundle's own patch, not in `profiles/<profile>/cordis.patch.yml`, so the detector fell
  back to a directory that does not exist, collected zero memory files and still pushed
  "successfully" — the one thing this plugin must never do. Detection now checks
  `DSH_MEMORY_DIR`, the home patch, the profile patch and every installed bundle patch, and a
  push whose memory source collects nothing says so in `warnings`.
  *(`the memory directory is detected from an installed bundle patch`)*
- **A pull could overwrite files its backup did not contain.** The pre-pull backup was built
  from the current profile's whitelist, so a snapshot pushed from another profile could write
  into `profiles/<other>/…` and the rollback could not restore it. Pull now backs up exactly the
  targets it is about to write (`backupTargets`), and entries belonging to another profile are
  skipped with a reason instead of written.
  *(`entries from another profile are skipped instead of overwriting it`,
  `a pre-pull backup of the exact targets can be rolled back`)*
- **A commit whose push failed was never pushed.** `commitAndPush` returned `upToDate: true`
  whenever the staging area was empty, so a push that failed after committing left the commit
  local forever while the UI said "already up to date" and `lastPush` recorded it. The empty-stage
  path now counts commits no remote contains and pushes them.
  *(`a commit whose push failed is pushed on the next attempt`)*
- **The stored GitHub token was attached to every host.** The auth header is now only added for
  `github.com`, and it is added to fetch/push/ls-remote as well (previously only to `clone`, so a
  token-only setup worked once and then fell back to a credential helper).

### Fixed — trust boundaries

- **Payload checksums were never verified** against `manifest.files[].sha256`, and an entry whose
  `path` and `rel` disagreed could copy one file over an unrelated target. Both are now asserted;
  a mismatch is a skip, never a write.
- **`applyPull` had no failure path.** A write error (file locked, disk full) left a half-applied
  snapshot, threw with no backup id and did not record `lastPull`. It now restores the pre-pull
  backup and reports `APPLY_FAILED` with that id.
- **The private-repository check** treated an unreadable GitHub response as "public" and a
  public one as verified; it now distinguishes `unknown` and warns instead of lying either way.
- **`remapText` had no path boundary**: `D:\dsh` rewrote `D:\dsh-workplace-data`. Rules now only
  match at a boundary. *(`remapping respects path boundaries`)*
- **The secret screen missed JSON credentials** (`"password": "…"`) and skipped files over
  512 KiB. *(`the secret screen understands JSON credentials`)*
- **Rollback reported a clean success while skipping files**; `skipped` is now returned and shown.

### Fixed — configuration and identity

- **The profile was guessed from `DSH_PROFILE` or hard-coded to `web`.** It is now inferred from
  the profile that installs this bundle, can be set explicitly (`data_sync_configure({profile})`),
  and a pull is refused/skipped per-file when the snapshot comes from another profile.
- **`refs` were spliced from an unvalidated branch name**; branch names are validated, and
  `remote set-url --push`, `fetch` and `checkout` return codes are checked instead of ignored.
- **Clearing configuration was impossible** for `repoUrl`/`memoryDir` (empty values were treated
  as "keep the old one").
- **Workspace labels could collide** (two `proj` directories shared one label and one side's
  skills were silently dropped); labels are now made unique, with Unicode preserved.
- **`state.json` writes are still last-writer-wins**, but a torn file is preserved as
  `state.json.corrupt-<timestamp>` instead of being silently replaced.

### Changed

- `init` and `saveConfig` run inside the same exclusive queue as push/pull, so a scheduled push
  cannot see configuration change halfway through its awaits.
- GitHub API calls have timeouts (15–20 s) and git timeouts kill the process tree on Windows
  (`taskkill /T`), so a network black hole no longer parks the whole write queue.
- `status` reports a real `nextAt` (and none without a repository), the remote head commit, and
  warns when a github.com remote has no stored token.
- The Settings page renders `warnings[]` from every call, keeps an edited form across the 60-second
  refresh, shows refresh errors inline, and reports skipped files on rollback.

## 0.2.0 — 2026-10-27

A self-review pass on the first cut. Every item below is a defect that was
reproduced first and is covered by a test that fails on 0.1.0.

### Fixed — data loss and safety

- **A rollback could delete the backup it was restoring from.** `rollbackTo`
  takes a safety backup first, and the rotation prune that follows kept only the
  newest `keepSnapshots` — so with a small rotation the target backup was removed
  milliseconds before it was read, and the restore silently produced an empty
  result. `pruneBackups` now takes protected ids and `rollbackTo` protects its
  target. *(`a rollback never prunes the backup it is restoring from`)*
- **An empty selection could wipe the remote.** With every source disabled (or
  every path missing), a push wrote an empty `files/` tree and committed the
  deletion. A push with zero collected files is now refused with
  `EMPTY_SNAPSHOT`. *(`an empty selection is refused instead of wiping the remote`)*
- **A hand-edited dataset could escape the repository.** `manifest.files[].path`
  was joined straight onto the repository path, so `../../x` read a local file
  outside the clone. Only `files/…` entries without `..` are accepted now, both
  when planning and when reading. *(`a manifest path that escapes the repository
  is refused`)*

### Fixed — correctness

- **Changing the profile wrote into the old profile directory.** `profileDir` is
  derived config, and `mergeSaved` changed `profile` without recomputing it.
  *(`a profile change moves the derived profile directory`)*
- **Remapping could cascade.** Rules were applied one `split/join` at a time, so
  the output of one rule could be rewritten by the next. `remapText` now builds
  one regex, longest key first, and replaces in a single pass.
  *(`remapping is a single pass …`)*
- **A pull whose plan contained no change still took a backup** and reported
  "applied 0 files". It now writes nothing, takes no backup, and says so.
- **`pull` accepted an unknown snapshot schema** with only a warning; it now
  refuses with `MANIFEST_SCHEMA` before touching a single file.
- **A plugin upgrade never refreshed the repository's `bootstrap/` copy**, because
  the no-op push compared only the payload digest. The manifest now records a
  `bootstrapDigest` and the comparison covers both. A no-op push also explains
  itself in its warnings.
- **`--dry-run` push threw on credential findings** instead of reporting them;
  a dry run now returns the findings plus a warning that a real push would be
  refused.
- **An invalid credential value in the repository URL** aborted nothing; it is
  still refused, and the message is unchanged — but the check now runs before the
  clone so no `.git/config` is written with the credential.

### Added

- **Applying an older snapshot from the remote history.** `pull({ commit })`
  resolves the commit, requires it to be an ancestor of the branch head, resets
  the clone to it and applies it with the usual backup. The Settings page lists
  the remote history with an inline-confirmed "apply this version" per commit.
- **Path-rewrite editor in Settings.** The rules travel with the snapshot, so a
  rewrite defined on the old machine keeps working on the new one; the page now
  shows and edits them instead of only applying them.
- **Snapshot file list in the preview**, capped at 60 rows, with per-source sizes.
- **`data_sync_init` and `data_sync_history` tools**, so an agent can connect (or
  create) the private repository and read the remote history without the page.
- **`repoState()`** and the `bootstrapDigest()` fingerprint as small, tested seams.
- **Workspace labels keep non-ASCII names** (`slugify` now keeps Unicode letters),
  so two Chinese-named workspaces no longer collapse into one label.
- **A torn `state.json` is kept**, as `state.json.corrupt-<timestamp>`, instead of
  being silently replaced — it is the only record of the last push.

### Fixed — UI behaviour

- The 60-second refresh could land mid-push and re-enable every button; it now
  skips while an action holds the page.
- Date formatting followed a locale ref that was never written; it now follows
  the active dictionary.
- Saving or connecting clears a stale preview/plan instead of leaving it on
  screen as if it described the new settings.
- The token field, scope card and workspace rows stay disabled while a refresh or
  an action runs.
- `history` / `backups` failures no longer blank the page.

### Changed

- `init` reports `bootstrapped` truthfully (whether the remote already carries a
  snapshot) instead of always `true`.
- `status` reports the remote head commit, a real `nextAt`, and warns when a
  github.com remote has no stored token.
- Changing the repository URL or branch drops the cached ahead/behind counters,
  which described a repository this machine no longer tracks.
- `git` runs without `GIT_ASKPASS=echo` (a POSIX-ism that fails on Windows) and
  still never prompts: `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`.
