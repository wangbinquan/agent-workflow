# RFC-370 当前状态

> 唯一的进度记录。设计见 [v2 重设计](./redesign-v2-20261014.md)，其中 §9 是 2026-10-16 接手审视与 v3 修订（取代 §5.2 及旧 status 中与之冲突的实现细节）；v2 M2/M3 在制品的旧记录逐字归档在 [status-archive-m2m3-20261016.md](./status-archive-m2m3-20261016.md)；本目录其余文档是 v1 历史。

| 步骤                           | 状态                                            | 证据                                                                                                                                                                                                                                             |
| ------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P1 单机统一                    | Done                                            | 见下方「P1」                                                                                                                                                                                                                                     |
| M0 控制面上线                  | Done                                            | 见下方「M0」                                                                                                                                                                                                                                     |
| v3 修订实现（§9.2 V1～V13）    | Done                                            | 实现与集中验证见下方「v3 修订实施」；行为由 M1～M3 托管实机验收证实                                                                                                                                                                              |
| v4 补齐（§10 V14～V21）        | Done                                            | V14～V21 与验收中发现的 F1～F14 均已修复并在托管实机上验证：最后一批 `99ef0dd91`（F10～F12）、`8e5c57a21`（F14）发布为正式 AW `v0.6.30` 与 rfc042 `v0.2.9`；CS F9b `3c1ffee0`、F13 `8d2f3ce3` 已部署。证据见下方「v0.6.25」～「v0.6.30 托管实机验收与收口」 |
| M1 远程执行闭环                | Done                                            | 代表性工作流在 CS 上通过并与单机一致、取消通过；服务交接（重启后恢复）、接管（无需用户操作）与回退演练（v0.6.22 → v0.6.19 → v0.6.23）均通过（见「2026-10-17 托管实机验收」）                                                                     |
| M2 能力等价                    | Done                                            | 材料（托管技能 / 远程 MCP / 跨模型子 Agent；本地 MCP / Git 插件 / 权限）、控制流（与单机一致）、调用子工作流 / 工作组、系统 Agent（意图、MCP 运行时测试、运行时探测、MCP 探测）、内容对象（文本 / 二进制端口产物逐字节一致）、工具调用显示均通过 |
| M3 事件与运维                  | Done                                            | 事件入站、任务删除释放卷、API 自动化、记忆蒸馏、平台恢复动作 `resume-task` / `rebuild-workspace` 通过；数据库恢复（CS RFC-042）在独立服务上第二次尝试通过（见「2026-10-17 托管实机验收」M3）                                                     |
| CS RFC-040 / 042 / 043（附属） | RFC-040 Done；RFC-042 Done；RFC-043 Done        | RFC-040：CS `3ef2c90e` 收口；RFC-042：独立服务恢复第二次尝试通过，CS `ebe836f4` 关闭；RFC-043：用户 2026-10-19 立项并批准，CS `660a6185` 实现，RIU-07 与正式 AW `v0.6.25` 联合验收通过，`54bbea25` 关闭；联合验收中的 CS 修复 `563322f8`、`54bbea25`、`4c735036` 均已部署 |

## 2026-10-16 v3 修订实施（接手）

用户 2026-10-16 明令接手 RFC-370，统一审视 RFC-370 与 CS RFC-040 / 042，自主重设计并完整实现；免 Codex 门，允许提交推送。审视结论与裁定见 redesign §9。按裁定完成的实现：

- **V1 执行生命周期**（task-execution `infrastructure/crewstation/execution.ts` 等）：优雅关闭与失权一律 detach，不发 CS cancel；只有用户取消与节点超时发 cancel 并等 CS 结果收敛，ACK 被拒也取消远程执行。启动恢复不再等远程结果：节点绑定的运行按原 ID 交还调度器接管（`compile()` 命中原绑定即 adopt），其余绑定由后台结算器处理（并发上限 8，单个绑定不阻塞其他）。`gap` 记截断继续读，410 `cursor_expired` 才判 unknown（节点以明确原因失败、绑定结算为 abandoned，可正常重试）；持有执行权期间平台 5xx / 网络错误无限退避重连（上限 30 秒）。usage 写入 tokens；每个事件同一事务落 journal 与游标后再投影。
- **V2 命令通道**（source-control `infrastructure/crewstation/workspaceCommands.ts`，平台中立循环 `platform/crewstation/subtaskStream.ts`）：卷内非节点命令的日志 `hosted_workspace_commands` 归 Source Control（`submitting → running → settled`，失主未回执记 `abandoned`）；助手把结果原子写入卷内结果文件，控制面经 CS 文件 API 读回并原样还原原生错误；参数总量上限 1.5 MiB、卷写入分块 768 KiB；operationId 只在一次逻辑尝试内复用；只读查询不落日志。
- **V3 工作区**：AW 任务离开运行态即暂停 CS 父任务、继续前恢复，删除时关闭；对账器补齐失回执，`close` 在 CS 受理后才落 closing。候选、员工 Case、开发场景与发布改为卷内粗粒度命令（原生实现在卷内运行）；托管 GC 只删工作树目录；仓库准备在卷内复用 `gitRepoCache` 原语。托管发布、候选推送与 Case 远端读取在任务卷内用部署级 Git 凭据执行（能力影响 C13）。容器 / 卷不可用时节点以明确原因失败并提示可由平台重建后续跑。
- **V4 平台恢复请求**：只声明父任务级 `resume-task` / `rebuild-workspace`；信封宽松解析；删除 `hosted-recovery-required` 门控与界面隐藏，托管下续跑 / 重试与单机一致。消费器日志 `admitted → executing → succeeded | failed | rejected`，以请求人关联的 AW 账号调用原「续跑任务」命令，瞬时错误在 2 小时内顺延；删除旧恢复检查点、保留卷、hold 等全部机制。
- **V5 备份与恢复**（system-operations）：托管备份复用单机 PostgreSQL 逻辑备份格式，归档存 CS 对象，对象按释放水位保留；托管不捕获工作树（C10，`includeWorktrees` 明确拒绝）。恢复由 CS RFC-042 的空目标与 `CS_DATABASE_RESTORE_REFERENCE` 驱动 `agent-workflow migrate`：下载校验 → 单机 PG 导入 → 各 owner 恢复后归一（非终态任务 `auto_recovery_suspended`，未结算执行绑定按 `restored` 取消结算，进行中的恢复请求以失败结束）→ 校验回执。删除 `AW_RESTORE_OBJECT` 与恢复保留 / 检查卷 / 工作卷捕获。
- **V6 内容对象**：一套中立发布日志 `hosted_object_publications`（`pending → ready → releasing → released`）由 system-operations 提供，各 owner 在自己的事务里登记与保留引用；源字节 ready 后清除；任务删除 / 归档释放产物；完成行按保留期清理；未结算发布不阻塞备份。取代六套 owner 日志。
- **V7 执行权与迁移就绪**：删除逐写 schema digest 校验，托管 verify 接受只增的较新 schema；排他写窗口锁只在冻结 / 解冻时取，`assertHeld` 每事务一次共享锁；冻结期间只读待命而不崩溃循环；启动不依赖 capabilities 端点。
- **V8 事件入站**：删除事件来源切换（状态、历史、暂停 / 回退直连与管理 Dialog）；通道由配置给定；单个 endpoint 不可投递不影响同一事件的其他目标；CS 线格式移到 `integration/infrastructure/crewstation/`。
- **V9 装配与账本**：托管装配只在 `bootstrap/`；维护 Worker 入口与效果注册由 bootstrap 注入，平台层不再 import bootstrap / 业务模块；SQLite 根拒绝托管专用选择；本 RFC 新增的跨 context 边逐条标 `RFC-370` 并说明（能消除的已消除：托管能力快照类型改走 runtime-management public types，候选 / 评审 / 工作区选择类型改经各模块 composition 入口，零 consumer 的 public 导出删除）。
- **V10 前端**：托管恢复提示用 `NoticeBanner`；新拒绝码中英文案；托管保留个人访问令牌与外部 API 开关；轮询按权限门控。
- **V11 迁移收敛**：全部未发布迁移收敛为 SQLite `0259_rfc370_hosted_deployment` / PostgreSQL `0035_rfc370_hosted_deployment`（只增，紧随已发布的 0258 / 0034）；schema **216 source / 210 active / 6 archive-only**，逻辑摘要 `sha256:be5ad8b0edbc7bad31d4b3005824aef9c662efa8fb86747702f24f69ff640203`。已推送但未发布的旧 M1 0259 / 0035 被替换：应用过旧 0259 / 0035 的开发库须重建（正式 M0 库停在 0034，不受影响）。
- **V12 / V13（CS）**：CS `61478743`（RFC-040 材料固定引用释放与 native 探针 v2；RFC-042 放弃动作、第二次恢复槽位校验、verify 可重试与应用层预检）与 `516b83a1`（能力探针对模型偶发未按指令回显重试 3 次，每次全新 Agent 身份）均已推送，准确 SHA CI `38974772647`、`38980577018` 全部成功。

集中验证（本地，候选 `166e918bd`）：backend 四分片（SQLite + PostgreSQL）首轮 26,107 项通过、46 项失败，逐项修复后失败文件复跑全绿（只剩依赖提交后投影的账本项）；架构守卫在 census 投影后 839 / 0；frontend 7216 项（修 2 项后全绿）、shared 2324 项、system-mocks 91 项；三包 tsc、eslint（含 promises）、prettier、depcheck 通过。

提交与 CI：`166e918bd`（v3 主体，含 Codex 产出）→ `7ea27f56c`（census 投影与一次性增长许可）→ `bb0b74ea5`（归档 status 的相对链接、gitleaks 对测试夹具 Secret 引用的放行）→ `50ca1e0a7`（投影到 `bb0b74ea5` 并退役 18 条增长许可）→ `3387c37ed`（发布到既有镜像分支，去掉 `start_sha` / `force`）。主 CI：`7ea27f56c` 的 `38999520956` 红在 Markdown link check、gitleaks（均由 `bb0b74ea5` 修复）与 backend 16/24 的两条他人用例 5s 超时（RFC-213、RFC-075，同分片邻居正常，判为 runner 卡顿）；`bb0b74ea5` 的 `39000900443` 红在 14/24 的 T17 过期许可（`50ca1e0a7` 修复）和 6/24 的本 RFC `rfc370-m2-plugin-generations` 两条 SQLite 用例 5s 超时——同次运行里该文件的 SQLite 用例耗时 1–5.7s（其他运行 14–28ms），紧随其后的 PostgreSQL 变体耗时正常，判为约 15s 的 runner 卡顿，已按 dev-gotchas 给该文件显式 15s 墙钟预算；`50ca1e0a7` 的 `39001168574`、`3387c37ed` 的 `39001431851`（49 个 job）全部 success。

## 2026-10-19 v4 托管等价补齐（§10）

按「服务容器里没有 git / 解释器、没有持久本地盘，工作区是 CS 卷」逐项扫描用户可达入口后补齐的托管缺口（裁定见 redesign §10）。单机行为不变（例外均为顺带修复，已列出）；托管差异只在 bootstrap 选择适配器，卷内工作以粗粒度任务镜像命令运行原生实现：

- **V15 工作树文件下载**：`/api/worktree-files/:taskId/*` 经 Source Control 工作区内容端口读取（托管为 CS 文件 API 分页，父任务暂停时恢复；CS 404 → `worktree-file-not-found`），包含性与大小语义不变。
- **V16 代码评审读取**：Source Control `RepositoryRevisionContent` 端口与 `code-review` 任务镜像命令（大结果经卷文件回读，旧镜像以 410 `workspace-predates-code-review` 明确降级）；结构化 diff 与叙述经 Code Capability `CodeReviewArtifactStore` 持久化（托管为中立对象发布，删除任务后由清扫释放），已完成任务按完成世代读持久结果、不唤醒父任务（单机同一路径）；托管深度模式以 `indexing-unavailable` 回落基线；单机删除任务一并清理 `structural-diffs/<taskId>`（顺带修复）。
- **V17 仓库选择器与登记**：`/api/repos/refs|files?cachedRepoId=`（`?path=` 只在单机为既有 API 客户端保留，托管拒绝 `repo-path-unsupported`；MCP `list_repo_refs` 一跳）。托管在 `system:shared` 卷内以 `repository-remote` 命令（`git ls-remote --symref` + 无 blob 浅取）读远端，凭据按精确 URL 绑定；批量导入与仓库组 URL 挂载改为「校验远端后登记」（行显示「已校验并登记」），刷新为重新校验（更新默认分支与校验时间）；托管不注册子模块刷新作业。
- **V18 开发任务**：仓库事实读 HEAD 提交树，托管在开发卷内一次扫描（`repository-facts-scan`）；上传种子的发布、摘要与丢弃在卷内执行（`seed-tree-*`），种子物化写卷引用；动作工作区的 `.git` / 输入挂载存在性改经 Source Control 工作区读端口。
- **V19 程序工具**：Task Execution 的 `ProgramToolSource`（由 bootstrap 注入已选的程序制品存储）与 `ScriptFixtureProcess`（托管在 `system:shared` 卷内以 `execution-contract-fixture` 命令运行解释器）。
- **V20 记忆 → 技能融合**：见 redesign §10.2；融合编排不再 import Source Control 内部与文件系统（三处架构债务销账）。

