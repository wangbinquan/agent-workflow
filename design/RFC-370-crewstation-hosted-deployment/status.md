# RFC-370 当前状态

> 唯一的进度记录。设计见 [v2 重设计](./redesign-v2-20261014.md)；本目录其余文档是 v1 历史。

| 步骤                                     | 状态                     | 证据         |
| ---------------------------------------- | ------------------------ | ------------ |
| P1 单机统一                              | Done                     | 见下方「P1」 |
| M0 控制面上线                            | 代码完成，待本机 CS 验收 | 见下方「M0」 |
| M1 远程执行闭环                          | 未开始                   | —            |
| M2 能力等价                              | 未开始                   | —            |
| M3 事件与运维                            | 未开始                   | —            |
| CS 侧 RFC（业务 Agent 原生配置叠加材料） | 未立项                   | —            |

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
- 镜像与发布：`deploy/crewstation/`（Dockerfile、Manifest 模板）与 `scripts/crewstation-publish.ts`（按本地档案渲染 Manifest、推送源码快照并 `crewstation publish`）。

已知限制（随后续里程碑解决）：仓库克隆需要 git / 工作区，随 M1；数据库维护 / 备份路由在托管下未做服务端拒绝（设置页已隐藏，备份进对象存储随 M3）。

本地集中验证：三包 tsc、eslint（新增两个发布脚本纳入 `lint:repo-ui` / `format:check:repo-ui`）、`lint:promises`、prettier、depcheck 通过；新增用例 backend 4 个文件、frontend 1 个文件。frontend 全量 855 个文件 7191 项中 2 条源码文本断言随改动修正（设置页隐藏判据收进 `isSettingsTab`，RFC-198 锁的原句不变），相关 6 个文件复跑全过。backend（SQLite）全量 8 分片：本机 Bun 的 22 项 affected-rows 之外，负载超时的 7 个文件单独复跑 44 项全过；守卫逐项修正（PG 执行面裸 `like` 改为精确前缀过滤、树摘要并入 `digestSortedTree`、`AW_*` 变量登记、bootstrap 消费身份 composition 登记、树内路径包含判断、中立事务原语写法、退出请求排空失败的拒绝处理、`/live` `/ready` 契约与 MCP 面豁免）；规范清单对拍、owner 登记表与账本条目数 4 条待提交后由 census 投影转绿。

提交：源码 `8683b5a81`、配套 `ce9edaad9`。本机托管冒烟（真 PostgreSQL 17 + 本地 JWKS 签发器 + 编译版二进制，`AW_DEPLOYMENT_MODE=crewstation`）发现并修复三处，均补回归用例：①托管库没有登记活动世代，PG 世代写入围栏拒绝初始行复制（`515209c95`，配套 `324f3f204`，另把 RFC-349 死锁故障注入改为确定性时序）；②插件与资源包操作合同未声明 `unavailable`，托管拒绝变成 500 合同违规（见下一笔）；③托管 `migrate` 的连接读 `process.env` 而非传入的 env（同 ①）。修复后冒烟全部通过：迁移 Job 首跑安装并复制初始行、重跑幂等；服务的 `/live` `/ready`、页面部署标记、网关身份（管理员 / 最低权限 / 缺失 / 伪造 / 他服务令牌）、执行待命状态与发起任务 503、设置页数据库只读与保存、Agent / 工作流 / 技能（含文件树）/ MCP 的创建、插件安装 503、WebSocket 带 / 不带身份；以全新空 home 重启后数据与身份映射全部仍在。

本机 CS 部署验收在完成后补记。

## 环境

- 本机 CS：docker-desktop kind 集群，命名空间 `crewstation-system` 运行中；本机 GitLab `aw-local-gitlab`（127.0.0.1:8929）运行中（2026-10-14 只读核对）。
- 已知限制：本机 CS 的 Claude Code 停在登录态；OpenCode 有可用算力档位。
