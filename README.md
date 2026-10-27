# DSH Data Sync · 数据同步

换新电脑时，把整台 DeepSeek Harness 的**配置、插件栈、长期记忆与技能**打包成一版快照，推进你自己的**私有 git 仓库**；
在新机器上装回这个插件、拉取快照，插件会把旧机器记录的绝对路径自动改写到新机器，并在覆盖前先做本机备份。

```
旧机器                                    私有仓库                         新机器
$DSH_HOME + 记忆库 + 技能  ──push──►  manifest.json + files/  ──pull──►  路径重映射 → 写入 → 本机备份
```

不做「同步文件夹」：只同步一张**有限白名单**，git 负责历史与回滚，凭据永远不进去。

---

## 1. 它同步什么

全部按来源白名单收集，**deny-list 先于任何遍历**：

| 来源 | 内容 |
|---|---|
| `config` | `$DSH_HOME/settings.yaml`、`AGENTS.md`、根 `cordis.patch.yml`；配置档的 `package.json`、`cordis.patch.yml`、`cordis.yml`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`.dsh-market/state.json` |
| `memory` | 记忆库目录下的 `memories.json`、`MEMORY.md`（目录自动从记忆插件配置里读出） |
| `skills` | `$DSH_HOME/skills/**`、`.agent-presets/**`、`agents/**`；每个已登记工作区的 `.dsh/skills`、`.dsh/agents`、`.dsh/agent-presets`、`.dsh/commands` 与 `AGENTS.md` |

**永不进入快照**：`.credentials.yaml`、`.env*`、`*.pem` / `*.key`、`id_rsa*`、`secrets/`、`node_modules/`、`.git/`、`*.log`、`*.sqlite*`、
超过 4 MiB 的单文件、以及任何被识别为凭据形态的文本（推送前会扫描并拒绝）。

## 2. 三个机制

**快照 = 一版目录树**：`manifest.json` 记录每个文件的来源、相对路径、sha256 与大小；
`files/config|memory|skills|workspace/…` 是逐字节副本；`bootstrap/dsh-data-sync/` 是本插件自己的源码，
新机器可以直接从这个仓库安装插件（解决「先有鸡还是先有蛋」）。

**推送是幂等的**：内容指纹和插件指纹都没变时第二次推送不产生新提交，定时备份不会刷出一堆空历史；
空选择（所有来源都关掉或路径都不存在）会被拒绝，不会把远端清空。

**记忆目录 = 记忆插件的存储目录本身**：它就是长期记忆插件 `storageDir` 指向的地方（`memories.json` + `MEMORY.md`），
不是第二份副本。插件从已安装的记忆插件 bundle patch / profile patch / 主目录 patch / `DSH_MEMORY_DIR` 探测；
已经保存过一个不存在的路径（例如旧的 `$DSH_HOME/storages/memory`）时，会改用探测到的真实目录；输入框**留空 = 重新探测**。

**拉取先备份再写**：`pull` 先按**本次要写的每个文件**逐个做本机备份（保留最近 N 份，可一键回滚），再逐文件写入；
被跳过的文件（工作区没登记、目标越界、属于别的 profile、清单路径/校验和不符、远端载荷读不出）逐条报告，不静默丢弃。
写入中途失败会自动用刚才的备份回滚，并把备份 id 告诉调用方。计划里没有任何变化时既不写文件也不做备份。

**远端历史可回退，也自动瘦身**：远端每个提交都是一版快照。
`pull` 不带 `commit` = 恢复**最新那一版**（比如今天推的）；在历史列表里点「应用此版本」= 恢复某一天的版本。
推送成功后，超过**保留天数**（默认 3 天）的旧版本会从远端分支历史里删掉，以控制仓库体积；
**最新那一版永远保留**，即使它本身已经超过天数。清理是重写历史 + `--force-with-lease` 强推：
被分支保护或别的机器抢先推送挡住时会整体放弃并回滚本地分支，不会删掉任何东西。

## 3. 路径重映射

快照里记录了旧机器的 `dshHome`、配置档目录、记忆目录、工作区路径，以及当时定义的**改写规则**。
拉取时按「长前缀优先」应用：

- 自动：旧 `dshHome` → 本机 `dshHome`；旧记忆目录 → 本机记忆目录；同名工作区 → 本机对应目录
- 手动：设置页里可以加任意 `D:\work` → `E:\work`；旧机器上定义的规则会随快照一起过来，新机器不用重打一遍