集中验证（本地，提交前工作树）：backend 定向 425 个文件 5137 项（SQLite + PostgreSQL）首轮 17 项失败，全部由本批引入：多为守卫账本与测试替身随新代码更新，另有两处真实缺陷——V15 误删 `/api/worktree-files/:taskId` 引导路由；托管技能存储（`skill_content_entries`）把带 BOM 的 SKILL.md 存成少 3 字节的文本，改为以 base64 保存。逐项修复后受影响文件复跑全绿。另 1 项由本机环境造成：shell 的 `http_proxy` 让 git 访问 `127.0.0.1:1` 也走代理，约 1 秒后才返回 503，超过用例 500ms 的克隆预算；去掉代理复跑 14/14 通过（已记入 dev-gotchas）。frontend 860 个文件 7245 项、shared 2338 项全绿；三包 tsc、eslint（含 promises）、prettier、depcheck 均通过。

提交与 CI：

- `a6c05417b`：主 CI `39242700213` 有两个分片红，均为本批引入。backend 15/24 是 rfc310 锁不允许 Development Automation 的组合入口出现分支；20/24 是 V19 收窄了程序读取的入参，而员工程序根绑定用例仍按 V19 之前的单次读取断言。全量夜跑 `39250118444` 红在 REPO-44：选择器的定位参数已改为 `cachedRepoId`，spec 仍按旧参数断言。
- `0c266dbcc` 修复上述三处，并让 SQLite 根同样把选定的程序存储交给校验与 Reaction 执行。本地定向复跑 2464 项全绿，REPO-44 所在 spec 本机 8/8 通过；主 CI `39261747195`、windows-platform 全部成功。

部署（0c266dbcc）：

- 任务镜像 `runtime/agent-workflow/task@sha256:ed227f69…`（平台外构建）分别登记为正式 AW 版本 `01a1546f-5615-…` 与 `rfc042-aw-restore` 版本 `01a15470-c711-…`，任务用途验证均为 passed。验证期间临时改用 100m 档位，验证完已恢复。
- 节点 CPU 请求 98%、内存 96%，rfc042 `v0.2.2` 的构建 Pod 因 `Insufficient cpu` 过期失败。用户 2026-10-19 裁定下线正式 AW 预览槽中的 `v0.6.19` 回退目标（CS 原本会在 10-22 自动下线），之后 rfc042 `v0.2.3` 与正式 AW `v0.6.24` 均顺利构建。
- 两者都已切流，执行交接 complete（正式 AW 约 30 秒）。rfc042 的 `v0.2.1` 预览槽已下线，给恢复留出目标槽。

托管实机验收（v0.6.24，进行中）：V17 的 `?path=` 在托管下按设计拒绝（422 `repo-path-unsupported`）。按 id 读取时返回 500：服务日志为 `workspace-helper-operation-unknown: repository-remote`，命令落在了 v0.6.23 时期创建的 `system:shared` 父任务上（旧镜像）——见 redesign §10.3 的补正。随之发现持久卷的镜像升级缺口：CS 父任务终身保持创建时的任务镜像，`development:shared` 与 v4 之前的任务卷永远用不上新命令。用户 2026-10-19 裁定新开 CS RFC-043，在父任务空闲时把它升级到同一运行镜像的新版本，保留工作卷。

## 2026-10-19 V21 持久父任务镜像升级与 F2

v4 实机验收中发现两个问题，按 redesign §10.5 与 §9.2 的补正实现：

- **V21**：AW 任务卷与 `development:shared` 的 CS 父任务随发布升级任务镜像，依赖 CS RFC-043 改钉已暂停的持久父任务。
  - 只在能力快照报告 `runtimeImageUpgrade: 1` 并声明版本、且父任务报告的当前版本与之不同时升级，请求总是显式带上发布声明的版本；scratch owner 仍按发布替换父任务。
  - 主动：生命周期对账把空闲且已暂停的共享 owner 父任务升级到发布的镜像。
  - 按需：卷内命令报 `…-operation-unknown` 时，若父任务无活动工作，就暂停、升级、再以 `<原操作>:image-upgraded` 重跑一次；有活动工作时返回可重试的 503。
  - 平台拒绝或升级失败时父任务保持原镜像，返回 502 并带平台原因码；同一镜像对 10 分钟内不再请求。
  - 实现（帮手代理产出，已审核）：`source-control/infrastructure/crewstation/workspaceImageUpgrade.ts`，由 `composeCrewStationWorkspaceOwner` 注入命令与生命周期。
- **F2**：在 `rfc042-aw-restore` 上，系统 Agent 一直拿不到额度，自行取消提交并脱离。
  - 结算器只处理更早 epoch 的无节点绑定，这条绑定整个 epoch 都不结算；`system:shared` 因此一直算在用，空闲父任务从不暂停，持续占用项目额度与 2 GiB 内存。最终融合的合并 Agent Pod 因节点 `Insufficient memory` 调度不上，5 分钟后 `failed-before-start: agent_environment_unavailable`。
  - 修复：本 epoch 内已记下取消、且本进程无人观测的无节点绑定交给结算器；平台对同键重提仍答 429 时即视为从未受理，直接结算为 abandoned，不等额度。
  - 正式 AW 上同样有一条 `system:shared` 的取消中绑定，至今未结算（epoch 45），旧镜像的 `system:shared` 父任务因此一直在用。新发布换 epoch 后由结算器处理。

集中验证（本地，提交前工作树）：全部 257 个 `rfc370-*` 用例文件、`tests/architecture/*`、错误码与 RFC-310 / 376 守卫，共 431 个文件，SQLite 与 PostgreSQL 双引擎 4213 pass / 6 skip / 0 fail；三包 tsc、eslint（含 promises）、prettier、depcheck 通过。

### v0.6.25 托管实机验收（2026-10-19）

正式 AW 以 `--source 456d1b1dc` 发布 `v0.6.25`（CI `39291044338` 全绿），18:10 切流，执行交接约 20 秒完成（epoch 49）。CS 先后部署 RFC-043（`660a6185`）与终结修复（`563322f8`）。

- **V21 / RIU-07**：
  - 主动：已暂停的共享 owner `resource:plugins` 被升级到发布声明的 `01a1546f-…`（代次 2 → 3）。
  - 按需：10-18 的旧任务打开「变更」，旧镜像回报 `code-review` 未知；依次暂停、升级、恢复后重跑（代次 3 → 6，卷 UID 不变），`structural-diff` 返回 200。
- **V17**：旧镜像的 `system:shared` 父任务被替换后，按 `cachedRepoId` 读 refs / files 均为 200；刷新即重新校验（`defaultBranch` 从未知变为 `main`）。批量导入时，已登记的仓库为「already registered; remote verified」，未绑定凭据的仓库被拒为 `repo-remote-unreadable`。每次托管读取约 30 秒，偏慢但结果正确。
- **V20**：合并 Agent 在托管上两次跑通（34k、48k tokens）。整条融合两次未完成：
  - 第一次：节点内存不足，合并 Agent 调度不上。根因是 F2 泄漏，加上 CS 终结卡在未启动尝试上（`563322f8` 修复）。
  - 第二次：引擎任务在等人工回答期间被暂停，被 CS 误判为「容器不存在」。见下方 CS 修复。

验收中发现并修复：

- **F3（AW）**：暂停的父任务恢复被额度拒绝后，下一轮用已推进的代次生成新键，每次轮询都被受理为新的生命周期操作；一个等额度的旧任务半小时内代次 6 → 83。现在额度拒绝的恢复按原键、原代次重放（`taskWorkspace.ts`）。
- **F4（AW）**：CS 把一个已取消的 Agent 子任务结束了，却没有写结果事件（正式 AW 上的 `system:shared` 绑定一直等它）。观测在每次干净断开后读子任务视图：视图已终态且带结果时，把结果按事件记账；没有结果时以 `ended` 结束观测，绑定按未知结算，卷不再被一直占用（`subtaskStream.ts`）。
- **CS**：
  - 暂停中或已暂停的业务工作区不再因对账读到的旧快照被判「容器不存在」：引擎任务的父任务正是这样失败的，等人工回答超过 2 分钟的托管任务都会撞上。
  - 终结排空的阻塞信息写明具体子任务及其状态。

### v0.6.26 托管实机验收（2026-10-19）

正式 AW 以 `--source b09ddbfe2` 发布 `v0.6.26`（CI `39309266433` 全绿）并切流（epoch 51），`rfc042-aw-restore` 同源发布 `v0.2.5` 并切流（epoch 17）。CS 部署 `54bbea25` 与 `4c735036`（CI `39320413944` 全绿）。

- **F3 / F4**：正式 AW 上那条等着已取消子任务的 `system:shared` 绑定已结算，`system:shared` 不再算在用；新的 `system:shared` 父任务空闲后关闭，项目额度降到 1/3。
- **CS 终结（`4c735036`）**：两个旧 `system:shared` 父任务各卡在一条 `e0b8f149` 之前写下的未启动尝试上（失败、未启动、无结果），分别是正式 AW 的 `01a151b9-…` 与 rfc042 的 `01a151ec-…`。部署后排空为它们补写结果，两个父任务约 5 分钟内归档并关闭，额度与卷释放。
- **V20（rfc042）**：融合全程跑通。
  - 合并 Agent 提问后，人工回答前等了超过 2 分钟；引擎任务的父任务按设计暂停（保留卷），未再被判「容器不存在」。
  - 回答后父任务恢复，合并 Agent 重跑，提案被收集，融合进入待批准。
  - 批准后技能升到 v2（来源 fusion），记忆标记为已融合。
- **AC04**：两仓任务（仓库组挂载 `alpha` / `beta`）在正式 AW 上完成，diff 按仓列出两处修改。
- **V15**：已完成任务的工作树文件下载返回 200（`alpha/NOTES.md`，`text/markdown`）。
- **V16**：已完成任务的结构化 diff 首次 38 秒（卷内计算后持久化），再次 164 毫秒（读持久结果，不唤醒父任务）。`repoKeys` 为 `alpha`、`beta`；只改 Markdown 时为 `no-changes`，与单机同一路径。变更叙述失败，见 F6。
- **V18**：首个开发数字员工 Case（仓库范围，正文加一个上传）在 `prepare-materials` 即被阻塞，见 F7；已终止，修复发布后重做。

验收中发现并修复：

- **F5 技能描述**：融合改了 SKILL.md 的 description，`skills.description`（技能列表与选择器显示的值）却仍是旧值；恢复旧版本同样不同步，单机也一样。现在融合的整树写入（`skillTreeVersionParticipant`）与恢复（`restoreSkillVersion`）把新 SKILL.md 声明的描述随版本一起提交（带 BOM 也能识别）；编辑与 ZIP 导入本来就同步。
- **F6 执行截止时间**：托管执行的截止时间从 AW 建绑定时算起，提交等额度的时间也算在内。变更叙述（预算 120 秒）等了约 6 分钟额度，受理后未启动就被取消（`cancelled-before-start`）。截止时间现在从平台报告进程启动算起（`execution-state` 的 `process` 不再是 `not-started`），与单机子进程的计时一致；起不来的进程由平台以 failed-before-start 结束。
- **F7 开发任务的上传**：托管的上传引用是对象引用（`employee-input:aw-object:v2:…`），不是摘要。平台工作项的上下文模式要求 `employee-input:<sha256>`，于是所有工作项都拒绝这个 Case；准备修改时还从引用里截取摘要。现在种子在上下文里记下已校验的摘要，引用按不透明处理。摘要开始记录之前冻结的本地种子，仍从内容寻址的引用取摘要。Case 详情里的上传字段保持不变。

环境与遗留（不改）：

- 平台 PostgreSQL（`max_connections` 100）长期占用 97～98 个连接：CS 控制面约 50 个，其余项目约 26 个，正式 AW 两个槽约 17 个。AW 维护作业每 15 分钟新开连接，偶尔在满额时失败，下一轮重试。这是本机平台的容量问题；AW 已在 10-17 把托管连接池降到 8。
- rfc042 上有一条创建请求先被额度拒绝、随后对应的 AW 任务被删，CS 一直把它列为 admitting（不占额度与卷）。
- 数字员工创作接口对不合法的请求体返回 500（服务内的 ZodError 没有映射成 400），与托管无关。
  - 2026-10-23 收口后 bug fix 已修：非法创作/受理请求体及 `null` body 返回 422 `validation-failed`；策略升级返回 422 `employee-policy-preview-invalid`，终止请求返回 422 `employee-terminal-kind-invalid`。原验收记录保留。

### v0.6.27 托管实机验收（2026-10-19）

`bba506bd2`（F5～F7，CI `39328423440` 全绿）发布为正式 AW `v0.6.27`（切流后约 36 秒执行交接完成，epoch 53）与 rfc042 `v0.2.7`（epoch 19；`v0.2.6` 的构建因平台 buildkitd 中途崩溃失败，原样重发）。

