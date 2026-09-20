# RFC-363 实施台账

2026-09-20：用户已批准实现和代码上库。首批 T1/T2 候选，尚待托管 CI；T3–T8 未完成。

## T1 基线

已对 `source-baseline.json` 的 25 个生产文件重新计算 SHA-256：24 个与设计基线一致，仅 `db/schema.ts` 因本批四表 expand 改动。
入口、54 字段、两 lane、reader/rollback oracle 继承 RFC-362 `implementation-ledger.md` 的逐项清单；本批不修改任何入口的准备/建任务顺序。

## T2 expand 与兼容恢复

- SQLite `0227_rfc363_workspace_preparation_journals`：SC source、snapshot、operation 与 Task preparation 四表；不改旧表、不创建占位 Task。
- PostgreSQL `0003_rfc363_workspace_preparation_journals`：V2 additive edge 支持完整新 KEEP 表；V1 索引边、baseline、旧 journal/SQL 字节保持不变。旧列、codec、key、disposition 的变更仍不能冒充 additive。
- 旧备份经已验证的 additive history 恢复：旧行按原合同解码，新表为空，并进入目标完整 census。原 index-only bridge API 仍拒绝表变更。
- SC 私有 repository 提供幂等 source、不可变 snapshot、operation 状态/version CAS；首次 commits 在物化前记录，prepared receipt 在后续 cleanup 保留。Task 私有 repository 提供 admission key、artifact、原 owner fence 与状态/version CAS；不得清理已 admitted 记录。
- 本批 factory 是持久化基础；尚未接入生产 seal/snapshot/effect/reader，不领取 RFC-362 declared seam 或 E1/W5 完成信用。跨进程 Git/上传恢复仍待 T3–T5。

新增 `rfc363-preparation-journal.test.ts` 与 `rfc363-additive-schema.test.ts`，覆盖双库原子回滚、并发 CAS、请求复用、receipt 持久化和历史回放。扩展既有真实 PostgreSQL 旧备份恢复断言，确认四张新表为空；原行/归档/生成记录断言保留。

本地仅执行 schema/canonical generator 与 Node Prettier/ESLint，不运行 Bun tests、服务或全仓 gate。验收以本批发布 SHA 的 GitHub Actions 为准。

## T3 source/snapshot 候选（尚未生产接线）

Source Control 的 application 负责 repository 配置 revision、完整嵌套 group 展开与 source facts 冻结；infrastructure 只把调用方既有 live transaction 绑定到 repository。group facts 包含目录型子组的版本、mount/subdir/readonly/viaGroups，后续配置修改不改变已冻结 facts。public URL 使用原 cache identity 机制，source/snapshot 均可从持久化记录读取，准备阶段不执行 Git/FS。

`rfc363-source-snapshot.test.ts` 覆盖真实双库回滚、transaction factory 到期、revision 与 fetch telemetry 分离、嵌套 group 修改后旧 facts 保持、重建 factory 后 source ref 重放。此处只证明 factory 重建，不冒充跨进程 Git 恢复；T4/T5 仍需真实进程中断和 effect/upload receipt 验证。production roots 尚未接线，declared debt 保持。

首批 `2220057676037f3e6fa0a71bf56dc2a9a05fd6a8` 的 Main `35497628814` 暴露升级前使用 head 表清单校验旧库的问题，以及 current table/migration count 与 migration authoring liveness oracle 未同步。本批按已安装的历史 contract 校验，再执行 additive edge 并验收 head；受控 fixture 跟踪实际 CREATE TABLE/metadata 变化。旧库、回滚、pointer repair 与真实进程恢复断言保持；等待修复批 SHA 托管结果。

## T6 workspace reader 候选（已接线，待托管验收）

SQLite/PG 根显式将 SC content scope 注入 Task query composition。Task application 经 `TaskWorkspaceReadPort` 调用同一 `WorkspaceContentParticipant`，HTTP 两入口只投影原响应；原 visibility middleware 和 Task binding lookup 保持。`services/worktreeFiles.ts` 已删除，原测试迁为调用真实 Task display / SC provider，不再保留生产 facade。