文本文件按原样改写，同时处理 `\`、`/` 与 JSON 里的 `\\` 三种写法，所以
`package.json` 的 `link:` 依赖、`cordis.patch.yml` 的 `storageDir`、`memories.json` 里项目键的绝对路径都能对上。

## 4. 用起来

### 4.1 旧机器（离开前）

1. **设置 → 数据同步**：填私有仓库地址（`https://github.com/you/DSH-Sync-Data.git`）与带 `repo` 权限的令牌，点**连接**。
   - 也可以先手动在 GitHub 建一个 **private** 空仓库；插件会在之后校验它确实是私有的，公开仓库直接拒绝推送。
   - 令牌只写进 `$DSH_HOME/dsh-data-sync/credentials.json`，不进快照、不进日志；仓库地址里带 `user:token@` 会被拒绝。
2. **同步内容**：勾选配置 / 记忆 / 技能，补上记忆目录与工作区根目录，保存。
3. 点**预览**确认清单与体积（可展开看具体文件）；点**立即推送**。
4. 想省事就打开**自动备份**（1 / 6 / 12 / 24 / 168 小时）。
5. 换机路径不是「主目录/记忆目录」这种自动规则能覆盖的（盘符、用户名、挂载点），在**路径改写**卡片里补一行，
   规则会随快照一起走。

### 4.2 新机器（恢复）

```bash
git clone https://github.com/you/DSH-Sync-Data.git dsh-sync-data
dsh plugin --profile desktop add ./dsh-sync-data/bootstrap/dsh-data-sync
```

重启 Harness → **设置 → 数据同步** → 填同一个仓库与令牌 → **连接** → **检查远端** 看计划与映射 → **应用拉取** → 重启 Harness。
默认「应用拉取」恢复的就是**最新一版**（今天推的那版）；想恢复昨天/前天的版本，在**备份与历史**卡片里找到对应提交，
点「应用此版本」——同样先备份本机。
插件栈由 `cd ~/.dsh/profiles/desktop && pnpm install` 重建（`pnpm-lock.yaml` 已经跟着过来了）。
仓库根目录的 `BOOTSTRAP.md` 由每次推送自动重写，包含同一套步骤。

## 5. Agent 工具

| 工具 | 作用 |
|---|---|
| `data_sync_status` | 读状态：仓库、来源、上次推送/拉取/备份、远端 ahead/behind、日志尾部 |
| `data_sync_configure` | 改配置：仓库、分支、profile、令牌、来源、记忆目录、工作区、路径改写、保留份数、定时备份、远端保留天数 |
| `data_sync_init` | 连接仓库（可选用令牌直接新建一个**私有**仓库并克隆） |
| `data_sync_push` | 收集并推送一版快照（成功后按保留天数清理旧版本）；`dryRun: true` 只看不发 |
| `data_sync_pull` | `apply: false`（默认）只出计划；`apply: true` 先备份再写入**最新一版**；传 `commit` 恢复指定版本 |
| `data_sync_history` | 列出远端历史快照（提交、时间、说明、快照 id） |
| `data_sync_backup` | 只做本机备份，不碰远端 |
| `data_sync_rollback` | 恢复到某个本机备份（会先做一次安全备份） |

## 6. 边界（有意为之）

- **凭据不同步**：新机器用 `dsh auth` 或手写 `.credentials.yaml` 重新登录；这是设计，不是遗漏。
- **工作区里的 git 仓库不复制**：只带 `.dsh/skills` 这类配置，代码仓库继续用 `git clone`。
- **`pnpm install` 不是同步的一步**：版本由锁文件钉住，但装不装是这台机器的决定。
- **远端历史会按保留天数重写**：默认保留 3 天、最新一版永不删除；如果你更想保留完整历史，把「保留天数」调大或关掉这个开关。
  重写历史意味着旧提交的 hash 会变，其它机器下次拉取会自动对齐（本插件每次拉取都 `reset --hard` 到远端）。
- **恢复旧版本后不会再自动「回到最新」**：应用某一版旧快照后，本机内容就是那一版；再推送会把这一版落成新的远端提交。需要最新版时重新「检查远端 → 应用拉取」。

## 7. 目录

```
$DSH_HOME/dsh-data-sync/
├── config.json        设置页保存的配置（profile 补丁只放默认值）
├── credentials.json   令牌（唯一含凭据的文件）
├── state.json         本机状态：上次推送/拉取/备份、远端计数
├── sync.log           运行日志（状态页可看尾部）
├── repo/              私有仓库的本地克隆
└── backups/<id>/      本机备份轮转（默认保留 10 份，含 backup.json）
```

## 8. 开发

```powershell
# 语法与测试（用 DSH 自带 Node 即可）
node --check plugin/index.js
node --test test/core.test.mjs test/host.test.mjs
```

测试不联网：round-trip 用本地裸仓库跑「推送 → 克隆 → 重映射 → 拉取 → 回滚」，
host 测试用一个假 Cordis 上下文跑真实 `apply()`，验证 11 个 Remote 方法、6 个工具与服务行为。

## 9. License

MIT