- **F5**：rfc042（数据库技能存储）上恢复融合版 v2，技能行的描述随之变为融合后的描述；再恢复 v1，回到原描述，两次都与 SKILL.md 一致。
- **F7**：新的开发数字员工 Case（正文加一个上传）通过了 `prepare-materials`，进入 `analyze-implement`。
- **V16 全部读取**：在一个新增 TypeScript 代码的单仓任务上验证（`01M5B1MEZ5EFDPNZ9TPSHMR74K`）：
  - 结构化 diff 列出新增的函数 `greet`、`main` 与 import，`callChainAvailable` 为 true；文件符号按 TypeScript 识别。
  - 代码智能：基线模式把 `main` 里的 `greet` 解析到 `src/greet.ts` 1～3 行；深度模式以 `indexing-unavailable` 回落基线（设计如此）。
  - 调用目标：`src/main.ts#main` 得到 `console.log()`（未解析）与 `greet()`（external），与单机在同一组文件上的结果逐字相同。
  - 文件内容（工作树侧与基线侧）、工作树目录与文件读取均为 200。
- **V18**：Case 进入 `analyze-implement` 后被阻塞，原因是平台卷配额，见下方 F9；仓库事实扫描与种子放置的实机验证待卷配额问题解决后重做。
- **变更叙述**：重新生成仍失败，见 F8。

验收中发现：

- **F8 变更叙述无法重新生成（已修复）**：叙述的观测 attempt 用的是内容摘要，同一任务、同一 diff 再次生成时得到同一个执行身份。托管执行按身份持久，于是重新生成拿到的是上一次的绑定：这一次它属于已被替换并关闭的旧 `system:shared` 父任务，提交前的意图校验不通过，报 `spawn-failed`（同一父任务时则会原样返回上次的失败）。单机每次调用都会重新运行。其他系统 Agent 的 attempt 本来就按次区分（意图轮次、蒸馏作业次数、探测 nonce、反问请求）。现在叙述每次触发生成新的 attempt（摘要加 ULID）。同一时间的运行时探测（同一托管系统 Agent 路径，nonce 区分）结果为 conforms。
- **F9 平台卷配额耗尽（待决定）**：正式 AW 项目命名空间的 Kubernetes 配额是 20 个 PVC，已用满。新的 `development:shared` 父任务的工作卷被拒（`exceeded quota: persistentvolumeclaims=20`）；CS 重试后以「容器不存在」判失败，没有说明真实原因。20 个卷的去向：
  - 14 个是已结束 AW 任务的暂停父任务。托管下 AW 任务的父任务（与卷）一直保留到任务被删除；单机的工作树也默认保留（`worktreeAutoGc` 默认关闭），但单机不受卷数量限制。托管 GC 开启时也只删卷内的工作树目录，卷本身不释放。
  - 4 个是 CS 判失败的父任务，CS 为恢复动作保留卷。
  - 1 个属于按旧存储生命周期关闭的 CS 任务（10-18 的 `system:shared`）：任务已关闭、资源已释放，PVC 却仍在（CS 遗留，没有回收路径）。
  - 1 个是运行中的 `system:shared`。

### v0.6.28 托管实机验收与卷保留（2026-10-19）

`f484a43f4`（F8）发布为正式 AW `v0.6.28`（epoch 55）。准确 SHA CI `39335043206` 第一次尝试红在 Playwright e2e（windows-latest shard 3/4）的 WF-24（工作流模板起步的审计角色预选到了 demo Agent，重试时节点选择器又出现重复项）。该用例在 `bba506bd2` 上通过，本提交只改了变更叙述，与它无关；同 SHA 只重跑失败作业一次即全绿。近期 main 上其他提交的 e2e 分片也有不同用例间歇失败。

- **F8**：重新生成以新的 attempt 运行；Agent 提交后 16 秒进入运行（未等额度），运行 120 秒时被截止时间取消（F6 生效）。
- **F12 变更叙述的预算（已修复）**：叙述自带 120 秒预算，是所有系统 Agent 中最短的；意图轮次与反问追问是 600 秒，蒸馏 3600 秒。本集群上托管 Agent 一轮约 3 分钟（运行时探测 2 分 48 秒、蒸馏 2 分 49 秒），叙述因此每次都被取消。叙述在后台生成，界面轮询结果，不受 HTTP 时限约束，现在改用系统 Agent 的默认预算。
- **F9 的决定（用户 2026-10-19）**：
  - 回收已关闭的旧 `system:shared` 卷：经 CS 的「删除工作卷」动作（`01a14e49-f06b-…`，待回收），PVC 降为 19/20。
  - 卷保留：我最初提议让工作树 GC 释放卷。随后发现任务卷里还有 `/work/runs/<task>` 与 `/work/logs/<task>`，归档（出库）正要读它们，这正是 V3 修过的问题，于是向用户更正。用户选定：GC 仍只删工作树；归档是托管的保留路径，归档后释放这些任务的卷。归档默认关闭（`taskArchive.enabled`），默认行为不变。
- **F11 归档释放卷（已修复）**：托管归档的移动从不消耗来源，归档后任务卷里的工作树、runs、logs 都还在；孤儿清扫只看运行中的父任务；删除任务才关卷，归档直接删行，所以归档过的任务卷永远占着 PVC 配额。现在归档在删行之后、完成认领之前，释放这些任务各自的卷（崩溃后恢复会重做），与删除任务一致。单机的归档不变：工作树留给 GC 的孤儿清扫。
- **F10 持久共享 owner 的失败父任务（已修复）**：`development:shared` 的父任务在卷建出之前就失败了（卷被配额拒绝）。AW 一律提示「到 CrewStation 恢复页重建」，但重建需要原卷，开发数字员工因此全部卡住。现在持久共享 owner 遇到失败且从未有卷的父任务时，按 scratch 父任务的方式替换。有卷的父任务仍走恢复；AW 任务的父任务仍跟随任务自己的生命周期。
- **CS F9b（已修复）**：Pod 一直没建出来并因此判失败时，若工作卷也不在，读项目配额。配额用尽时写明「容器没有建出来：项目持久卷配额已用尽（已用/上限）…」，不再只说「容器不存在」。

### v0.6.29 托管实机验收（2026-10-19）

`99ef0dd91`（F10～F12）发布为正式 AW `v0.6.29`（切流后约 31 秒交接完成，epoch 57）与 rfc042 `v0.2.8`。准确 SHA CI `39345672166` 第一次尝试红在 Playwright e2e（macos-latest shard 2/3）的 INTENT-13b：等 daemon 就绪行超时 30 秒。同一用例在其他 session 的 `f777b875a`、`56cc088c8` 上也这样失败，本提交没有改到它；只重跑失败作业一次即全绿。CS F9b（`3c1ffee0`，CI `39348176988`）已部署。

- **F10**：恢复上一轮被卷配额卡住的开发数字员工 Case `01M5B33HTP3N7D7S07P00E1E49`。AW 替换了从未建出卷的 `development:shared` 父任务（新父任务 `01a156c9-…`），工作区在新卷上准备完成，`analyze-implement` 的 Agent 开始运行。
- **变更叙述**：重新生成以新的 attempt 提交，但被 F13 拒绝，记为 `exit-nonzero`；待 CS 修复部署后复验。
- **AC11 浏览器**：变更视图经网关渲染通过；工作树文件一页因脚本的就绪选择器选中了隐藏元素而超时，脚本待修后重跑。

验收中发现：

- **F13 托管提交在续租期间被拒（CS 修复）**：叙述的提交被平台以 409「执行权已变化，请重新读取控制状态」（`stale_generation`）拒绝，而 AW 当时持有执行权（epoch 57，此后照常派发）。
  - 原因在 CS：服务启用对象存储时，执行权行的每次变化都要送达对象写入控制并确认，确认之前执行权不算生效。每 10 秒一次的续租也是变化，所以每次续租之后、确认之前，持有者自己的变更全部被拒。
  - 确认要排在同一服务的其他平台工作之后，共享 PG 连接接近上限时要几秒；这次提交前平台刚为叙述新建了 `system:shared` 父任务。AW 平台客户端对 `stale_generation` 的 5 次退避重试（约 7.5 秒）没等到确认，执行被放弃。
  - v0.6.28 的托管恢复轮询在 77 分钟内同样被拒 5 次，下一轮自愈，没有外部症状。
  - CS 修复：执行权行记下首次授予当前授权（世代、租约、实例、Pod、阶段）的版本，续租沿用它；对象存储确认过这个授权，持有者就照常受理，新期限的送达不再挡住它。授权变化（激活、换实例、冻结、交接）仍要等确认。
- **F14 第一轮真实 OpenCode 被判写了 `.git`（已修复）**：恢复后的 Case 停在 `analyze-implement`：`workspace-boundary-protected-root-write: added git-meta/opencode`。
  - OpenCode 每次启动都把项目 ID 缓存写进 Git 公共目录（`<common-dir>/opencode`）：opencode `packages/core/src/project.ts:124-126`，调用方 `packages/opencode/src/project/project.ts:306-308`。Agent 运行在 RFC-130 链接工作树里，公共目录就是 Case 工作区的 `.git`，所以对 `.git` 的前后快照在第一轮真实 OpenCode 之后必报 added。
  - 单机同样如此，与模式无关；此前开发数字员工的测试与 e2e 都用 mock runtime 或直接模拟 Agent 写文件，从不写这个缓存。重试会重新克隆工作区，每次都同样失败，Case 因此阻塞。
  - 修复：`git-meta` 的比较跳过运行时自己的 `opencode` 缓存（与 TaskEngine 自有路径分列）；其他对 `.git` 的写入照旧判违规。托管下跳过清单随请求送到任务卷，已钉住的任务镜像同样生效。

### v0.6.30 托管实机验收与收口（2026-10-19）

F14 随 `b1c28ff0b` 提交。其 CI `39354883311` 红在 backend 分片 7/24 与 10/24：新测试文件名含 `boundary`，被 RFC-317 架构账本当成未登记的守卫，属本次引入；`8e5c57a21` 把文件改名，内容不变。`8e5c57a21` 的 CI `39357153327` 第一次尝试红在 macOS e2e 分片 2/3 的 INTENT-13b（等 daemon 就绪行超时 30 秒，与 v0.6.29 同一失败），只重跑失败作业一次即全绿。它发布为正式 AW `v0.6.30`（切流后约 24 秒交接完成，epoch 59）与 rfc042 `v0.2.9`（epoch 23）。CS F13（`8d2f3ce3`，CI `39355748015`）此前已部署。

- **F13**：CS 部署后，正式 AW 的变更叙述重新生成约 4 分钟内就绪（此前两次都被拒）。此后约 1 小时（02:06～03:04，覆盖下面整条 Case 的运行）两个槽位都没有再出现 `stale_generation` 或续租失败；修复前 75 分钟内有 4 次。叙述就绪同时证实了 F8（每次触发新 attempt）与 F12（默认预算）。
- **F11**（只在独立服务 rfc042 上验证）：手动归档一棵超过 1 天的已结束任务树（`01M58YE41YVF…`，1 个任务）。它的工作卷随即释放：项目 PVC 3/20 → 2/20，对应的 PV 也不在了；任务读取为 404。正式 AW 没有归档任何任务。
- **F14 与 V18 开发数字员工全流程**：恢复 Case `01M5B33HTP3N7D7S07P00E1E49`。
  - `analyze-implement`：真实 OpenCode 在托管上跑完，边界校验通过。
  - `prepare-change`：冻结的变更只含 `NOTES.md` 与上传的 `docs/rfc370-v18-seed.md`。
  - `publish-mr`：分支从任务卷推到本机 GitLab（提交 `62c91638c0bd`）。`NOTES.md` 只追加了要求的一行；种子文件逐字节等于上传内容，sha256 `fe9c7424…` 与上传引用记录的摘要一致，F7 端到端成立。
  - 首次创建 MR 时被阻塞：`code-host-connection-missing`。正式 AW 没有配置代码托管连接，单机同样需要这项配置。为验收临时配置了 GitLab 连接，令牌只授予验收项目（项目 550，`api` 范围）；从服务 Pod 测试连接通过。
  - 恢复后服务创建了 MR !1，Case 观测到 `mergeable` 并进入等待。在 GitLab 上关闭 MR，约 24 秒后 Case 以 `closed` 结束。随后删除该连接、吊销令牌，正式 AW 的代码托管配置恢复原状。
- **V19 程序工具**（rfc042）：开发员工类型 `prepare-materials` 上登记一个 Python 程序工具。程序制品存入托管对象存储；契约夹具经 `system:shared` 卷内的 `execution-contract-fixture` 运行，读到参数并输出合同要求的结果。9 项检查全部通过，发布成功（revision 1）。
- **AC11 真实浏览器**（无头 Chromium 经 CS 网关、平台会话）：
  - 正式 AW 的变更视图（结构化 diff 与大纲）、工作树文件树与文件预览、开发员工 Case 页（能力图与阻塞原因）均正常渲染。
  - rfc042 的融合技能页显示 SKILL.md 的描述。
  - 唯一的控制台错误是叙述尚未生成时的 404，属预期。

至此 §10 V14～V21 与验收中发现的 F1～F14 都在托管实机上验证，v4 收口。留作记录、未改动：