SC 全量枚举并按原 comparator 加稳定 tie-break 排序，再切 offset 页；raw read 按字节/base64 返回，覆盖跨 UTF-8 边界和二进制。零字节观察只取 size/oversized，让旧 HTTP 保持超大文件不打开内容、content=''；原目录 cap/truncated 和 UTF-8 replacement decoding 保持。授权 workspace ref 只在当前 query scope 有效，绑定来自真实 Task 持久化记录；它不冒充 durable preparation snapshot，也不使用全局 ref Map。查询结束即关闭两侧 scope，FS I/O 不在 DB transaction 内运行。

新增 `rfc363-workspace-content.test.ts`，沿用双库 HTTP `routes-worktree-files.test.ts` 与原 filesystem suite。canonical 只注销 reader 6 个 SC public 声明与 TaskWorkspaceReadPort，剩余 16 个 launch public 声明继续记债；T3/T4/T5 的 production launch 未完成。

第二批 `5ca700bb7d49cc550175abc8f4253d585368d95e` Main `35498701132` 已发现 source seal 的 contextual typing 和测试闭包 null narrowing 错误，本批显式绑定 exact port 类型并捕获已准入 authority；其余作业继续由终态证据裁决。

## T4 物理实现归位候选（尚未 durable effect 接线）

从 `services/task.ts` 提取 Git source resolution、scratch/single/group materializer 与 cleanup 到 `source-control/infrastructure/workspaceMaterializer.ts`。Task row、旧任务 frozen layout DB reader、launch ownership 与 deferred step 留 Task 原调用方；SC mechanism 不接 DB client。原公开 service 名暂作同一实现的兼容转发，精确由 T4/T7 后续清零，不能据此领取 participant 完成信用。

相对 reader 批 `958b078d24e5d94c4af9ee5630c8d43b1542a992`，通过 TypeScript AST printer 对拍 11 个迁移函数 body（忽略注释和格式），全部一致。依赖类型改成 SC 私有显式字段；原 Git/abort/group/cleanup 行为 suites 继续执行同一函数。RFC066/067/248/287 source guards 同时扫描新 owner 或其真实汇流函数，原断言不删除。

下一步将 concrete commit 集与物化前 provenance 记录到 operation，再接 Task launch/preparation/retry/cancel；当前只完成物理 owner 归位，跨进程 effect receipt 恢复仍未实现。

reader 批 CI 后续发现六个失败分片，归为四项：bootstrap 引用需经 composition、route 缺失依赖顺序和覆盖、三条已消费 contract ledger 基线未缩小、5004 项真实目录测试在 5 秒内反复枚举 37 次超时。本批逐项修复；目录仍全量排序后分页，测试减少重复页数并给真实 FS 场景显式 30 秒预算。Windows `35499425753` 已 success，但不能代替 Main 全绿。

## T4 固定 commits 与 application driver 候选

私有 driver 在 operation 进入 materializing 前持久化完整 commits JSON；SC Git adapter 尚待装配。materializing 内进度单独作 version CAS，只更新 evidence，不能覆盖初始 commits/成功 receipt。重建 repository 后按 durable 状态跳过 resolve，prepared/failed/stopped 返回原引用；每个外部效果和落库前后均沿用调用方 Task fence 检验，不新增 SC lease。

物理 materializer 支持完整 pre-resolved source 集与 frozen group layout，拒绝部分 source 集；物化和 tracked-path 占用检查均使用 resolvedCommit，原 baseBranch 保持展示/Task 投影。真实 Git 测试覆盖分支后移并增加 reserved path 后仍检出旧 commit、live group 不存在后仍重放两 mount 的不同 commits 和目录节点。

`rfc363-preparation-driver.test.ts` 是真实双库 + 注入故障窗口，**不是跨进程 Git 恢复证明**。完整 Git receipt/provenance 恢复、public effect capability、Task 两 lane、生产根仍待后续；T4 不标 Done。上一批已定位的 Task INSERT line oracle 仅更新 `3570 → 2427`，三列完整性断言不改。

