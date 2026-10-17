# RFC-370 当前状态

> 唯一的进度记录。设计见 [v2 重设计](./redesign-v2-20261014.md)，其中 §9 是 2026-10-16 接手审视与 v3 修订（取代 §5.2 及旧 status 中与之冲突的实现细节）；v2 M2/M3 在制品的旧记录逐字归档在 [status-archive-m2m3-20261016.md](./status-archive-m2m3-20261016.md)；本目录其余文档是 v1 历史。

| 步骤                         | 状态                       | 证据                                                               |
| ---------------------------- | -------------------------- | ------------------------------------------------------------------ |
| P1 单机统一                  | Done                       | 见下方「P1」                                                       |
| M0 控制面上线                | Done                       | 见下方「M0」                                                       |
| v3 修订实现（§9.2 V1～V13）  | 实现与用例完成，集中验证中 | 见下方「v3 修订实施」                                              |
| M1 远程执行闭环              | In Progress                | 源码已上 main；实机验收待执行                                      |
| M2 能力等价                  | In Progress                | 实机验收待执行                                                     |
| M3 事件与运维                | In Progress                | 实机验收待执行                                                     |
| CS RFC-040 / RFC-042（附属） | In Progress                | CS `61478743`、`516b83a1` 已推送且准确 SHA CI 成功；实机验收待执行 |

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

集中验证（进行中，见下节更新）。

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

- 本机 CS：docker-desktop kind 集群，命名空间 `crewstation-system`；本机 GitLab `aw-local-gitlab`（127.0.0.1:8929）。CS 已部署 `61478743`。
- AW 项目 `01a13e6d-3e00-7000-9e3c-6a69d77164b3`、服务 `01a13e6d-3e01-7000-ab4c-e0f049700850`（命名空间 `cs-agent-workflow`，`agent-workflow.cs.localhost`）；正式 M0 v0.5.0 蓝绿两槽保持运行，验收不停止、不删除它。
- 单节点 CPU 请求接近上限（约 0.3 核余量），磁盘约 9.8 GB 可用；任务档位用 100m 的 `rfc003-integration-qa`。