- 正式 AW 项目的 PVC 再次用满（20/20）：多数是已结束 AW 任务保留的卷。按用户裁定，经归档（默认关闭）或删除任务释放，由用户决定何时做。
- CS 判失败的父任务为恢复动作保留卷，其中从未绑定（Pending）的卷没有数据，却同样占配额（正式 AW 1 个，rfc042 2 个）。属 CS 的保留策略，未改动。
- 开发数字员工的编排接口收到非法请求体时返回 500（原样的 ZodError），与托管无关。
  - 2026-10-23 收口后 bug fix 已修：Mission / 配置路由解码返回 422 `validation-failed`，Mission / adopt-mr 命令返回 422 `mission-input-invalid`，playbook 内容返回 422 `digital-employee-draft-invalid`（含 `details.issues`）。原验收记录保留。

## 2026-10-17 托管实机验收（M1～M3，已完成）

- **任务镜像**：CS 运行镜像的源码构建器资源固定（500m / 1 Gi / 3 Gi 缓存），AW 二进制构建实测峰值内存约 2.15 GB，平台内构建被驱逐（缓存超 3 Gi）。改为运维在平台外从准确提交构建、作为「已有镜像」登记并做任务用途验证，步骤写入 [docs/crewstation-deployment.md](../../docs/crewstation-deployment.md)。`3387c37ed` 的任务镜像 `runtime/agent-workflow/task@sha256:860b8932…`（底座 `7701acd4`）已登记：镜像 `01a1480f-2e12-7000-bff7-3cfdcce5ccc6`，修订 3 `01a1483d-38a4-…`，版本 `01a1483d-402a-7000-8067-e7737ee88bba`。
- **CS 缺陷（已修）**：任务镜像验证在真实平台上 200ms 内一律以「验证已取消或租约丢失」结束——自 CS `463f24d8` 起本机再无验证通过。Runner 探针经 task-runtime 的嵌套准入回调验证心跳，嵌套作用域只带 task-runtime 自己的准入键，心跳核对 runtime-environment 的准入必然失败。CS `8d127df9` 把心跳绑定到原验证回调的上下文（回归用例在嵌套准入中回调心跳），准确 SHA CI `39007600564` 九项全部成功，已部署本机；之后验证越过心跳进入环境创建。
- **共享平台条件（用户 2026-10-17 裁定后已处理）**：①平台运行镜像底座原固定在 `CS_BASE_IMAGE_TAG=rfc027-final-0c8be5fd`（其 Runner 不声明 `commandSecretEnvVersion`，带 Git 凭据的命令无法运行），按用户裁定改回 `dev`（Runner `sha256:5a748ec6…`）并重启 CS 组件。②任务用途验证使用缺省任务档位（1 CPU），满载节点上无法调度：按用户裁定只在每次验证期间把 `CS_DEFAULT_TASK_PROFILE` 指向 100m 档位 `rfc028-image-validation` 并只重启 cs-controller，验证完立即恢复（每次均已恢复）。③Docker VM 磁盘：按用户裁定清理 7 天前的构建缓存、24 小时前且不被容器使用的镜像，以及本 RFC 导入节点的旧任务镜像，可用空间由约 0.6 GB 回到约 36 GB。此前两次镜像导入瞬时写满磁盘，正式服务 Pod 以 `ENOSPC` 重启各一次后自行恢复。
- **CS 缺陷三（2026-10-18，CS RFC-040，已修）**：额度满时，已得 2xx 的 Agent 子任务被平台后台记为「可重试拒绝」后永久 pending：M2 控制流 `01M5798CMMH92MAD2405HFTXXK` 的 `clarifier#1` 提交时项目并发额度 3 被该父任务、`system:shared` 父任务及其记忆蒸馏 Agent 占满，AW 收到 429 后按同键退避重放（正确行为）；一次重放与平台后台 claim 竞态，AW 得到 200，后台准入随即遇额度不足、把子任务记为只有同键重放才能重新准入的状态，AW 已无理由再重放，30 分钟后节点以 `cancelled-before-start` 超时失败。修在 CS：仍在等待回执的请求照旧 429，已答复的子任务遇额度不足由平台后台继续准入（同一环境 ID）。CS `621e6183`（回归用例修复前红、修复后绿；完整本地门禁 5804 pass / 0 fail），准确 SHA CI `39125433559` 全部成功，已部署本机（控制面 `cs-control-plane@sha256:9b0c1c3d…`）。详见 CS `proposal/rfc/RFC-040-business-native-materials/acceptance.md`。
- **CS 升级使任务镜像验证失效（2026-10-18）**：部署 CS `34331a3c`（控制面 `cs-control-plane@sha256:17bb84bf…`、控制台 `cs-console@sha256:4ed20b0b…`，配置不变）时重新推送了任务运行镜像底座 `task-runtime:dev`（`5a748ec6…` → `5acdc4da…`）。任务用途验证绑定平台 Runner 合同的摘要（Runner 协议、初始化器与任务镜像设置，CS `modules/platform/application/runtimeImagePorts.ts`），摘要一变，已有验证全部不再匹配：生产 v0.6.19 约 10 分钟内的任务启动一律被 CS 以 `412 该镜像尚未通过所选用途与档位的验证`（`image_usage_unvalidated`）拒绝，AW 显示为无说明的 HTTP 500；其间发布的 v0.6.20 在发布的镜像保留处被同一拒绝判为 failed。对版本 `01a14d79-…` 与 `01a14f10-…` 以新 `requestKey` 重新验证（按用户裁定临时 100m 档位，之后已恢复）即恢复，生产任务 `01M57QZG65Q1HV2C6KYTN9D0WR` done。AW 侧改为明确的运维错误（下表 `20069e91a`），处置写入部署运行手册。新登记的「已有镜像」还要通过新底座的分层前缀校验：旧底座上的 AW 任务镜像在 RFC-042 验收项目里登记即失败，须在新底座上重建。
- **RFC-042 独立验收服务的平台准备（2026-10-19，用户授权）**：项目 `rfc042-aw-restore`（50m / 512Mi 套餐、并发 2）在新底座上登记并验证了 AW 任务镜像（版本 `01a14fc5-5394-…`）；向它开放发布档案引用的两个隐藏算力档位（项目算力策略 `additionalProfiles`）；共享对象后端 60 GiB 预算已被三个 20 GiB 空间分完，按用户裁定把正式 AW 的对象空间从 20 GiB 调到 18 GiB（已用 13 KB，资源中心直接变更 `01a151dd-5dae-…` applied），并新建只授给该项目的 2 GiB 对象档位 `01a151dd-925a-…`。第一次发布暴露的两处发布脚本缺陷见下表 `9f2f48d42`、`293c1951f`。
- **CS 缺陷四（2026-10-19，CS RFC-040 / RFC-042，已修）**：①独立服务的记忆蒸馏作业 `01M58YQXQQHV4YV7K33H5XDFZY` 一直 running：其 CS 蒸馏 Agent 子任务启动前以 `agent_environment_unavailable` 失败，平台只改了子任务视图、没有终态 `result` 事件，而调用方按事件流等到 result 为止。②数据库恢复在 `requested` 阶段被单飞存储探针的 409「独立原生卷来源探针正在采样」当作平台拒绝停住，每次管理员重试又在数秒内撞上探针占用。CS `e0b8f149`：启动前失败与启动前取消一样以终态 result 事件（`failed-before-start: <code>`）结束；`native_postgres_source_busy` 归为暂态、自动重新观测；探针单次请求 120 秒截止。准确 SHA CI `39196018586` 全部成功，已部署本机（任务运行镜像底座仍为 `5acdc4da…`）。
- **CS 缺陷五（2026-10-19，CS RFC-042，已修）**：恢复操作越过供给后停在 `restoring`、`restoreJob` 始终为空：恢复 / 校验 Job 是 `migration-job` 台账记录（`job.purpose` 为 `database-restore` / `database-verify`，归属 `<jobId>/migration`），平台原生仓库创建准入却按 `build | migration` 解析发布引用，控制器工作队列里每次创建都校验失败（40 分钟内 21 次以上），Job 从未建出。其余环节（Job 渲染、凭据 Secret、发布 owner 准入）本已支持两种恢复用途。CS `0dc7fea4` 让准入接受两种恢复用途、按 `<jobId>/migration` 归属交给恢复 owner（回归用例修复前红、修复后绿；完整本地门禁 5804 pass / 176 skip / 5 fail，均为与本改动无关的既有失败：两条依赖 Linux `/proc` 的用例在 macOS 上失败，三条任务运行时归档用例单独复跑通过）。
- **CS 缺陷二（已修）**：项目任务镜像固定的业务任务 `POST /v3/business-tasks` 一律 500「Cannot expand an active shared admission」：业务任务在自己的项目准入里保留任务镜像，运行镜像目录事务却用多键准入入口（该入口按设计拒绝扩展已激活的准入）。CS `191f9ad1` 改用单键共享准入嵌套（回归用例在其他模块准入中跑目录事务并断言原生仓库共享锁确实持有），准确 SHA CI `39020650971` 全部成功，已部署本机。
- **任务镜像构建（运维做法）**：`git archive` 准确提交 → 在宿主机磁盘上用 `oven/bun:1.4.3` 执行 Dockerfile 构建阶段同样的命令编译二进制 → 经平台仓库 API 以上一版任务镜像的底座层与 apt 层为下层、只替换二进制层与配置后推送（只上传新层，不在节点侧导入整镜像）→ 登记「已有镜像」修订、构建校验、任务用途验证。v0.6.10 的任务镜像即按此装配，验证通过。

**AW 缺陷（实机发现，均已修复并补回归用例）**：