## T4 effect / 物理恢复候选（未生产接线）

SC infrastructure 解析冻结事实并沿用原 cache/fetch、Git 物化路径；版本化 private plan 保存 task/path/working branch/identity/完整 source commits 和 layout。journaled materializer 在原 Git lifecycle mutation 前提交 exact branch-before/branch-after/path，逐仓结果继续 checkpoint；重复进入会验证原工作树 identity 并完成剩余步骤，不能从新 branch head 重新准备。

`RepositoryPreparationParticipant` 的唯一 root-owned factory 用 live capability registry 绑定 operation/source 与现 Task fence；registry 不保存恢复结果。重复同进程调用只驱动一次物理效果，关闭后的 scope 不能继续调用。此时生产 Task adapter/根尚未切换，所以 16 项 launch 声明债仍全部保留。

新增 `rfc363-preparation-process-recovery.test.ts`：使用真实 smart HTTP Git、SQLite 文件 / 真 PostgreSQL generation，在 before-add、post-add、working-branch-before-CAS 处等待持久化 checkpoint 后 SIGKILL；新进程读取同一 journal 后恢复。远端分支后移仍读旧 commit、已有目录标记保留、branchBefore 不被 retry 覆盖；对已改变的物化分支返回失败且保留其内容。测试已编写，尚待托管取证；不把测试存在记成验收通过。

取消适配与 journal 补偿、Task repository/pre-materialized admission、全部 roots/legacy 退役仍是剩余 T4/T5/T7 工作；不领取完整 E1/W5。

## T4 持久化补偿候选（Task 接线仍待完成）

物理清理复用原 Git 注册锁与 expected-old branch CAS；进程在 remove 后、branch restore 前退出时，新进程按同一 provenance 完成清理。现有树身份/HEAD 已变则保留并报告冲突；组成员清理未完成时不删除容器。停止物化也执行同一路径，diagnostics 始终保留物理 evidence，不因错误/stop 包装丢失。

SC application cleanup 接受 Task-owned 当前 fence/binding 检查；每次效果与写库前后复查，不铸新 lease。部分失败持久化但不标 cleaned；重复恢复保留原 resolved commits/成功 receipt，成功后只重放已存 cleanup receipt。新双库 driver 测试验证陈旧 owner 不启动/不接受 cleanup、部分失败再进入与稳定回执；真实进程测试增加取消前/后 add、remove/restore 之间 SIGKILL、外部改写后的 cleanup 冲突。仍未证明生产 Task adapter，T4/T5/T7 不记完成。

`97b1e45de` Main `35501905328` 类型检查报可选 baseBranch 不能赋给必填的 string|undefined、递归 participant 缺显式类型；本批精确修复。最终测试结论以包含本批的终态 hosted SHA 为准。

## T4 延后入口生产接线候选

基线 `ec5fe2e8b430e77ff01b1051ac5c23475b825f3c`。Task 根启动内核在原 Task transaction 内调用 private admission hook，使用 admitted authority 调用 SC snapshot participant，冻结当前 repository/group，创建 SC operation 与 Task plan；54 项 Task 投影及原 drive 顺序保留。此处没有 Git/FS。raw URL 仍由现 cache identity 先得到 repository ID；public URL seal 的命令 scope 接线继续保留声明债。

三个根显式提供 SC preparation binding。现 Task owner 驱动 deferred phase-0，调用 public effect participant；每个阶段复用 Task owner CAS，并在 journal 记录对应 epoch。旧任务无 journal 时保留旧来源/物化；新 journal 缺 root binding 时明确拒绝，不静默回退。SC receipt 可在新 factory/进程恢复，prepared receipt 与 Task 工作区/成员仓/目录/合成准备行在原结算事务一起接受。

