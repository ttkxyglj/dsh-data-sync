/**
 * DSH Data Sync — Client (browser) half.
 *
 * Adds one page to Settings (`settings.section`, id 'data-sync') that talks to
 * the Host `dataSync` Remote namespace mounted through `ctx.remote.$mount`. The
 * two halves must agree on ids, parameter wires and codec type symbols; the
 * contract lives in `docs/remote-api.md`.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-data-sync',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NAME = '@local/dsh-data-sync'
    const NS = 'dataSync'
    const LOCALE_NS = 'data-sync'
    const STYLE_MARK = 'data-plugin="dsh-data-sync"'

    /* ----------------------------------------------------------- locale */

    const en = {
      nav: 'Data Sync',
      title: 'Data Sync',
      subtitle: '{device} · profile {profile}',
      subtitleUnconfigured: 'No repository yet — connect one to start',
      refresh: 'Refresh',
      loading: 'Loading…',
      loadFailed: 'Could not load the sync state: {message}',
      saved: 'Saved',
      working: 'Working…',
      cancel: 'Cancel',
      close: 'Close',
      connectionTitle: 'Repository',
      connectionHint: 'A private git repository carries the snapshot. A token is stored locally and never enters the snapshot.',
      repoUrl: 'Repository URL',
      repoUrlPlaceholder: 'https://github.com/you/DSH-Sync-Data.git',
      branch: 'Branch',
      token: 'Token',
      tokenPlaceholder: 'Stored locally — leave empty to keep it',
      tokenClear: 'Forget the stored token',
      saveConfig: 'Save',
      connect: 'Connect',
      remoteChecked: 'Remote: {ahead} ahead · {behind} behind',
      remoteIdle: 'Remote not checked yet',
      remoteFailed: 'Remote check failed: {message}',
      scopeTitle: 'What travels',
      scopeConfig: 'Configuration and plugin stack',
      scopeConfigHint: 'settings.yaml, the profile patch, package.json and the lockfile — what makes the plugin stack reproducible.',
      scopeMemory: 'Long-term memory',
      scopeMemoryHint: 'memories.json and MEMORY.md from the memory plugin.',
      scopeSkills: 'Skills, presets and instructions',
      scopeSkillsHint: '$DSH_HOME skills and AGENTS.md, plus each workspace’s .dsh/skills tree.',
      memoryDir: 'Memory directory',
      workspaceRoots: 'Workspace roots',
      workspaceRootsHint: 'Skills and AGENTS.md inside these directories travel; git repositories inside them never do.',
      workspacePath: 'Directory path',
      addWorkspace: 'Add workspace',
      remove: 'Remove',
      keepSnapshots: 'Local backups to keep',
      actionsTitle: 'Actions',
      preview: 'Preview',
      push: 'Push now',
      checkRemote: 'Check remote',
      applyPull: 'Apply pull',
      applyConfirm: 'Applying will back up this machine first, then overwrite the listed files. Continue?',
      confirmApply: 'Yes, apply',
      backupNow: 'Back up now',
      previewResult: '{count} files · {size}',
      previewSources: 'config {config} · memory {memory} · skills {skills} · workspace {workspace}',
      warnings: 'Warnings',
      secretFindings: 'Credential-shaped values found — the push is refused until they are gone',
      findingsMore: 'and {count} more',
      planTitle: 'Pull plan',
      planEmpty: 'Nothing to apply: the remote has no snapshot, or the plan is empty.',
      remoteSnapshot: 'Remote snapshot {id}',
      planAdd: '{count} to add',
      planUpdate: '{count} to update',
      planSame: '{count} unchanged',
      mappings: 'Path mappings',
      mappingAuto: 'automatic',
      mappingManual: 'manual',
      mappingEmpty: 'No path rewrite is needed on this machine.',
      skipped: '{count} file(s) will be skipped',
      pushDone: 'Pushed {count} files in {size}',
      pushUpToDate: 'Already up to date — nothing changed',
      pushDryRun: 'Dry run: {count} files would be pushed',
      pullDone: 'Applied {added} new and {updated} updated files (backup {backup})',
      backupDone: 'Backup {id} created ({count} files)',
      notConfigured: 'Connect a repository first.',
      backupsTitle: 'Local backups',
      backupsEmpty: 'No local backup yet.',
      rollback: 'Roll back',
      rollbackConfirm: 'Restore backup {id}? Files created by a later pull are removed again.',
      rollbackDone: 'Restored {count} file(s) from {id}; a safety backup {backup} was taken',
      backupRow: '{when} · {reason} · {count} files · {size}',
      historyTitle: 'Remote history',
      historyEmpty: 'No snapshot has been pushed yet.',
      historyError: 'History unavailable: {message}',
      scheduleTitle: 'Automatic backup',
      scheduleEnable: 'Push a snapshot automatically',
      scheduleHint: 'Runs in the background while this profile is open.',
      interval: 'Every',
      hours: '{count} h',
      nextRun: 'Next run: {when}',
      scheduleError: 'Last automatic backup failed: {message}',
      logTitle: 'Recent log',
      showLog: 'Show log',
      hideLog: 'Hide log',
      device: 'Device',
      dataDir: 'Data directory',
      profile: 'Profile',
      source_config: 'config',
      source_memory: 'memory',
      source_skills: 'skills',
      source_workspace: 'workspace',
      action_add: 'add',
      action_update: 'update',
      action_same: 'unchanged',
    }

    const zh = {
      nav: '数据同步',
      title: '数据同步',
      subtitle: '{device} · 配置档 {profile}',
      subtitleUnconfigured: '还没有连接仓库——先连一个私有仓库',
      refresh: '刷新',
      loading: '加载中…',
      loadFailed: '无法读取同步状态：{message}',
      saved: '已保存',
      working: '执行中…',
      cancel: '取消',
      close: '关闭',
      connectionTitle: '仓库',
      connectionHint: '私有 git 仓库用来存放快照。令牌只存在本机，永远不会进入快照。',
      repoUrl: '仓库地址',
      repoUrlPlaceholder: 'https://github.com/you/DSH-Sync-Data.git',
      branch: '分支',
      token: '令牌',
      tokenPlaceholder: '本机已保存——留空则保持不变',
      tokenClear: '清除已保存的令牌',
      saveConfig: '保存',
      connect: '连接',
      remoteChecked: '远端：领先 {ahead} · 落后 {behind}',
      remoteIdle: '尚未检查远端',
      remoteFailed: '远端检查失败：{message}',
      scopeTitle: '同步内容',
      scopeConfig: '配置与插件栈',
      scopeConfigHint: 'settings.yaml、配置档补丁、package.json 与锁文件——插件栈能否复现全靠它们。',
      scopeMemory: '长期记忆',
      scopeMemoryHint: '记忆插件的 memories.json 与 MEMORY.md。',
      scopeSkills: '技能、预设与指令',
      scopeSkillsHint: '$DSH_HOME 下的技能与 AGENTS.md，以及各工作区 .dsh/skills。',
      memoryDir: '记忆目录',
      workspaceRoots: '工作区根目录',
      workspaceRootsHint: '这些目录里的技能与 AGENTS.md 会随快照走；目录里的 git 仓库内容不会。',
      workspacePath: '目录路径',
      addWorkspace: '添加工作区',
      remove: '删除',
      keepSnapshots: '保留本机备份数',
      actionsTitle: '操作',
      preview: '预览',
      push: '立即推送',
      checkRemote: '检查远端',
      applyPull: '应用拉取',
      applyConfirm: '应用前会先备份本机，然后覆盖列表里的文件。继续吗？',
      confirmApply: '确认应用',
      backupNow: '立即备份',
      previewResult: '共 {count} 个文件 · {size}',
      previewSources: '配置 {config} · 记忆 {memory} · 技能 {skills} · 工作区 {workspace}',
      warnings: '提示',
      secretFindings: '发现疑似凭据，推送会被拒绝，请先清理',
      findingsMore: '另外还有 {count} 处',
      planTitle: '拉取计划',
      planEmpty: '没有可应用的内容：远端还没有快照，或计划为空。',
      remoteSnapshot: '远端快照 {id}',
      planAdd: '新增 {count}',
      planUpdate: '更新 {count}',
      planSame: '不变 {count}',
      mappings: '路径映射',
      mappingAuto: '自动',
      mappingManual: '手动',
      mappingEmpty: '这台机器不需要改写路径。',
      skipped: '{count} 个文件会被跳过',
      pushDone: '已推送 {count} 个文件（{size}）',
      pushUpToDate: '已是最新，没有变化',
      pushDryRun: '预演：将推送 {count} 个文件',
      pullDone: '已应用 {added} 个新文件、{updated} 个更新（备份 {backup}）',
      backupDone: '已创建备份 {id}（{count} 个文件）',
      notConfigured: '请先连接仓库。',
      backupsTitle: '本机备份',
      backupsEmpty: '还没有本机备份。',
      rollback: '回滚',
      rollbackConfirm: '恢复到备份 {id}？之后拉取创建的文件会被删除。',
      rollbackDone: '已从 {id} 恢复 {count} 个文件；已先做安全备份 {backup}',
      backupRow: '{when} · {reason} · {count} 个文件 · {size}',
      historyTitle: '远端历史',
      historyEmpty: '还没有推送过快照。',
      historyError: '历史不可用：{message}',
      scheduleTitle: '自动备份',
      scheduleEnable: '自动推送快照',
      scheduleHint: '这个配置档打开时在后台执行。',
      interval: '间隔',
      hours: '{count} 小时',
      nextRun: '下次执行：{when}',
      scheduleError: '上次自动备份失败：{message}',
      logTitle: '最近日志',
      showLog: '查看日志',
      hideLog: '收起日志',
      device: '设备',
      dataDir: '数据目录',
      profile: '配置档',
      source_config: '配置',
      source_memory: '记忆',
      source_skills: '技能',
      source_workspace: '工作区',
      action_add: '新增',
      action_update: '更新',
      action_same: '不变',
    }

    /** Active locale code, read from the Client locale service when available. */
    function activeLocaleCode(ctx) {
      try {
        if (ctx && ctx.locale && typeof ctx.locale.getSnapshot === 'function') {
          const snapshot = ctx.locale.getSnapshot()
          if (snapshot) {
            const code = snapshot.active || snapshot.locale || snapshot.language
            if (typeof code === 'string' && code !== '') return code
          }
        }
      } catch {
        // fall through to the default
      }
      return 'zh'
    }

    // The shell normally injects a bound `t`. If it does not, fall back to the
    // same dictionaries through `activeDict`, so the page never renders raw keys.
    let activeDict = zh

    function interpolate(text, vars) {
      if (!vars || typeof vars !== 'object') return text
      return String(text).replace(/\{(\w+)\}/g, (match, key) => (vars[key] === undefined || vars[key] === null ? match : String(vars[key])))
    }

    function fallbackTranslate(key, vars) {
      const text = activeDict[key] !== undefined ? activeDict[key] : key
      return interpolate(text, vars)
    }

    function errorMessage(error) {
      if (!error) return 'unknown error'
      return typeof error === 'string' ? error : error.message || String(error)
    }

    function formatBytes(bytes) {
      const value = Number(bytes) || 0
      if (value < 1024) return `${value} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
      return `${(value / 1024 / 1024).toFixed(1)} MiB`
    }

    /* ---------------------------------------------------------- visuals */

    const CSS = `
.dsh-sync-section{display:flex;flex-direction:column;gap:12px;max-width:760px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
.dsh-sync-header{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:8px 16px}
.dsh-sync-heading{display:flex;flex-direction:column;gap:2px;flex:1 1 240px;min-width:0}
.dsh-sync-title{margin:0;font-size:18px;font-weight:600;line-height:26px}
.dsh-sync-subtitle{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsh-sync-card{display:flex;flex-direction:column;gap:10px;box-sizing:border-box;padding:14px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}
.dsh-sync-card-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 12px}
.dsh-sync-card-title{margin:0;font-size:14px;font-weight:500;line-height:22px}
.dsh-sync-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsh-sync-note{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsh-sync-error{margin:0;padding:8px 12px;border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.dsh-sync-success{color:var(--dsw-alias-state-success-primary,#2f9e63)}
.dsh-sync-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.dsh-sync-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.dsh-sync-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px}
.dsh-sync-input{box-sizing:border-box;width:100%;min-height:32px;padding:6px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px}
.dsh-sync-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dsh-sync-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-business-primary) 20%,transparent)}
.dsh-sync-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.dsh-sync-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;height:32px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer;transition:background-color .12s,border-color .12s}
.dsh-sync-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l4)}
.dsh-sync-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
.dsh-sync-btn:disabled{opacity:.5;cursor:not-allowed}
.dsh-sync-btn-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted)}
.dsh-sync-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);border-color:transparent}
.dsh-sync-btn-danger{color:var(--dsw-alias-state-error-primary)}
.dsh-sync-btn-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);border-color:transparent}
.dsh-sync-check{display:inline-flex;align-items:flex-start;gap:8px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;cursor:pointer;user-select:none}
.dsh-sync-check input{margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;flex:0 0 auto}
.dsh-sync-check-text{display:flex;flex-direction:column;gap:1px;min-width:0}
.dsh-sync-check-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px}
.dsh-sync-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.dsh-sync-item{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 12px;box-sizing:border-box;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1)}
.dsh-sync-item-text{display:flex;flex-direction:column;gap:1px;min-width:0;font-size:12px;line-height:18px}
.dsh-sync-item-title{font-weight:500;overflow-wrap:anywhere}
.dsh-sync-item-meta{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.dsh-sync-badge{display:inline-flex;align-items:center;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px}
.dsh-sync-badge[data-kind=add]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 14%,transparent);color:var(--dsw-alias-state-business-primary)}
.dsh-sync-badge[data-kind=update]{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#c98a12) 16%,transparent);color:var(--dsw-alias-state-warning-primary,#c98a12)}
.dsh-sync-table{width:100%;border-collapse:collapse;font-size:12px;line-height:18px}
.dsh-sync-table th{text-align:left;color:var(--dsw-alias-label-tertiary);font-weight:500;padding:2px 6px 2px 0;white-space:nowrap}
.dsh-sync-table td{padding:2px 6px 2px 0;border-top:.5px solid var(--dsw-alias-border-l2);overflow-wrap:anywhere}
.dsh-sync-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.dsh-sync-log{margin:0;padding:8px 10px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:16px;white-space:pre-wrap;max-height:180px;overflow:auto}
.dsh-sync-select{box-sizing:border-box;height:32px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.dsh-sync-inline-confirm{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:8px 10px;border-radius:var(--dsw-radius-md);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#c98a12) 12%,transparent);font-size:12px;line-height:18px}
`

    /* ------------------------------------------------------ remote wiring */

    function strictCodec(symbol) {
      return {
        mode: 'strict',
        typeSymbol: `${NAME}#${symbol}`,
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
        id: `${NAME}#${NS}/${method}`,
        service: NS,
        namespace: NS,
        method,
        invocation: { kind: 'direct' },
        parameters: [{ name: 'request', wire: 'request', source: 'json', codec: codecs[requestSymbol] }],
        result: codecs[resultSymbol],
      }
    }

    const remote = {
      package: NAME,
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

    /* ---------------------------------------------------------------- page */

    function Section(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackTranslate
      const api = props.api

      const [stage, setStage] = React.useState('loading')
      const [status, setStatus] = React.useState(null)
      const [loadError, setLoadError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')

      const [form, setForm] = React.useState({
        repoUrl: '', branch: 'main', token: '', tokenClear: false,
        sources: { config: true, memory: true, skills: true },
        memoryDir: '', workspaceRoots: [], keepSnapshots: 10,
        autoBackup: { enabled: false, intervalHours: 24 },
      })
      const [preview, setPreview] = React.useState(null)
      const [plan, setPlan] = React.useState(null)
      const [confirmApply, setConfirmApply] = React.useState(false)
      const [backups, setBackups] = React.useState(null)
      const [history, setHistory] = React.useState(null)
      const [confirmRollback, setConfirmRollback] = React.useState('')
      const [showLog, setShowLog] = React.useState(false)

      const locale = React.useRef('zh')
      const seq = React.useRef(0)

      const load = React.useCallback(async () => {
        const current = ++seq.current
        setBusy('load')
        try {
          const data = await api.status({})
          if (current !== seq.current) return
          setStatus(data)
          setForm({
            repoUrl: data.repoUrl || '',
            branch: data.branch || 'main',
            token: '',
            tokenClear: false,
            sources: data.sources || { config: true, memory: true, skills: true },
            memoryDir: data.memoryDir || '',
            workspaceRoots: Array.isArray(data.workspaceRoots) ? data.workspaceRoots.slice() : [],
            keepSnapshots: data.keepSnapshots || 10,
            autoBackup: data.autoBackup || { enabled: false, intervalHours: 24 },
          })
          setLoadError('')
          setStage('ready')
          if (data.configured) {
            api.backups().then((rows) => current === seq.current && setBackups(rows)).catch(() => {})
            api.history({ limit: 10 }).then((rows) => current === seq.current && setHistory(rows)).catch(() => {})
          }
        } catch (caught) {
          if (current !== seq.current) return
          setLoadError(errorMessage(caught))
          setStage('failed')
        } finally {
          if (current === seq.current) setBusy('')
        }
      }, [api])

      React.useEffect(() => {
        void load()
      }, [load])

      React.useEffect(() => {
        const timer = setInterval(() => {
          if (document.visibilityState !== 'hidden') void load()
        }, 60000)
        return () => clearInterval(timer)
      }, [load])

      const run = React.useCallback(
        async (key, task, success) => {
          setBusy(key)
          setError('')
          setNotice('')
          try {
            const result = await task()
            if (typeof success === 'function') success(result)
            return result
          } catch (caught) {
            setError(errorMessage(caught))
            return null
          } finally {
            setBusy('')
          }
        },
        [],
      )

      const save = () => run('save', () => api.saveConfig(form), (data) => {
        setStatus(data)
        setNotice(t('saved'))
      })

      const connect = async () => {
        const saved = await run('connect', () => api.saveConfig({ repoUrl: form.repoUrl, branch: form.branch, token: form.token, tokenClear: form.tokenClear }))
        if (!saved) return
        await run('connect', () => api.init({ repoUrl: saved.repoUrl, branch: saved.branch }), (result) => {
          setNotice(`${result.repoUrl} (${result.branch})`)
          void load()
        })
      }

      const doPreview = () => run('preview', () => api.preview(), (data) => setPreview(data))
      const doPush = () => run('push', () => api.push({}), (data) => {
        setNotice(data.upToDate ? t('pushUpToDate') : t('pushDone', { count: data.count, size: formatBytes(data.bytes) }))
        void load()
      })
      const doCheck = () => run('plan', () => api.pullPlan({}), (data) => {
        setPlan(data)
        setConfirmApply(false)
      })
      const doApply = () => run('apply', async () => {
        const result = await api.pull({ apply: true })
        setPlan(null)
        setConfirmApply(false)
        setNotice(t('pullDone', { added: result.added, updated: result.updated, backup: result.backupId }))
        void load()
        return result
      })
      const doBackup = () => run('backup', () => api.backup(), (data) => {
        setNotice(t('backupDone', { id: data.backupId, count: data.count }))
        void load()
      })
      const doRollback = (id) => run(`rollback:${id}`, () => api.rollback({ id }), (data) => {
        setConfirmRollback('')
        setNotice(t('rollbackDone', { count: data.restored, id: data.id, backup: data.backupId }))
        void load()
      })

      const localeTag = () => (String(locale.current).toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN')
      const formatTime = (value) => {
        if (!value) return '—'
        try {
          return new Intl.DateTimeFormat(localeTag(), { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
        } catch {
          return new Date(value).toISOString()
        }
      }

      if (stage === 'loading' && !status) {
        return h('section', { className: 'dsh-sync-section' }, h('p', { className: 'dsh-sync-hint' }, t('loading')))
      }
      if (stage === 'failed' && !status) {
        return h(
          'section',
          { className: 'dsh-sync-section' },
          h('p', { className: 'dsh-sync-error', role: 'alert' }, t('loadFailed', { message: loadError })),
          h('div', { className: 'dsh-sync-actions' }, h('button', { type: 'button', className: 'dsh-sync-btn', onClick: () => void load() }, t('refresh'))),
        )
      }

      const current = status || {}
      const disabled = busy !== ''
      const remoteRow = current.remote
      let remoteText = t('remoteIdle')
      if (remoteRow && remoteRow.error) remoteText = t('remoteFailed', { message: remoteRow.error })
      else if (remoteRow && remoteRow.checkedAt) remoteText = t('remoteChecked', { ahead: remoteRow.ahead, behind: remoteRow.behind })

      const header = h(
        'div',
        { className: 'dsh-sync-header' },
        h(
          'div',
          { className: 'dsh-sync-heading' },
          h('h2', { className: 'dsh-sync-title' }, t('title')),
          h(
            'p',
            { className: 'dsh-sync-subtitle' },
            current.configured
              ? t('subtitle', { device: current.deviceName || '', profile: current.profile || '' })
              : t('subtitleUnconfigured'),
          ),
        ),
        h('div', { className: 'dsh-sync-actions' },
          h('button', { type: 'button', className: 'dsh-sync-btn', disabled, onClick: () => void load() }, t('refresh')),
        ),
      )

      const messageRow = h(
        React.Fragment,
        null,
        error ? h('p', { className: 'dsh-sync-error', role: 'alert' }, error) : null,
        notice ? h('p', { className: 'dsh-sync-note dsh-sync-success', role: 'status' }, notice) : null,
      )

      /* ---------------------------------------------------------- cards */

      const connectionCard = h(
        'section',
        { className: 'dsh-sync-card' },
        h('div', { className: 'dsh-sync-card-head' },
          h('h3', { className: 'dsh-sync-card-title' }, t('connectionTitle')),
          h('span', { className: 'dsh-sync-hint' }, remoteText),
        ),
        h('p', { className: 'dsh-sync-hint' }, t('connectionHint')),
        h('div', { className: 'dsh-sync-grid' },
          h('label', { className: 'dsh-sync-field' },
            h('span', { className: 'dsh-sync-label' }, t('repoUrl')),
            h('input', {
              className: 'dsh-sync-input',
              type: 'url',
              value: form.repoUrl,
              placeholder: t('repoUrlPlaceholder'),
              disabled,
              onChange: (event) => setForm({ ...form, repoUrl: event.target.value }),
            }),
          ),
          h('label', { className: 'dsh-sync-field' },
            h('span', { className: 'dsh-sync-label' }, t('branch')),
            h('input', {
              className: 'dsh-sync-input',
              type: 'text',
              value: form.branch,
              disabled,
              onChange: (event) => setForm({ ...form, branch: event.target.value }),
            }),
          ),
          h('label', { className: 'dsh-sync-field' },
            h('span', { className: 'dsh-sync-label' }, t('token')),
            h('input', {
              className: 'dsh-sync-input',
              type: 'password',
              value: form.token,
              placeholder: current.tokenPresent ? t('tokenPlaceholder') : '',
              disabled,
              autoComplete: 'off',
              onChange: (event) => setForm({ ...form, token: event.target.value }),
            }),
          ),
        ),
        h('label', { className: 'dsh-sync-check' },
          h('input', {
            type: 'checkbox',
            checked: form.tokenClear,
            disabled,
            onChange: (event) => setForm({ ...form, tokenClear: event.target.checked }),
          }),
          h('span', null, t('tokenClear')),
        ),
        h('div', { className: 'dsh-sync-actions' },
          h('button', { type: 'button', className: 'dsh-sync-btn', disabled, onClick: () => void save() }, t('saveConfig')),
          h('button', { type: 'button', className: 'dsh-sync-btn dsh-sync-btn-primary', disabled: disabled || form.repoUrl.trim() === '', onClick: () => void connect() }, t('connect')),
        ),
      )

      const scopeRow = (key, labelKey, hintKey) =>
        h('label', { className: 'dsh-sync-check', key },
          h('input', {
            type: 'checkbox',
            checked: Boolean(form.sources && form.sources[key]),
            disabled,
            onChange: (event) => setForm({ ...form, sources: { ...form.sources, [key]: event.target.checked } }),
          }),
          h('span', { className: 'dsh-sync-check-text' },
            h('span', null, t(labelKey)),
            h('span', { className: 'dsh-sync-check-hint' }, t(hintKey)),
          ),
        )

      const workspaceRows = Array.isArray(form.workspaceRoots) ? form.workspaceRoots : []
      const scopeCard = h(
        'section',
        { className: 'dsh-sync-card' },
        h('h3', { className: 'dsh-sync-card-title' }, t('scopeTitle')),
        scopeRow('config', 'scopeConfig', 'scopeConfigHint'),
        scopeRow('memory', 'scopeMemory', 'scopeMemoryHint'),
        scopeRow('skills', 'scopeSkills', 'scopeSkillsHint'),
        h('label', { className: 'dsh-sync-field' },
          h('span', { className: 'dsh-sync-label' }, t('memoryDir')),
          h('input', {
            className: 'dsh-sync-input',
            type: 'text',
            value: form.memoryDir,
            disabled,
            onChange: (event) => setForm({ ...form, memoryDir: event.target.value }),
          }),
        ),
        h('div', { className: 'dsh-sync-field' },
          h('span', { className: 'dsh-sync-label' }, t('workspaceRoots')),
          h('p', { className: 'dsh-sync-hint' }, t('workspaceRootsHint')),
          workspaceRows.length > 0
            ? h('ul', { className: 'dsh-sync-list' }, workspaceRows.map((row, index) =>
                h('li', { className: 'dsh-sync-item', key: `${row.path}-${index}` },
                  h('span', { className: 'dsh-sync-item-text' },
                    h('span', { className: 'dsh-sync-item-title' }, row.label || row.path),
                    h('span', { className: 'dsh-sync-item-meta' }, row.path),
                  ),
                  h('button', {
                    type: 'button',
                    className: 'dsh-sync-btn dsh-sync-btn-danger',
                    disabled,
                    onClick: () => setForm({ ...form, workspaceRoots: workspaceRows.filter((_row, at) => at !== index) }),
                  }, t('remove')),
                ),
              ))
            : null,
          h('div', { className: 'dsh-sync-actions' },
            h('input', {
              className: 'dsh-sync-input',
              type: 'text',
              value: form.newWorkspace || '',
              placeholder: t('workspacePath'),
              disabled,
              onChange: (event) => setForm({ ...form, newWorkspace: event.target.value }),
            }),
            h('button', {
              type: 'button',
              className: 'dsh-sync-btn',
              disabled: disabled || !(form.newWorkspace || '').trim(),
              onClick: () => {
                const value = (form.newWorkspace || '').trim()
                const label = value.split(/[\\/]/).filter(Boolean).slice(-1)[0] || value
                setForm({ ...form, workspaceRoots: [...workspaceRows, { label, path: value }], newWorkspace: '' })
              },
            }, t('addWorkspace')),
          ),
        ),
        h('label', { className: 'dsh-sync-field' },
          h('span', { className: 'dsh-sync-label' }, t('keepSnapshots')),
          h('input', {
            className: 'dsh-sync-input',
            type: 'number',
            min: 1,
            max: 99,
            value: form.keepSnapshots,
            disabled,
            onChange: (event) => setForm({ ...form, keepSnapshots: Number(event.target.value) || 10 }),
          }),
        ),
      )

      const previewBlock = preview
        ? h('div', { className: 'dsh-sync-field' },
            h('p', { className: 'dsh-sync-note' }, t('previewResult', { count: preview.count, size: formatBytes(preview.bytes) })),
            h('p', { className: 'dsh-sync-hint' }, t('previewSources', {
              config: preview.bySource.config || 0,
              memory: preview.bySource.memory || 0,
              skills: preview.bySource.skills || 0,
              workspace: preview.bySource.workspace || 0,
            })),
            preview.secretFindings && preview.secretFindings.length > 0
              ? h('p', { className: 'dsh-sync-error' }, `${t('secretFindings')}: ${preview.secretFindings.slice(0, 3).map((row) => `${row.path}:${row.line}`).join(', ')}${preview.secretFindings.length > 3 ? ` (${t('findingsMore', { count: preview.secretFindings.length - 3 })})` : ''}`)
              : null,
            preview.warnings && preview.warnings.length > 0
              ? h('ul', { className: 'dsh-sync-list' }, preview.warnings.slice(0, 8).map((row, index) =>
                  h('li', { className: 'dsh-sync-item', key: index }, h('span', { className: 'dsh-sync-item-text' }, h('span', { className: 'dsh-sync-item-meta' }, row))),
                ))
              : null,
          )
        : null

      const planCounts = plan
        ? plan.actions.reduce((acc, row) => ({ ...acc, [row.action]: (acc[row.action] || 0) + 1 }), {})
        : {}
      const planBlock = plan
        ? h('div', { className: 'dsh-sync-field' },
            h('p', { className: 'dsh-sync-note' }, plan.remoteSnapshotId ? t('remoteSnapshot', { id: plan.remoteSnapshotId }) : t('planEmpty')),
            plan.actions.length > 0
              ? h('p', { className: 'dsh-sync-hint' }, `${t('planAdd', { count: planCounts.add || 0 })} · ${t('planUpdate', { count: planCounts.update || 0 })} · ${t('planSame', { count: planCounts.same || 0 })}`)
              : null,
            plan.skipped && plan.skipped.length > 0 ? h('p', { className: 'dsh-sync-hint' }, t('skipped', { count: plan.skipped.length })) : null,
            plan.mappings && plan.mappings.length > 0
              ? h('div', { className: 'dsh-sync-field' },
                  h('span', { className: 'dsh-sync-label' }, t('mappings')),
                  h('table', { className: 'dsh-sync-table' },
                    h('thead', null, h('tr', null,
                      h('th', null, 'from'),
                      h('th', null, 'to'),
                      h('th', null, ''),
                    )),
                    h('tbody', null, plan.mappings.map((row, index) =>
                      h('tr', { key: index },
                        h('td', null, row.from),
                        h('td', null, row.to),
                        h('td', null, h('span', { className: 'dsh-sync-badge' }, row.auto ? t('mappingAuto') : t('mappingManual'))),
                      ),
                    )),
                  ),
                )
              : h('p', { className: 'dsh-sync-hint' }, t('mappingEmpty')),
            plan.actions.length > 0
              ? (confirmApply
                  ? h('div', { className: 'dsh-sync-inline-confirm' },
                      h('span', null, t('applyConfirm')),
                      h('button', { type: 'button', className: 'dsh-sync-btn dsh-sync-btn-danger', disabled, onClick: () => void doApply() }, t('confirmApply')),
                      h('button', { type: 'button', className: 'dsh-sync-btn', disabled, onClick: () => setConfirmApply(false) }, t('cancel')),
                    )
                  : h('div', { className: 'dsh-sync-actions' },
                      h('button', { type: 'button', className: 'dsh-sync-btn dsh-sync-btn-primary', disabled, onClick: () => setConfirmApply(true) }, t('applyPull')),
                    ))
              : null,
          )
        : null

      const actionsCard = h(
        'section',
        { className: 'dsh-sync-card' },
        h('h3', { className: 'dsh-sync-card-title' }, t('actionsTitle')),
        current.configured
          ? null
          : h('p', { className: 'dsh-sync-hint' }, t('notConfigured')),
        h('div', { className: 'dsh-sync-actions' },
          h('button', { type: 'button', className: 'dsh-sync-btn', disabled, onClick: () => void doPreview() }, t('preview')),
          h('button', { type: 'button', className: 'dsh-sync-btn dsh-sync-btn-primary', disabled: disabled || !current.configured, onClick: () => void doPush() }, t('push')),
          h('button', { type: 'button', className: 'dsh-sync-btn', disabled: disabled || !current.configured, onClick: () => void doCheck() }, t('checkRemote')),
          h('button', { type: 'button', className: 'dsh-sync-btn', disabled, onClick: () => void doBackup() }, t('backupNow')),
        ),
        previewBlock,
        planBlock,
      )

      const backupRows = backups && Array.isArray(backups.backups) ? backups.backups : []
      const backupsCard = h(
        'section',
        { className: 'dsh-sync-card' },
        h('h3', { className: 'dsh-sync-card-title' }, t('backupsTitle')),
        backupRows.length === 0
          ? h('p', { className: 'dsh-sync-hint' }, t('backupsEmpty'))
          : h('ul', { className: 'dsh-sync-list' }, backupRows.map((row) =>
              h('li', { className: 'dsh-sync-item', key: row.id },
                h('span', { className: 'dsh-sync-item-text' },
                  h('span', { className: 'dsh-sync-item-title' }, t('backupRow', {
                    when: formatTime(row.at),
                    reason: row.reason,
                    count: row.count,
                    size: formatBytes(row.bytes),
                  })),
                  h('span', { className: 'dsh-sync-item-meta' }, row.id),
                ),
                confirmRollback === row.id
                  ? h('span', { className: 'dsh-sync-row' },
                      h('span', { className: 'dsh-sync-hint' }, t('rollbackConfirm', { id: row.id })),
                      h('button', { type: 'button', className: 'dsh-sync-btn dsh-sync-btn-danger', disabled, onClick: () => void doRollback(row.id) }, t('rollback')),
                      h('button', { type: 'button', className: 'dsh-sync-btn', disabled, onClick: () => setConfirmRollback('') }, t('cancel')),
                    )
                  : h('button', { type: 'button', className: 'dsh-sync-btn', disabled, onClick: () => setConfirmRollback(row.id) }, t('rollback')),
              ),
            )),
      )

      const historyRows = history && Array.isArray(history.commits) ? history.commits : []
      const historyCard = h(
        'section',
        { className: 'dsh-sync-card' },
        h('h3', { className: 'dsh-sync-card-title' }, t('historyTitle')),
        history && history.error ? h('p', { className: 'dsh-sync-hint' }, t('historyError', { message: history.error })) : null,
        historyRows.length === 0
          ? h('p', { className: 'dsh-sync-hint' }, t('historyEmpty'))
          : h('ul', { className: 'dsh-sync-list' }, historyRows.map((row) =>
              h('li', { className: 'dsh-sync-item', key: row.hash },
                h('span', { className: 'dsh-sync-item-text' },
                  h('span', { className: 'dsh-sync-item-title' }, row.message),
                  h('span', { className: 'dsh-sync-item-meta' }, `${formatTime(row.date)} · ${row.hash.slice(0, 8)}`),
                ),
                row.snapshotId ? h('span', { className: 'dsh-sync-badge' }, row.snapshotId) : null,
              ),
            )),
      )

      const scheduleCard = h(
        'section',
        { className: 'dsh-sync-card' },
        h('h3', { className: 'dsh-sync-card-title' }, t('scheduleTitle')),
        h('p', { className: 'dsh-sync-hint' }, t('scheduleHint')),
        h('label', { className: 'dsh-sync-check' },
          h('input', {
            type: 'checkbox',
            checked: Boolean(form.autoBackup && form.autoBackup.enabled),
            disabled,
            onChange: (event) => setForm({ ...form, autoBackup: { ...form.autoBackup, enabled: event.target.checked } }),
          }),
          h('span', null, t('scheduleEnable')),
        ),
        h('label', { className: 'dsh-sync-field' },
          h('span', { className: 'dsh-sync-label' }, t('interval')),
          h('select', {
            className: 'dsh-sync-select',
            value: form.autoBackup && form.autoBackup.intervalHours ? form.autoBackup.intervalHours : 24,
            disabled,
            onChange: (event) => setForm({ ...form, autoBackup: { ...form.autoBackup, intervalHours: Number(event.target.value) } }),
          }, [1, 6, 12, 24, 168].map((hours) => h('option', { key: hours, value: hours }, t('hours', { count: hours })))),
        ),
        current.autoBackup && current.autoBackup.nextAt
          ? h('p', { className: 'dsh-sync-hint' }, t('nextRun', { when: formatTime(current.autoBackup.nextAt) }))
          : null,
        current.autoBackup && current.autoBackup.lastError
          ? h('p', { className: 'dsh-sync-error' }, t('scheduleError', { message: current.autoBackup.lastError }))
          : null,
        h('div', { className: 'dsh-sync-actions' },
          h('button', { type: 'button', className: 'dsh-sync-btn dsh-sync-btn-primary', disabled, onClick: () => void save() }, t('saveConfig')),
        ),
      )

      const logCard = h(
        'section',
        { className: 'dsh-sync-card' },
        h('div', { className: 'dsh-sync-card-head' },
          h('h3', { className: 'dsh-sync-card-title' }, t('logTitle')),
          h('button', { type: 'button', className: 'dsh-sync-btn', onClick: () => setShowLog(!showLog) }, showLog ? t('hideLog') : t('showLog')),
        ),
        h('p', { className: 'dsh-sync-hint' }, `${t('device')}: ${current.deviceName || '—'} · ${t('dataDir')}: ${current.dataDir || '—'}`),
        showLog ? h('pre', { className: 'dsh-sync-log' }, (current.logTail || []).join('\n') || '—') : null,
      )

      return h(
        'section',
        { className: 'dsh-sync-section', 'data-plugin': 'dsh-data-sync' },
        header,
        messageRow,
        connectionCard,
        scopeCard,
        actionsCard,
        backupsCard,
        historyCard,
        scheduleCard,
        logCard,
      )
    }

    /* --------------------------------------------------------------- apply */

    return {
      inject: ['slots', 'locale', 'remote'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(LOCALE_NS, { en, zh }), 'data-sync: dictionaries')

        const mounted = ctx.remote.$mount(remote)
        ctx.effect(async () => {
          await mounted
        })

        let remoteNamespace
        let resolveNamespace
        const namespaceReady = new Promise((resolve) => {
          resolveNamespace = resolve
        })
        ctx.inject([`remote.${NS}`], (ready) => {
          remoteNamespace = ready.remote[NS]
          resolveNamespace(remoteNamespace)
          return () => {
            remoteNamespace = undefined
          }
        })

        async function acquireNamespace() {
          await mounted
          let namespace = remoteNamespace
          if (!namespace && typeof ctx.get === 'function') {
            try {
              namespace = ctx.get(`remote.${NS}`)
            } catch {
              namespace = undefined
            }
          }
          if (!namespace) {
            await Promise.race([
              namespaceReady,
              new Promise((_resolve, reject) => {
                setTimeout(() => reject(new Error(`Host remote "remote.${NS}" did not mount within 8s`)), 8000)
              }),
            ])
            namespace = remoteNamespace
          }
          if (!namespace) throw new Error(`Host remote "remote.${NS}" is not mounted`)
          return namespace
        }

        async function callRemote(method, request) {
          const namespace = await acquireNamespace()
          const invoke = namespace[method]
          if (typeof invoke !== 'function') throw new Error(`Host remote has no method "${method}"`)
          const result = await invoke(request && typeof request === 'object' ? request : {})
          if (result && typeof result === 'object' && 'ok' in result) {
            if (result.ok === true) return result.value
            const failure = result.error
            const error = new Error((failure && (failure.message || failure.code)) || 'Remote call failed')
            error.code = failure && failure.code
            throw error
          }
          return result
        }

        const api = {
          status: (request) => callRemote('status', request || {}),
          saveConfig: (request) => callRemote('saveConfig', request || {}),
          preview: () => callRemote('preview', {}),
          push: (request) => callRemote('push', request || {}),
          pullPlan: (request) => callRemote('pullPlan', request || {}),
          pull: (request) => callRemote('pull', request || {}),
          backup: () => callRemote('backup', {}),
          backups: () => callRemote('backups', {}),
          rollback: (request) => callRemote('rollback', request || {}),
          history: (request) => callRemote('history', request || {}),
          init: (request) => callRemote('init', request || {}),
        }

        ctx.effect(() => {
          const existing = document.querySelector(`style[${STYLE_MARK}]`)
          if (existing) return () => {}
          const style = document.createElement('style')
          style.setAttribute('data-plugin', 'dsh-data-sync')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => {
            style.remove()
          }
        }, 'data-sync: styles')

        const navLabel = () => {
          const english = /^en/i.test(String(activeLocaleCode(ctx)))
          activeDict = english ? en : zh
          return english ? en.nav : zh.nav
        }

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'data-sync',
              order: 26,
              label: navLabel,
              locale: LOCALE_NS,
              inject: () => ({ api }),
            },
            Section,
          ),
        )
      },
    }
  },
})