| 提交                       | 现象与根因                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `04072a0ff`、`b864cd42a`   | 两个镜像的 apt 步骤在镜像源丢连接 / `500 … unexpected EOF` 时失败：整步最多重试 5 次并用 `dpkg -s` 校验                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `4163865a8`（`227afdb2c`） | 新版本槽位待命启动即崩溃循环：MCP 运行时测试服务的暂停先启动它，启动做围栏写，未获执行权时抛错。改为与任务执行后台一样惰性绑定；回归用例以真实 daemon 对拒绝再授予执行权的平台启动                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `074608a00`                | 升级到 v3 的托管库一切备份都 `hosted-backup-installation-provenance-missing`：来源校验要求安装操作的摘要等于当前世代摘要，只增迁移只推进后者。来源按两行共同记载的来源判定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `c9c90e826`                | 卷内第二条命令 `409 stale_generation`：每次续租推进平台写控制，确认前的调用被拒。可安全重试的调用（带 requestKey 或只读）按 429/503 同样有界重试                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `8ae7420b3`、`31807b4ce`   | 交接时共享 PostgreSQL 连接耗尽（两槽各 16 连接）：托管实例缺省池 8，`AW_DATABASE_POOL_MAX` 可调                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `73ded85bd`                | 任务在执行任何节点前以 `workspace-exclude-profile-failed: … "git"` 失败：托管未选工作区排除配置的 owner，回落到在服务容器里跑 git。改为在任务卷内执行的 `workspace-exclude-profile` 命令                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `8f924c294`                | 不带凭据的卷内命令一律 `hosted-git-credential-bindings-invalid`：平台把项目配置（含部署级公开形式的 `AW_GIT_CREDENTIAL_BINDINGS`）注入任务容器环境。运行期形式改名 `AW_GIT_RUNTIME_BINDINGS`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `a8d3c481b`                | 所有写文件的托管 Agent 节点 merge-back 失败 `null is not an object (evaluating 'e.length')`：快照的可选强制路径以位置参数 `undefined` 发送，JSON 命令里成了 `null`。发送空列表，任务镜像把 `null` 视为缺省                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `7e7e3606b`、`32ab447da`   | git 包装器的提交推送 `commit-local-failed: prepared index became empty`（单机同样复现）：提交推送生成提交信息期间释放工作区（RFC-076 C4），兄弟节点 merge-back 的物化重置了主树索引；物化还按隔离区创建时的 HEAD 重置，提交先落地时会把它从分支上撤下。物化保持当前 HEAD；prepare 记录暂存树，提交时若索引被改写则恢复该树；提交预览不记录树                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `05ca7e200`                | 共享系统 scratch 父任务（`system:shared`）在早期版本创建后一直沿用：CS 父任务终身保持创建时的任务镜像，之后各版本的记忆蒸馏在其中一律以旧镜像的 `hosted-git-credential-bindings-invalid` 失败，而共享 owner 的父任务从不关闭。scratch owner（`system:…`、`mcp-test:…`）的父任务改为跟随运行中的发布：他版本且不在运行的父任务在下次使用时关闭重建，平台关闭 / 失败的同样重建，仍在运行的继续服务直到空闲后由生命周期对账关闭；AW 任务卷与持久共享 owner（`development:shared`）不变，跨版本兼容由任务合同版本约束                                                                                                                                                                                                                                                                             |
| `ebad918a4`                | 发布交接打断的任务，用户「恢复」一律 409 `task-execution-outcome-unknown`：两个 provider 运行时（SQLite 守护进程与 PostgreSQL 守护进程都用它）的路由 resume 运行时丢掉了演员，续跑以 `internal` 提交、授权不了被打断操作的重放（TASK-27 同形）。路由 resume 带上演员；测试夹具的根恢复运行时原先带着演员，掩盖了这一缺陷                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `2a70c9328`（`e2cb7cf49`） | 发布交接打断的任务恢复后以 `scheduler stalled; failed parked: count` 失败：交接时 `count` 正在 merge-back 的快照，旧实例失权后 detach 了卷内命令，却仍把节点写成 `merge-failed`——托管写屏障只在迁移冻结时拒写，失权后的写库照常落地。即便不写，已 done、快照未落的行（`isolating`）也没有恢复路径，被打断的自动提交推送也不会再触发。改为：失权即拒绝一切写库，执行权仍在时控制行一旦换主也拒写（交接等同崩溃）；恢复时逐帧完成被打断的 merge-back——顶层在任务入口，包装器体在包装器驱动时合进包装器自己的工作区（原先一律合进任务工作区，包装器的 `git_diff` 会漏掉它），扇出子行在复用前完成、merge-failed 的子行改为重跑；被打断的自动提交推送续跑时重跑一次，并收尾旧尝试遗留的提交信息会话                                                                                               |
| `3f43b91ee`                | 紧接上一个任务启动的任务，仓库准备几秒内以 CS 的 `429 quota_exceeded`（「并发任务额度不足，请使用同一 requestKey 重试」）失败：上一个任务的容器还在暂停宽限期内、系统 scratch 父任务占着另一个名额。平台在名额空出时会接纳同一 requestKey，但父任务创建只经传输层的几次快速重试就放弃。改为在供给等待预算内等待名额，以同一 requestKey 退避重提；额度始终满时以 `hosted-task-quota-exhausted` 明确失败，父任务请求保留、恢复任务即重提；其他拒绝仍立即失败                                                                                                                                                                                                                                                                                                                                    |
| `bb48c1f8b`（`b7bb6efec`） | 托管（PostgreSQL）上任何走到评审门的工作流都以 `scheduler error`「ownerless task mutation refused durable owner」失败（M2 控制流 `01M56TX9…`、最小复现 `01M56XV2…`）：评审门开启不用调度器传来的显式执行上下文、只读环境上下文，而 public participants 导出的环境上下文查询是 SQLite 兼容包装，凡不带 SQLite legacy 连接的上下文（即 PostgreSQL daemon 的全部上下文）一律被它隐藏，停靠于是按无主写处理、被任务自己的 claimed owner 拒绝；单机 SQLite（源码与编译版）均不现。评审门改为先用显式上下文（显式 > 环境 > 无主），public 查询改为中立实现（同一缺陷也落在反问停靠的回退与隔离区清理的 effect 回执上）。另：反问在任务其他分支仍运行时被回答，PostgreSQL 的门续跑 worker 每秒认领一次、每次 owner 冲突记一条 WARN（实测约 1080 条），改为本进程 driver 释放后再认领（与 SQLite 同） |
| `b7bb6efec`                | 上一行把 public 环境上下文查询改为中立实现后，PostgreSQL 的上下文也到了 `discardNodeIso`：隔离区清理回执先占画布的 `workspace:` 围栏、再等任务写窗口，与 merge-back／建隔离区（先写窗口、后围栏）的顺序相反；托管上每步是数秒的卷内命令，M2 控制流因此死锁（merge-back 持写窗口等围栏、`read_upload` 停在 `pending-merge`，清理持围栏等写窗口、effect attempt 停在 `acting`）。清理回执恢复为只记 SQLite daemon 的上下文（`bb48c1f8b` 之前的行为），围栏挪进写窗口需清理自己持有写窗口，留作两种工作区实现的后续                                                                                                                                                                                                                                                                              |
| `f6f8d1fcc`                | CS 事件投递到 AW 一律 401 `invalid-event-source-token`（8 次后进死信），同一 push 其他订阅方都收到：CS 网关对平台调用方的目标按服务域主机命名，来源令牌 aud 是 `service:platform-caller:<service>.<domain>`（CS `modules/gateway/domain/allowlistEvaluation.ts:21`），AW 只认业务调用方用的 `service:<project>/<service>`。改为同一服务的两种 aud 都接受，签名、平台 kind、`platform` 项目与 `cs-events` subject 仍必须相符                                                                                                                                                                                                                                                                                                                                                                   |
| `a70504206`                | 托管任务删除后工作卷不回收：AW 建父任务用 CS 的 `legacy` 完成策略，关闭只释放容器、持久卷一直保留；项目 PVC 配额（20）用满后新任务全部在第一个节点前失败（`hosted-workspace-unavailable`「容器不存在」，CS 启动 `queue` 阶段 `pod-missing`：控制器一直等配额不放行的 PVC）。父任务改为 `archive-and-delete`（CS RFC-035），删除时经 `POST /v3/business-tasks/:id/finalize`（无归档产物：AW 的任务结果在自己的库与对象里）终结，平台停算力并删卷；此前建的 `legacy` 父任务沿用原生命周期（CS 拒绝终结它们，关闭后卷留给管理员回收）                                                                                                                                                                                                                                                            |
| `b224e0342`                | 托管运行时探测：首次探测 `oc-glm` 即 409 `runtime-probe-stale`（运行时并未被改），重试又以 `model-call-failed: timed out after 60000ms` 结束。探测目标按平台 Agent 档案能力求摘要，目标取自上次刷新时的副本、冒烟又先刷新，回执比对的两份不同；CS 实时解析档案（他项目改计算档案或重测能力即变），故任何平台档案变动后的第一次探测必败。驱动端口加可选 `prepareProbe`，已登记探测捕获目标前托管驱动先刷新能力（冒烟期间的真实变动仍报 stale）。托管冒烟还包含平台准入与 Agent 容器启动（实测 10～15 秒），超出单机 60 秒预算：托管冒烟改用 180 秒，低于探测请求所等待的 HTTP 255 秒空闲超时                                                                                                                                                                                                   |
| `96f8d8977`                | 托管 MCP 探测：本地 stdio MCP `m2-local`（`node -e …`）82 毫秒内 `connect-failed: Executable not found in $PATH: "node"`——RFC-030 探测路由在 AW 服务容器里启动服务端，而服务镜像没有 node/npx，也不是托管 Agent 启动 MCP 的地方（§3.3：托管入口不在服务槽本地 spawn）。Resource Catalog 增 `McpProbeRunner` 参与者；托管 MCP 诊断选择把探测作为 `mcp-probe` 命令发到 `system:shared` 临时卷的任务镜像（随运行版本），任务镜像里运行不变的 RFC-030 探测；路由保留准入、新鲜度与持久化，无选择时仍进程内探测（单机不变）                                                                                                                                                                                                                                                                        |
| `20069e91a`                | CS 升级换了 Runner 底座后，任务启动、系统 Agent 与探测一律 HTTP 500：平台以 `412 image_usage_unvalidated` 拒绝创建父任务（任务镜像的验证随 Runner 合同摘要失效，见上文），AW 把原始拒绝当作内部错误。父任务创建把该拒绝映射为 `hosted-task-image-unvalidated`（503，说明须由运维重新验证任务镜像版本，或发布以当前底座构建的任务镜像），立即失败、不按额度等待，父任务请求保留，重新验证后同一任务可直接重试                                                                                                                                                                                                                                                                                                                                                                                  |
| `b8e5af2a0`                | 已完成任务 `01M5634T53TYTZVM2RPZTD4439` 的 CS 父任务容器失效（`容器不存在`，卷完好）后，查看其文件一律 503 `hosted-workspace-unavailable`「从 CS 恢复页重建工作区，然后恢复本任务」；CS 对该父任务提供 `rebuild-workspace`，但 AW 恢复消费者对已完成任务一律以 `recovery-task-finished` 拒绝，文件从此不可读。已完成任务保留暂停的父任务正是为了文件可浏览（V3），失效容器的卷只有重建后才能再访问：`rebuild-workspace` 改为不论任务状态都受理，平台重建后只对可恢复的任务执行恢复，空闲父任务照常再暂停；`resume-task` 仍拒绝不可恢复的任务（含已完成）。不可用提示不再要求恢复已完成的任务                                                                                                                                                                                                  |
| `96275f186`                | 切到 v0.6.22 后的第一次运行时探测 300 秒后 504 `hosted-workspace-provisioning-timeout: … still closing`：被新版本取代的 `system:shared` 父任务（archive-and-delete）替换时，AW 先终结旧父任务、再在供给预算内等它物理释放，而 CS 用了约 8 分钟才终结完（卷早已删除，状态停在 `finalizing`／`releasing`）——每次切流后 scratch owner（探测、意图、记忆蒸馏）的第一次使用都可能超时。平台受理关闭后旧父任务的释放归平台：替换只等受理，随即为新版本重新登记父任务；任务删除与生命周期对账仍等物理释放。替换还只退役它读到的那一代登记（按 request key）：此前一次使用决定替换、却在另一并发使用已重新登记之后才去关闭，会关掉对方的新父任务；`allocate` 也不再把父任务记到已按别的 key 重新登记的行上                                                                                            |
| `9f2f48d42`、`293c1951f`   | 发布到新建的 RFC-042 验收项目时 `publication-target-source-provenance-missing`：v3 的发布脚本只做相对上次 AW 发布的增量，从 CS 模板新建的项目没有上次发布，模板文件（`Dockerfile`、`crewstation.yaml`、`package.json`…）又与 AW 路径重名，新安装永远发布不了。`--adopt-existing` 让第一次发布以分支现有文件为基线：AW 快照替换同名文件、删除其余模板文件，提交记下来源，之后照常增量。随后整个快照（9,553 个动作、208 MiB base64）作为一次 Commits API 请求被 GitLab 以 400 拒绝：大发布改为按 500 个动作或 8 MiB 分批提交，只有最后一批记下新来源，之前各批仍记上次的来源，中断后可按增量续发（已删除的文件不再误报为受管文件被改）                                                                                                                                                          |
| `fde903d3a`                | 在单节点满载的 RFC-042 独立服务上，三次启动在工作区准备阶段以 `hosted-workspace-provisioning-timeout` 失败。启动先准备工作区、后插入任务行，失败后任务行不存在，CS 父任务却留下：两个 failed（卷等待绑定）、一个仍在准入（额度空出后会为不存在的任务起容器）——补偿只清卷内文件（托管 scratch 清理还会再次唤醒父任务、让错误再晚最多 5 分钟返回），生命周期对账又跳过没有父任务回执的登记，无人关闭它们。两种启动补偿（scratch 与预物化仓库）在证明任务未受理后释放平台工作区（经 scratch 工作区效果的 `releaseUnadmitted`，单机无事可做），先于记为 `cleaned`；`abandon` 先记下关闭意图（`closing`）再尝试一次，对账也重试没有父任务回执的 `closing` 登记；关闭从不等额度（同键重放仍在准入即稍后再判，镜像未验证的拒绝即没有父任务）；托管 scratch 清理不再碰将被释放的卷                    |

**CI 归因（2026-10-18）**：`b224e0342` 的 CI `39126009136` 只在后端分片 21 红：`RFC-359 W6-T28 L6`（PostgreSQL 并发删兄弟任务）的维护认领转移遇 `40001` 序列化冲突、用例的写锁等待超时——与该提交（运行时探测）无关，同一用例在前后各次运行（含 `96f8d8977`）均通过，归属不明、未认领，失败日志保留。`96f8d8977` 的 CI `39127482168` 红在两条守卫（公共面 ratchet、跳过策略），均为该提交所致，`869d59180` 修复。`869d59180` 的 CI `39128987961` 只有 Playwright e2e macOS 分片 3/3 红：`workgroup-matrix.spec.ts:270` 首次尝试「等待 daemon 就绪行 30 秒超时」、重试断言失败；该提交只改 MCP 探测的类型与命名，`96f8d8977` 上同一 e2e 各分片全部通过，判为运行器启动抖动，未认领；以后继提交的 CI 作证据。`dccb41909` 的 CI `39134101208`、`20069e91a` 的 `39138974893`、`c704aee79` 的 `39140349016` 全部成功。`b8e5af2a0` 的 CI `39140807563` 只有 Playwright e2e Windows 分片 3/4 红：`task-lifecycle-states.spec.ts:479`「done（快速桩）」首次与重试都在 30 秒内仍为 running，守护进程日志有 1.4～2.4 秒的事件循环停顿与 1.6 秒的慢查询；该提交只改托管恢复消费者与托管工作区提示，单机守护进程不装配这两处，紧邻的前两次运行同一分片通过，判为 Windows 运行器缓慢，未认领；以后继提交的 CI 作证据。

**发布**（服务槽蓝绿交替，项目仓库镜像提交略）：

