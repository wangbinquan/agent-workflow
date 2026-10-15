# RFC-370 当前状态

> 唯一的进度记录。设计见 [v2 重设计](./redesign-v2-20261014.md)；本目录其余文档是 v1 历史。

| 步骤                                     | 状态        | 证据                                                       |
| ---------------------------------------- | ----------- | ---------------------------------------------------------- |
| P1 单机统一                              | Done        | 见下方「P1」                                               |
| M0 控制面上线                            | Done        | 见下方「M0」                                               |
| M1 远程执行闭环                          | In Progress | M1 候选实现与用例已齐；集中静态检查中，CI 与实机验收待执行 |
| M2 能力等价                              | 未开始      | —                                                          |
| M3 事件与运维                            | 未开始      | —                                                          |
| CS 侧 RFC（业务 Agent 原生配置叠加材料） | Draft       | CrewStation RFC-040 三件套已写，按 CS §5.3 等待用户批准    |

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

候选包括：Agent 执行边界与单机全部调用方接线；CS 租约、失权退出、数据库写屏障；提交前意图、ACK 绑定、逐事件持久 journal 与稳定 sourceKey、断线补页、取消原因保留、重启 adopt；持久任务卷、单仓准备、git 包装器隔离工作树、脚本、对象产物。启动恢复先取得平台执行权，证明远程结果后再释放旧 effect／会话持有，保持原节点运行 ID 并恢复业务投影。系统 Agent 等 M2 执行组仍明确不可用。任务镜像继承平台按摘要提供的 `CS_BASE_IMAGE` 并保留 Runner 入口。

SQLite `0259` / PostgreSQL `0035` 同步加入控制、工作区、执行绑定、事件 journal、产物与事件去重表。共享 schema 当前为 204 source / 198 active，逻辑摘要 `sha256:2e545a671736461b3e01ce77c0563fa5c2ea991a342212a3acf063990bf2c54b`。发布脚本改为 GitLab 原子文件提交接口，从当前主 checkout 的已提交对象读取源码，保留镜像仓库非 AW 管理的文件；不创建 clone、分支或 worktree。

集中验证：三包类型首轮与本轮 87 个 TypeScript 文件 lint 通过；追加边界用例后继续静态复查。测试用例已覆盖 ACK 丢失、SSE 重连、终态游标、陈旧世代、取消竞态、接管投影、双引擎工作区与调用幂等、真实 Git 助手及脚本。**尚无本候选的 GitHub CI 或 CS 实机执行通过证据，不能记为 Done。** M0 正式服务保持运行；本轮没有停用或删除它。

CS 配套 RFC-040 已在 `CrewStation/proposal/rfc/RFC-040-business-native-materials/` 建立 proposal / design / plan，生产变更等待该仓 §5.3 所需用户确认；不影响本轮 M1 的提交与验证。

## 环境

- 本机 CS：docker-desktop kind 集群，命名空间 `crewstation-system` 运行中；本机 GitLab `aw-local-gitlab`（127.0.0.1:8929）运行中（2026-10-14 只读核对）。
- 已知限制：本机 CS 的 Claude Code 停在登录态；OpenCode 有可用算力档位。