已有 journal 的恢复不再执行旧的无差别 stale-worktree 删除。SQLite/PG manual retry 均使用当前 durable operation；失败清理完整后新 attempt 继续引用同一 frozen source。取消使用 durable cleanup，已 accepted 或被另一 Task owner 接管的工作区不能被此补偿删除；PG retry 的成功 CAS 与 receipt acceptance 同事务。组重试显示保留 Task 已保存的组名，不重读被修改/删除的 live group。

新增 `rfc363-task-preparation-admission.test.ts` 使用真实双库、生产 root kernel、真实 HTTP Git：同事务建 plan/source、admission 回滚、活动 Task owner 拦截、组更新后的冻结布局、receipt 重用、projection 回滚/接受、取消清理重放；旧 G7/人工重试/上传 suites 保留。补 Task journal 的绑定、owner 单调移交与 operation version CAS 用例。测试尚待本批 hosted SHA。

canonical 注销已进入 deferred 生产链的 snapshot/effect 合同及关联事实声明，剩余 PublicRepositorySourceSealPort / sealed source ref / input 三项继续有明确 owner/removeWave。此信用只覆盖 deferred 链，**不代表完整 RFC363/T5/T7**：同步 prepare-before-Task、multipart artifact、call/fusion/sourceTaskId/DE adapters、现 GC 对 pre-admission journal 的补偿及剩余 legacy facade 退役继续待完成。

### 已有真实进程证据

Main `35503125522`（`cb2ce5b566b754683505338c1e1979963e894051`）的 Ubuntu shard 11 job `106058374913`：SQLite/PG 各 7 个 SC 进程中断窗口全部 pass；macOS shard 4 job `106058374917`：SQLite 7 个窗口 pass。窗口为 before-add、post-add、working-branch-before-CAS、changed-prepared-branch、stop-before-add、stop-after-add、cleanup-after-remove。这证明 SC 物理 driver/cleanup；不把它倒签为本批 Task 接线验收，也不把有其他失败的 Main 称全绿。


## T5 同步仓库与 multipart 候选

同步 repository/group 先在短事务内保存 `pre-materialized` Task plan、SC snapshot/operation，再在事务外物化。上传仍位于 prepare 与 Task INSERT 之间；admission hook 在同一个 Task transaction 内接受 artifact。working branch、Git identity、错误码与 failed Task 投影保持原入口语义。没有 journal 的旧任务继续兼容读取；scratch/sourceTaskId/call/fusion/DE 内部空间仍待后续切换，T5/T7 不记完成。

准备租约复用 `materializingSpaces`，通过既有维护任务的活动 ID 快照传给 worker，commit/rollback 释放。既有 orphan GC 在两个 provider 中先由 Task owner 选择同 appHome、超过原 24 小时阈值且不活动的未绑定 plan，再调用 SC durable cleanup；部分失败保留记录与原 Git provenance，不能落入普通目录删除。没有目录的 prepare 中断也由 journal 找到，不增加后台定时器/worker。Task 创建失败会直接执行同一补偿；已 admitted plan 不能被清理。

新增双库生产 kernel/Git 用例：同步 Task 与 artifact 原子接受、Task transaction 回滚后物理补偿、重建 adapter 重用原 receipt/上传文件、活动租约保护、无 Task 的 GC 清理重放，以及实际 multipart 写文件早于 Task INSERT。测试尚待本批 hosted SHA；factory 重建用例不等同 SIGKILL 上传窗口取证。

前批 `c610e30db` Main `35505842902` 已定位测试夹具漏装真实 RC resource binding、两个 action-host fixture 缺 authority、legacy Task 越界读取三个 private imports，以及 C2/declaration 两项计数未缩小。本批修正真实装配，legacy 调用复用已有 `taskDriveLegacy` 组合入口，未增加边界豁免；计数收至 137 / 3，原行为断言保留。

同一 Main 的 Ubuntu shard 1 / macOS shard 1 另报 AC-9 source anchor 仍要求 `prepared = await materializeSpace`。本批同时钉住循环内的 durable 调用和旧任务 fallback，成功退出、分类器顺序、窗口与退避断言原样保留。