| 版本    | 发布 id      | AW 提交     | 任务镜像版本                             | 结果                                                            |
| ------- | ------------ | ----------- | ---------------------------------------- | --------------------------------------------------------------- |
| v0.6.0  | `01a148c2-…` | `04072a0ff` | `01a148b6-1518-…`（`04072a0ff`）         | failed：服务镜像 apt `500 … unexpected EOF`（`b864cd42a` 前）   |
| v0.6.1  | `01a148ce-…` | `b864cd42a` | 同上                                     | failed：新槽待命崩溃循环，未就绪（`4163865a8` 前）              |
| v0.6.2  | `01a148fb-…` | `2b5b8f9c5` | 同上                                     | ready                                                           |
| v0.6.3  | `01a14935-…` | `dfe075c27` | 同上                                     | ready                                                           |
| v0.6.4  | `01a14942-…` | `d63e57110` | 同上                                     | failed：平台 buildkitd 被 OOMKilled（4 Gi）                     |
| v0.6.5  | `01a14944-…` | `d63e57110` | 同上                                     | ready                                                           |
| v0.6.6  | `01a14a2d-…` | `1cc89ee66` | `01a14a2a-8d06-…`（`1cc89ee66`）         | ready                                                           |
| v0.6.7  | `01a14a4d-…` | `a1f35c48b` | `01a14a49-cd34-…`（`a1f35c48b`）         | ready                                                           |
| v0.6.8  | `01a14a6c-…` | `c06f28af3` | `01a14a6b-2610-…`（`c06f28af3`）         | ready                                                           |
| v0.6.9  | `01a14c2c-…` | `2dc736b57` | `01a14a99-0a8a-…`（`2dc736b57`）         | ready；M1 代表性工作流通过                                      |
| v0.6.10 | `01a14c42-…` | `b76a88e70` | `01a14c3e-1609-…`（`b76a88e70`，装配）   | ready；交接验收的目标版本                                       |
| v0.6.11 | `01a14c8c-…` | `47d0379a2` | `01a14c8a-798a-…`（`ebad918a4`，装配）   | failed：平台 buildkitd 健康检查超时被重启（CPU 争用），构建中断 |
| v0.6.12 | `01a14c90-…` | `36f907078` | 同上                                     | ready；M2 材料验收通过；交接恢复暴露 `2a70c9328` 的缺陷         |
| v0.6.13 | `01a14d7e-…` | `1fd8a131c` | `01a14d79-f0d5-…`（`e2cb7cf49`，装配）   | ready；交接复验的旧实例                                         |
| v0.6.14 | `01a14d88-…` | `3a81b7551` | 同上                                     | ready；交接复验的新实例，现为生产                               |
| v0.6.15 | `01a14db0-…` | `19ad368d1` | 同上                                     | failed：迁移 Job 超出截止时间（单节点 CPU 满载，Pod 未调度）    |
| v0.6.16 | `01a14e10-…` | `bb48c1f8b` | 同上                                     | ready；评审门修复，切流时为生产（epoch 30）                     |
| v0.6.17 | `01a14e33-…` | `b7bb6efec` | 同上                                     | failed：平台 buildkitd 被 OOMKilled（4 Gi），构建中断           |
| v0.6.18 | `01a14e38-…` | `b7bb6efec` | 同上                                     | ready；首个带事件订阅的版本，接管验收的目标版本（epoch 32）     |
| v0.6.19 | `01a14e87-…` | `a70504206` | 同上                                     | ready；父任务 archive-and-delete，现为生产（epoch 34）          |
| v0.6.20 | `01a14f7b-…` | `dccb41909` | `01a14f10-db5d-…`（`96f8d8977`，装配）   | failed：CS 升级后任务镜像验证失效（见上文），重新验证前发布     |
| v0.6.21 | `01a14f80-…` | `dccb41909` | 同上                                     | ready（preview），未切流；被 v0.6.22 取代                       |
| v0.6.22 | `01a1517e-…` | `821acaa3b` | `01a14fc6-95a1-…`（`20069e91a`，新底座） | ready；2026-10-19 00:12 切流（用户授权），回退演练中被回退      |
| v0.6.23 | `01a151b2-…` | `cd897613d` | 同上                                     | ready；回退演练的向前一步（01:14 由 v0.6.19 切入），现为生产    |

**M1 验收**（工作流 `rfc370-m1-acceptance`：git 包装器内 opencode Agent 改两个文件 → 脚本节点用 bash / node / python3 / git 汇报 → 自动提交推送到本机 GitLab 项目 550 的工作分支；模型走缺省 Agent 档案 `aw-default`）：

- 失败的轮次逐次暴露上表缺陷：`01M5532785…`（v0.6.6，`8f924c294` 前）→ `01M555ABC0…`（v0.6.7，`a8d3c481b` 前）→ `01M5576SXH…`（v0.6.8，任务 done、`count` 的提交推送推上 `cb50a11e`，但 git 包装器的提交推送撞上 `7e7e3606b` 的竞态）。
- **通过**：`01M5634T53TYTZVM2RPZTD4439`（v0.6.9）：`__repo_prep__` → `snap`（含 `writer`，约 4.5 分钟）→ `count` → `__commit_push__:snap` 全部 done，推上 `aw-m1-20261017g` 的 `3ef38549`；`count` 正好在提交推送的提交信息生成窗口内 merge-back，修复后提交仍是完整的那一笔，不再出现第二次提交推送。
- **与单机一致**：同一提交的源码以单机形态（SQLite、本机 opencode `火山AI网关/deepseek-v4-flash`、本地镜像仓库）跑同一工作流 `01M5634TF9DC69BVYZT4ERQ5WB`：节点序列与状态一致，`git_diff`（`NOTES.md`、`src/greeting.js`）与脚本报告逐字相同（仅 Python 版本 3.13.5 / 3.10.5 不同），同样一笔提交。单机的推送因临时 Git 端点不是已配置的代码托管（`repository-http-endpoint-unresolved`）未执行，属对照环境限制。修复前两边（`01M5576SXH…` / `01M5576T2S…`）复现的是同一个提交推送竞态。
- **取消**：`01M56461H3AYN1DP6FF5KWHMAP`（v0.6.9）在 `writer` 的 CS Agent 子任务运行时取消：5 秒内任务 `canceled`、`writer` / `snap` 为 `canceled-by-user`，Agent 子任务释放（Pod 消失），父任务在 120 秒宽限后暂停、工作卷保留。取消后调度器曾尝试重试 `writer` 的隔离区，被任务围栏挡下（`mutation was fenced`），终态不受影响。
- **服务交接（重启）**：`01M565645BNZ5SM15S55MRSNXT` 在 v0.6.9 上运行到 `__commit_push__:snap` 时切流到 v0.6.10：旧实例失权 detach（不发 CS cancel）并以 1 退出重启，新实例 epoch 22 取得执行权；运行中的提交推送被标 `interrupted`，任务 `interrupted`（与单机守护进程重启一致，自动修复未开启时不自动续跑）。用户恢复被上表 `ebad918a4` 的缺陷拒绝，修复部署后复验。v0.6.12 上恢复被接受，但任务以 `scheduler stalled; failed parked: count` 失败：旧实例失权后仍把交接时正在 merge-back 的 `count` 写成 `merge-failed`（只读查库：`count` 无任何合回 effect、卷内快照命令由新实例对账为成功），提交推送也不会再被触发——即上表 `2a70c9328`，修复后在新版本上复验。
- **服务交接复验通过**（v0.6.13 → v0.6.14）：`01M56RRG6A0F7KP5N1JXJ9FNNF` 在 `count` 的 merge-back 快照进行中（`done`／`isolating`）、git 包装器的提交推送已开始时切流。旧实例失权后写库全部被拒（日志中连关机时的会话收尾都以 `HostedExecutionLeaseLostError` 被拒），`count` 停在 `done`／`isolating`、隔离区保留，提交推送 `interrupted`，任务 `interrupted`——与单机在该时刻崩溃一致。用户恢复后 `count` 从保留的隔离区快照并合回（不重跑），被打断的提交推送重跑一次，推上 `3ec42914`（`NOTES.md`、`src/greeting.js`）到 `aw-m1-handoff-20261017i`，任务 done。

- **回退演练（AC07，用户授权）**：2026-10-19 00:12 切流 v0.6.19 → v0.6.22（新底座任务镜像）；00:48:33 回退到仍在另一槽的 v0.6.19（CS 200）。v0.6.22 实例失权后以 1 退出、作为待命槽重启；v0.6.19 实例 57 秒内取得执行权（其间发起任务返回 503「本实例暂不执行任务」），随后启动的任务 `01M58T4429TKF2PEFX4E1D2CX8` done。01:14:24 向前切到 v0.6.23（CS 200）：v0.6.19 实例失权后以 1 退出重启，切流后约 11 秒内网关对新槽短暂返回 503「no available server」，随后 v0.6.23 取得执行权并完成运行时探测（见 M2）。

- **接管通过（无需用户操作）**（v0.6.16 → v0.6.18）：`01M573PVYFDZZNRS2E4GPTPQQK` 在 `writer` 的 CS Agent 子任务流式输出时切流（绑定 `running`、带游标、epoch 30）。任务 `interrupted` → `pending` → `running` 约 50 秒内自动恢复，新实例（epoch 32）按原运行 id 接管同一个 Agent 子任务（绑定仍是 attempt 1，没有第二次 writer 执行），`writer` → `count` → 提交推送依次完成，推上 `489835c3` 到 `aw-m1-handoff-20261018a`，任务 done；三条执行绑定均在 epoch 32 下结算。
  **M2 验收**：

- **材料（技能 / MCP / 跨模型子 Agent）通过**：工作流 `rfc370-m2-materials` 的主 Agent `m2-lead` 走 `oc-glm` 运行时（`火山AI网关/glm-5.2`），挂托管技能 `m2-token-skill`、远程 MCP `m2-nonce`（本机 47813 端口的 nonce 服务，Pod 经 `host.docker.internal` 访问）与 dependsOn 子 Agent `m2-helper`（`oc-deepseek`：`opencode-go/deepseek-v4.1-flash`）。v0.6.12 上的 `01M5698XA6Q9AGV9ZKDM9W0XHX` done：三个端口逐字等于各自 nonce（`SKILL-716ac6ab` / `MCP-96841e4b` / `HELPER-b1927b8c`）；启动清单 verified（`m2-nonce` connected、`m2-helper` injected）；MCP 服务端记到一次 `tools/call m2_nonce`；CS 的用量快照按模型分列 `火山AI网关/glm-5.2` 与 `opencode-go/deepseek-v4.1-flash`——CS RFC-040 的跨模型子 Agent 委派在同一个 Agent 子任务内成立。Agent 子任务从创建到会话开始约 6 分钟，耗在平台侧（原因未归因），不影响结果。
- **控制流通过，与单机一致**（v0.6.19）：工作流 `rfc370-m2-control`（上传文件输入、git 包装器内 loop、失败重试后复活的脚本、fan-out 两个 Agent 分片与聚合、反问门、评审门）。托管任务 `01M5798CMMH92MAD2405HFTXXK` 首轮停在 `clarifier#1`：其 Agent 子任务被上表 CS 缺陷三搁置，30 分钟后以 `cancelled-before-start` 失败；CS 修复部署后，经平台恢复动作 `resume-task` 续跑（见 M3），`clarifier#2` done，评审门在 PostgreSQL 上停靠（`bb48c1f8b` 修复的路径）并在批准后继续，任务 done。终态与单机对照 `01M56T6ETHMS3EPZ7W2NMA3N0E`（SQLite 守护进程、同一提交源码）逐端口相同：`final_output` 的 `answer` = `The report uses **red**.`、`changed` = `NOTES.md` / `README.md`、`final_count` = `2`、`first_line` = `# Alpha attachment`、`flaky` = `recovered`；聚合 `NOTES.md:ok` / `README.md:ok`；评审 `approved_doc` 同上，`approval_meta` 仅 `decidedAt` 不同。节点序列相同（`flaky` 四次失败后复活），差别只有托管多出的那次被缺陷打断的 `clarifier` 尝试。
- **系统 Agent：意图与 MCP 运行时测试通过**（v0.6.19）：意图会话 `01M57H3NV1A83WXQGG878VVHEQ`（「建一个只用一句话回答 Git 问题、不需要工具的 Agent `rfc370-intent-probe`」）在 `system:shared` 工作区由托管系统 Agent 生成，草稿 1 `review-ready`（1 个资源、0 阻断错误），提交后应用 1 个创建操作（Agent `01M57HFDPVZVJFHC0YMXVXN0NN`）。MCP 运行时测试会话 `01M57FTGZH07YPAA6XE5Q3PQTW`（`m2-local` × `oc-glm`，在独立 `mcp-test:` 父任务里）原生会话就绪，回合 succeeded（约 228 秒）：模型调用 `m2-local_m2_local_token` 并回复工具结果（CS 秘密掩码为 `***`）。托管运行时冒烟与 MCP 探测发现两处 AW 缺陷（上表 `b224e0342`、`96f8d8977`），待新版本复验。
- **内容对象通过**（v0.6.19）：工作流 `rfc370-m4-artifacts2`（脚本节点写文件，Agent `m4-reporter`（`oc-deepseek`）在 `path<md>` / `path<png>` 端口报告路径）。任务 `01M57HARN763TXPXWFHG83NMJ3` done，两个端口产物在 emit 时归档为 `task-artifact` 发布（对象 `01a14f1b-2a84-…` 18 字节、`01a14f1b-7268-…` 70 字节），经 `/api/tasks/:id/port-artifacts/:nodeRunId/:port` 下载：元数据 `source: archive`、MIME `text/markdown` / `image/png`，字节的 SHA-256 与 Agent 实际写入的内容逐字节相同（`b27db49e…` / `43be52f9…`，PNG 含 NUL）。注：脚本节点缺省只读、写入不合回，Agent 没找到文件便自己写了一份——验收比对的是它实际写入的字节，结论不变。删除任务后父任务立即 `closed`（工作卷随 archive-and-delete 终结回收）；对象发布按设计由 Task Execution 的对象清扫在 24 小时启动宽限期后释放（启动前可能已保留输入文件，`HOSTED_TASK_OBJECT_GRACE_MS`；已删除任务的释放由 `rfc370-task-object-sweep.test.ts` 双引擎覆盖），删除后 7 分钟仍为 `ready` 属预期。
- **调用子工作流 / 工作组通过，与单机一致**（v0.6.19）：工作流 `rfc370-m2-call`（`call-workflow` 调用脚本子工作流 `rfc370-m2-child`，`call-workgroup` 调用单成员工作组 `rfc370-m2-wg`）。托管任务 `01M57JQ9Z4BFHH4JW9TCJD5X0Q` done，两个子任务（`01M57JTT1E…` / `01M57JSVQ2…`）各自 done；`child_report` = `child saw: blue-green handoff` 与单机对照 `01M578KXDZS313DTDYJFAJ4BK7` 逐字相同，`group_result` 两边都是对主题的一句话说明（模型输出，托管遵守了 `WG:` 前缀）。
- **真实浏览器用户流程通过**（v0.6.19，AC11）：Playwright 无头 Chromium 带 CS 平台会话 Cookie 经网关打开 AW：`/api/whoami` 映射为 AW 用户 `dev-admin`（admin，`source: session`）；代理 / 工作流 / MCP / 任务页渲染无错误横幅、控制台 0 错误；任务向导「Agent `rfc370-intent-probe` + 临时空间」启动任务 `01M57MX14VK84VWBCGPE8FB7NH`，完成页显示「已完成」与工作流状态图，`answer` = 对 `git status` 的一句话说明。托管启动接口要等平台为任务建好父任务与工作卷才返回（实测约 39 秒，额度满时最长等到 300 秒供给预算），期间向导按钮显示「启动中…」，超时则按任务名对账未知结果——记为体验特性。
- **运行时探测与 MCP 探测（v0.6.22 复验）**：MCP 探测 `m2-local` 在任务镜像内运行，10 秒内 `status: ok`（握手 1.6 秒，`serverInfo` 与工具 `m2_local_token` 列出；`partial` 只因内联测试服务端未实现 resources / prompts 列表），即上表 `96f8d8977` 的修复。运行时探测 `oc-glm` 不再报 `runtime-probe-stale`（`b224e0342`）：Agent 子任务 exit 0 并回显随机标记（`sawNonce: true`、会话已捕获），但本机这一轮用了 166 秒，加上约 43 秒的工作区供给，结果比固定的 180 秒轮次预算晚 3 秒到达，报 `model-call-failed: timed out`——由上表 `cd897613d` 改为整个探测请求共用一个截止时间。**v0.6.23 复验通过**：切流后第一次探测 `conforms: true`（opencode 协议、会话已捕获、随机标记回显），总耗时 225 秒，在 240 秒预算内；这次探测同时是切流后 scratch owner 的第一次使用——新的 `system:shared` 父任务 `01a151b9-…` 在 01:14:59 探测开始时即创建，被取代的 v0.6.22 父任务 `01a15191-…` 由平台在 01:16:41 才终结完，替换没有等它（上表 `96275f186`）。切流后第一次探测还撞上 `96275f186` 的缺陷（旧 `system:shared` 父任务终结约 8 分钟）。
- **工具调用显示通过**（CS `02b66a22` 部署后）：任务 `01M57RVYMS1S6BDJM4MR5F5WWB`（`m2-helper`，`oc-deepseek`）让 Agent 用 bash 执行 `echo tool-end-$((6*7))`：节点会话树中该工具调用为 `completed`，带输入与输出 `tool-end-42`，v0.6.19（生产）与 v0.6.21（预览槽）的会话接口一致；v0.6.21 预览槽在真实浏览器中渲染为「工具调用 bash 已完成 … 工具返回 tool-end-42」，并显示待机横幅（待机实例的 `worktree-tree` 返回 503，属预期）。此前每个 OpenCode 工具都显示为运行中、无输出（CS RFC-040 的业务投影缺陷，见 CS 验收记录）。
- **本地 MCP / Git 插件 / 权限通过**（v0.6.19）：工作流 `rfc370-m2-materials2` 的主 Agent `m2-lead2`（`oc-glm`）挂本地 stdio MCP `m2-local`（`node -e` 内联服务，env `M2_LOCAL_TOKEN`）、Git 插件 `rfc370-m2-plugin`（`git+…aw-rfc370-acceptance.git#aw-m2-plugin`，经托管 plugin-installation 命令安装，`resolvedVersion e990bf1ab681`）与权限 `bash: deny`。`01M57CSZ2BS5YAVZJ7A2PAJS9Q` done：`plugin_token` = `PLUGIN-9873d72f`（插件的 system transform 生效）；`plugin_observation` = `bash=deny`（插件 `config` 钩子看到编译后的 Agent 权限）；`bash_probe` = `denied`（模型工具清单中无 bash）；`local_token` 为 `***`——事件中模型调用了 `m2_local_token`，工具返回的是 MCP env 里的值，CS 公共事件把秘密叶值替换为 `***`（与 CS RFC-040 options nonce 的处理相同），故端口值为掩码。启动清单 verified：`m2-local` connected（injected）。

**M3 验收**：

- **事件入站通过**（v0.6.19）：本机 GitLab 项目 550 新建分支 `aw-m3-evt2-20261018a`（`a8d24426`）→ GitLab webhook → 中继（GitLab 容器解析不到 CS 服务域，中继按原字节转发到宿主网关的 `gitlab-event-producer.svc.cs.internal/hooks/gitlab`）→ 生产方 202（`gitlab.push`）→ cs-events → AW 订阅 `/integrations/crewstation/events`（首次投递即 `delivered`；此前一律 401，即上表 `f6f8d1fcc`）→ `cs_event_inbox` → 路由与冻结目标 → webhook 投递 `matched` → 触发器 `rfc370-m3-push-v2` 以 scratch 空间启动任务 `01M5792FXWFSRTRK2T8R2BC4CY` → 脚本报告 `push aw-m3-evt2-20261018a @ a8d24426…`（分支与提交 SHA 由模板映射）→ done。分支过滤之外的 push（M1 的提交推送）被记录、不触发。
- **任务删除与资源释放通过**（v0.6.19）：上一任务的父任务以 `archive-and-delete` 创建；删除任务后 35 秒内 PVC 消失，CS 任务「执行容器已停止，任务正在归档与回收工作卷」——即上表 `a70504206`。此前版本的 `legacy` 父任务删除后卷保留：删除 10 个旧验收任务后，其卷在 CS 资源中心成为「待回收」，经「删除工作卷」回收（项目 PVC 20/20 → 5/20）。
- **平台恢复动作通过**（v0.6.19，CS `621e6183`）：对上述失败任务的父任务 `01a14e94-3366-…` 在 CS 发起 `resume-task`（评估摘要 + `requestKey: rfc370-m2c-resume-20261018a`，CS 202）。AW 恢复消费者认领后由平台恢复容器（原卷 UID `b2d0fb21-…`，操作 `01a14eef-5ec6-…`），再以请求者身份调用 AW 的普通恢复命令：请求 21 秒内 `succeeded`，任务 `failed` → `running`，失败节点续跑至 done（见 M2 控制流）。
- **重建工作区通过**（v0.6.22，`b8e5af2a0`）：已完成任务 `01M5634T53TYTZVM2RPZTD4439` 的父任务 `01a14c32-…` 容器失效（`容器不存在`），查看文件 503；CS 评估给出 `rebuild-workspace`（原卷 `561e50fb-…`），请求 `rfc370-rebuild-done-20261019a`（CS 202）24 秒内 `succeeded`（操作 `01a1519d-16da-…`），父任务 `creating` → `running/ready`（世代 3），任务保持 `done`、未被续跑，文件树重新可读（`scripts/`、`src/`、`NOTES.md`、`README.md`）；空闲约 4 分钟后生命周期对账把父任务再次暂停（00:48）。
- **API 自动化通过**（v0.6.14）：同一 CS 用户（平台管理员会话）签发只读 PAT（`scopes: []`；读权限对 PAT 恒隐含，可勾选的只有写权限点）。CS 会话 + PAT 调 `/api/whoami` 为 PAT 身份（`source: pat`、同一 AW 用户），读接口 200、越权写 403；无效 PAT、只带 PAT（无 CS 会话）、只带 CS 会话调 `/api/mcp` 均 401；CS 会话 + PAT 的 MCP `initialize` 200；撤销后 401。
- **系统 Agent（记忆蒸馏）**：v0.6.12 起的 5 个蒸馏作业全部 done（此前在早期版本创建的共享 scratch 父任务里全部失败，见上表 `05ca7e200`）；切流到 v0.6.13 后，v0.6.12 时期的 `system:shared` 父任务在空闲时被关闭，新作业在新版本的父任务中运行。
- **数据库恢复（CS RFC-042）第一次尝试**（独立服务 `rfc042-aw-restore`，v0.2.1，用户授权）：备份 `0b0231de-…`（87 KB，含 Agent `rfc042-before` 与已完成任务；之后另建 Agent `rfc042-after`）→ 恢复操作 `01a15218-55e8-…` 建出独立空目标 `01a15218-563f-…`。依次撞上 CS 缺陷四（探针占用当成平台拒绝）、CS 缺陷五（恢复 Job 过不了创建准入）与存储探针单车道被测量占满（CS `1e5ae7c6` 起观测与测量分车道），修复部署后：恢复 Job 100 秒、校验 Job 84 秒成功，归一结果 `frozenControl 1 / adoptedBackups 1 / cancelledBindings 1`（卡住的记忆蒸馏绑定按 restored 结算，无非终态任务），校验回执 `complete: true`、`autoResumeSuspended: true`、schema `sha256:be5ad8b0…`，进入 `ready-to-switch`；切换请求在探针被测量占用时 12 次 `412 native_postgres_source_busy` 后第 13 次被受理。之后停在 `freezing` 半小时、无任何提示：CS 屏障要求服务的业务执行环境全部暂停，旧版本已确认冻结（停写），却从不停止自己仍在运行的 `system:shared` 父任务——CS RFC-027 把冻结的 stop authority 交给确认冻结的原正式发布来排空写者，AW 只实现了停写确认（上表 `6cc092152`）；另有两个启动前失败的孤儿父任务也被屏障当成写者（CS 缺陷六）。按设计放弃该操作（`abandoned`，revision 443）：维护与屏障撤除，原发布 16 秒内重新取得执行权，生产绑定仍是原世代（revision 1），目标世代 `retained` 供核对。修复上线后以同一备份重做（见下一条）。
- **数据库恢复（CS RFC-042）第二次尝试通过**（独立服务 `rfc042-aw-restore`，`v0.2.3` = AW `0c266dbcc`，含 V14 写者排空）。
  - 恢复：以同一备份（`0b0231de-…`）建恢复操作 `01a15487-c618-…`，目标世代 `01a15487-c658-…`。恢复 Job 与校验 Job 都成功（恢复约 2 分钟），校验回执 `complete: true`、`autoResumeSuspended: true`，schema `sha256:be5ad8b0…`。
  - 切换：请求一次受理（无 412），`freezing` 只停留约 15 秒（第一次尝试在此停了半小时），之后 `deploying` → `switching`，14:25:26 `completed`。
  - 恢复后的数据：Agent `rfc042-before` 在、`rfc042-after`（备份之后创建）不在，已完成任务保持 `done`。
  - 世代：生产库资源的原世代 `01a14f55-5d79-…` 与第一次尝试的目标世代 `01a15218-563f-…` 均为 `retained`，新世代 `01a15487-c658-…` 为 `active`，开发环境数据库世代不受影响。
  - 发布槽：生产槽为 `v0.2.3+restore.01a15487…`（ready），预览槽保留恢复前的 `v0.2.3`。

## P1 单机统一

范围按 v2 §3.2 与 §5（执行端口重塑移到 M1 开头）：

- 新增执行权端口 `ExecutionAuthorityPort`（`system-operations/application/ports/executionAuthority.ts`）与单机实现（启动即 active、epoch 1、永不丢失），两个 daemon 根在 bootstrap 处传入；`GET /api/execution/status` 返回 `{ mode, state, reason }`；声明了 `executionGroup` 的路由在实例非 active 时返回 503 `execution-standby`，HTTP 与 MCP 绑定调用同一道门。前端 `useExecutionAvailability` 只在 `crewstation` 且非 active 时禁用执行入口，并显示待机 / 冻结横幅。
- 删除 v1 的 host 执行平行路径与“原执行恢复”机制（清单见 v2 §3.2「P1 实际删除范围」），恢复相关端点与前端按钮一并删除；SQLite `0257` / PostgreSQL `0033` 删除 `system_host_execution_write_contexts` 与 `memory_distill_execution_receipts` 两张表。
- 做法：按提交历史逐文件判定，只被 H7 提交改过的文件整文件回到 H7 之前的版本，与 RFC-371 v2 / RFC-372 等交织的文件逐段三方回退；只验证平行路径的测试删除，依赖 RFC-370 逆变换链的根源码 oracle 退役。

P1 是一次整体删除（约 7.3 万行），拆开的中间态无法编译，故为单个源码提交。

本地集中验证：三包 tsc、eslint（含 promises）/ prettier、depcheck 通过；shared 全量 2323 项；frontend 全量 854 个文件 7183 项；backend（SQLite）全量 8 分片，除本机 Bun 1.3.13 的 22 项 affected-rows（CI 为 1.4.3）外，负载超时单独复跑全过，唯一真失败 `rfc213-dev-startup-root-inverse`（仍断言 H7 的 `hostExecutionRuntime`）已修；架构守卫 858 项全过。

提交：源码 `099ce7a85`；架构配套 `c6c1d0118`（唯一增长 `rfc294-required-port-liveness` 40→41，一次性 allowGrowth）；首轮 CI 修复 `bd8432e20`（一处格式；windows-latest 的 Git for Windows 改装在 `ucrt64\bin\git.exe`，bash 推导补 `ucrt64` / `clang64` / `clangarm64` 三个中间目录及回归用例）；`a5ae4b5b7` 投影并退役许可。

CI（`a5ae4b5b7`）：主 CI `38670196680`、windows-platform `38670196656`、postgresql-evidence `38681079138`（small）、backend-macos-nightly `38681088676`、e2e-webkit-nightly `38681085745` 均 success。e2e-full-nightly `38681082449` 的 shard 1/4 在 `centralized-answer-pane` 两次都只等到 1 个待答轮次：根因是既有的同波兄弟人工门停靠竞态（10-12 / 10-13 的 `cross-clarify-multi-source` 已有同形偶发，与 P1 无关），由 `3bbac78ee` 修复（配套 `e4b5adcc5`，见 RFC-333 design.md 2026-10-15 勘误）；`e4b5adcc5` 上主 CI `38688049980` 与 e2e-full `38688106226`（四片 + 覆盖账本对账）success。

## M0 控制面上线

范围与取舍按 v2 §5.1。实现：

- 部署选择点 `cli/deployment.ts`：`AW_DEPLOYMENT_MODE` 显式选择（缺省单机，其他值拒绝启动）；托管必需环境变量缺失时逐项列出并拒绝启动（`docs/env-flags.md` 登记）。`start` 与 `migrate` 两条命令共用既有序列，只换适配器；托管不做 git 与运行时二进制探测，监听 `0.0.0.0:$PORT`。
- 数据库：迁移 Job 按 PG 历史迁移，全新库从刚迁移的内存 SQLite 一次复制初始行（单事务、按外键顺序、以登录策略单例行判定，复制后策略记为已完成）；服务只校验 schema 为当前版本且本服务世代为活动世代（`verifyPostgresqlSchema`，不一致拒绝启动），世代 `dbg_cs_<sha256(project/service)>`、来源 `hosted-installation`，指向迁移 Job 的安装复制操作 `dbm_cs_<同一哈希>`——Job 在 PG 元数据里幂等登记该操作与活动世代后再复制初始行（否则 PG 世代写入围栏拒绝一切写入；首轮托管 `migrate` 实测撞到，见 `rfc370-m0-hosted-postgresql.integration.test.ts`）。SQLite `0258` / PostgreSQL `0034` 新增 `external_identities`、`application_configuration`、`skill_content_entries` 三表（表数 198 / 活动 192）。
- 配置存 `application_configuration` 单行（数据库连接只读、来自环境变量，补丁改它返回 409 `setting-managed-by-deployment`）；主密钥取 `AW_SECRET_KEY`。
- 身份：校验 `x-cs-identity-token`（JWKS、iss、aud `service:<project>/<service>`、`cs_kind=user`、sub `user:<uuid>`），`external_identities` 映射到 aw 用户，首次访问建最低权限账号（`AW_ADMIN_SUBJECTS` 建为管理员），不按 email 合并；HTTP 与 WebSocket 同判据，停用账号 403。
- 技能文件树存 `skill_content_entries`（在用 / 版本 / 暂存 / 回收站），树摘要与文件版 `hashDir` 共用 `digestSortedTree`；插件安装与资源包应用在托管下返回 503 `hosted-capability-unavailable`（M2 随 CS 原生配置叠加提供）。
- 探针 `/live`、`/ready`（不等待执行权）；执行权恒为 standby（原因 `remote-execution-not-available`），后台任务在首次 active 时启动；失权或激活失败排空后以 1 退出（排空失败也以 1 退出）。
- 前端：页面标记托管形态后走网关会话（不存不发本地令牌、WebSocket 不带令牌、会话失效经网关重载且 30 秒内至多一次），隐藏本地登录 / 引导 / 退出 / 口令与令牌，设置页的数据库 / 认证 / 网络三页在托管下不是页签（URL 按 RFC-198 规范化到 runtime）；待命横幅说明远程执行尚未接入。
- 镜像与发布：`deploy/crewstation/`（Dockerfile、Manifest 模板）与 `scripts/crewstation-publish.ts`（按本地档案渲染 Manifest、推送已提交源码快照，再经平台发布接口发布该提交；切流由项目负责人 `crewstation traffic switch`）。
- 平台身份的呈现：账户菜单显示平台显示名，账户概览写明登录由 CrewStation 平台管理，用户页不提供本地建号与重置密码、每行标为平台账户（`accountCredentialManager` / `accountMenuLabel`）；托管拒绝码有精确中英文案与下一步提示。

已知限制（随后续里程碑解决）：仓库克隆需要 git / 工作区，随 M1；数据库维护 / 备份路由在托管下未做服务端拒绝（设置页已隐藏，备份进对象存储随 M3）。

本地集中验证：三包 tsc、eslint（新增两个发布脚本纳入 `lint:repo-ui` / `format:check:repo-ui`）、`lint:promises`、prettier、depcheck 通过；新增用例 backend 4 个文件、frontend 1 个文件。frontend 全量 855 个文件 7191 项中 2 条源码文本断言随改动修正（设置页隐藏判据收进 `isSettingsTab`，RFC-198 锁的原句不变），相关 6 个文件复跑全过。backend（SQLite）全量 8 分片：本机 Bun 的 22 项 affected-rows 之外，负载超时的 7 个文件单独复跑 44 项全过；守卫逐项修正（PG 执行面裸 `like` 改为精确前缀过滤、树摘要并入 `digestSortedTree`、`AW_*` 变量登记、bootstrap 消费身份 composition 登记、树内路径包含判断、中立事务原语写法、退出请求排空失败的拒绝处理、`/live` `/ready` 契约与 MCP 面豁免）；规范清单对拍、owner 登记表与账本条目数 4 条待提交后由 census 投影转绿。

提交：源码 `8683b5a81`、配套 `ce9edaad9`。本机托管冒烟（真 PostgreSQL 17 + 本地 JWKS 签发器 + 编译版二进制，`AW_DEPLOYMENT_MODE=crewstation`）发现并修复三处，均补回归用例：①托管库没有登记活动世代，PG 世代写入围栏拒绝初始行复制（`515209c95`，配套 `324f3f204`，另把 RFC-349 死锁故障注入改为确定性时序）；②插件与资源包操作合同未声明 `unavailable`，托管拒绝变成 500 合同违规（见下一笔）；③托管 `migrate` 的连接读 `process.env` 而非传入的 env（同 ①）。修复后冒烟全部通过：迁移 Job 首跑安装并复制初始行、重跑幂等；服务的 `/live` `/ready`、页面部署标记、网关身份（管理员 / 最低权限 / 缺失 / 伪造 / 他服务令牌）、执行待命状态与发起任务 503、设置页数据库只读与保存、Agent / 工作流 / 技能（含文件树）/ MCP 的创建、插件安装 503、WebSocket 带 / 不带身份；以全新空 home 重启后数据与身份映射全部仍在。

本机 CS 部署验收（2026-10-15，通过）：docker-desktop kind 上的本机 CrewStation，项目 `agent-workflow`（DigitalWorker；平台供给 db-small PostgreSQL 与 `CS_DATABASE_URL`，`AW_SECRET_KEY` 密钥与 `AW_ADMIN_SUBJECTS` 配置）。`scripts/crewstation-publish.ts` 推送已提交快照并经平台发布接口发布：构建镜像 → 迁移 Job（首个版本 “PostgreSQL schema applied … active tables: 192”、“initial rows installed (7 rows in 4 tables)”，之后各版本 “schema verified … initial rows already installed”）→ 部署待命槽 → `crewstation traffic switch --to preview` 切流。浏览器验收用 Playwright 无头 Chromium 经平台网关（携平台会话 cookie；本机 Chrome 扩展未连接），最终在 v0.5.0（`9a3d757bd`）上 7 项全部通过：

- 平台身份：配置的管理员 subject 以 `cs-<uuid>` 账号登录且为管理员，账户菜单显示平台显示名；首屏带部署标记，WebSocket（authority / presence）经网关建立；`/auth`、`/setup/admin` 回到首页，无本地退出。
- 设置与账户：设置页无数据库 / 认证 / 网络三页（`?tab=database` 规范化），界面语言经设置保存；账户页无安全 / 令牌两节，概览写明由 CrewStation 平台管理；用户页无本地建号、有平台成员说明、每行为平台账户、编辑对话框无重置密码。
- 资源：Agent 新建并编辑保存、技能（含 SKILL.md 内容）、远程 MCP、工作流（快速创建 + 定义保存，编辑器渲染两个节点）全部成功。
- 拒绝与待命：插件安装、带技能的资源包应用均为 503 `hosted-capability-unavailable`，界面给出精确原因与下一步；任务入口显示待命横幅，发起任务为 503 `execution-standby`。
- 删除服务 Pod 重建后，上述资源（含编辑结果与技能文件内容）与管理员身份全部仍在。

验收中发现并修复：`5f5cad1c6`（账户菜单显示合成用户名、账户概览称本地账户与本地密码、用户页提供本地建号与重置密码、托管拒绝只显示「请求失败」）、`2cccf56f0`（用户目录每行仍标本地账户）；发布脚本最初调用 `crewstation publish`，因其要求开发会话而 412，改为平台发布接口（`27822dff5`）；启动探针按平台上限改为 `periodSeconds: 3, failureThreshold: 100`（`5386c8842`）。同期 CI 修复：`5e617acd8`（`6b1727e40` 的回归用例少传一个参数，主 CI Typecheck 自那时起红；生命周期 e2e 写的节点级 `retries` 早被 RFC-115 删除，实际跑满 8 次致 macOS 偶发超时），`afd7686a3`（任务列表 e2e 同类隐患）。主 CI 在 `20b0667f9`（`38706829578`）、`db7d322dc`（`38708137794`）success。

环境观察（M1 前确定）：本机 CS 的共享 PostgreSQL `max_connections=100`，平台自身约 50、其他测试项目约 30～40；本应用稳态每实例约 6 个连接、启动瞬时约 15 个，两次重建 Pod 时维护进程各有一次拿不到连接（`remaining connection slots are reserved…`），由 supervisor 自动重启恢复。托管连接池（默认每实例 16，蓝绿两槽同时在线）的预算待 CS「连接配额、池化按套餐实施」提供后确定。单节点集群 CPU 请求接近满载时，500m 套餐的滚动发布起不来新 Pod（v0.4.0 因此超时失败），验收改用本机新建的 250m / 512Mi 套餐 `agent-workflow-control`，M0 控制面在 250m 下启动与验收正常。

## M1 远程执行闭环

M1 三个提交 `962dd1e5c` / `2b92ec1b1` / `879cb0743` 已随并发 session 的 `0a6f5eb4f`（RFC-294 文档）一起推上 main。`0a6f5eb4f` 的主 CI `38930520068`（含 windows `38930520088`）失败 20 余项，逐项归因为 M1 本身（格式、`AbortSignal.timeout` / `createHash` 守卫、env 登记、架构账本、迁移计数、源码锁锚点等），由 v3 提交一并修复。M1 的执行核心已按 §9.2 V1 / V2 重做，以上节为准。

## 环境

- 本机 CS：docker-desktop kind 集群，命名空间 `crewstation-system`；本机 GitLab `aw-local-gitlab`（127.0.0.1:8929）。CS 已部署 `191f9ad1`；`CS_BASE_IMAGE_TAG=dev`。
- AW 项目 `01a13e6d-3e00-7000-9e3c-6a69d77164b3`、服务 `01a13e6d-3e01-7000-ab4c-e0f049700850`（命名空间 `cs-agent-workflow`，`agent-workflow.cs.localhost`）；服务按上表逐版发布升级（M0 起同一服务、蓝绿两槽），验收不停止、不删除服务。
- 单节点 CPU 请求接近上限（2026-10-17 为 9.1 / 10 核）；kind 节点所在磁盘经 2026-10-17 清理后约 35 GB 可用；任务档位用 100m 的 `rfc003-integration-qa`。验收仓库为本机 GitLab 项目 550 `crewstation/aw-rfc370-acceptance`，凭据经 `AW_GIT_CREDENTIAL_BINDINGS` 绑定项目 Secret。
