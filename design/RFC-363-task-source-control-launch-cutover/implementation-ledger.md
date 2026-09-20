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

## T3/T5 公共来源封存与来源任务重放候选

公共 URL 的同步及 deferred 启动使用实际 PublicRepositorySourceSealPort。IA 在 composition-only Task subcommand 工厂中保留已入场 authority，以预分配 Task ID 构造稳定 idempotency key；Task 不手铸 context。三个生产根与 host launch 显式接线，同一启动重建 adapter 复用同一 source/snapshot/operation，空 ref 仍在 fetch 后解析默认分支。最后三个 RFC362 声明债与 source seal 的零 consumer 债按实际生产接线注销；这不等于 T7/T8 验收。

sourceTaskId 同步重放在 Task 短事务中读取来源任务保存的 task_repos/task_space_nodes，交 SC 冻结完整布局及当前缓存配置，随后走同一 pre-materialized durable driver。live group 的编辑/删除不影响原节点与 mount；旧无节点记录仍保留原 minimalNodePaths fallback。新增真实双库 kernel/Git、空目录、组变更和 source receipt 重用断言；context 测试使用真实 IA 工厂。

`cc65514a3` Main `35506721647` 的 lint/typecheck 报 GC 泛型强制返回 T 不成立；两个 C2 分片报泛型冗余 union 使 WorkspaceClaimFinalizationCommand 被算作 consumer。本批把 GC 包装面收回实际消费的 WorkspaceMaintenanceCommand，删除无用泛型和断言；原 finalize 功能继续由既有 owner 实现，未领取该合同消费信用。源 seal 真实接线后 C2 基线为 136，RFC362 声明基线为 0。scratch/call/fusion/DE、T7 facade/lane 收口、Task/upload 跨进程窗口和最终托管验收继续待完成。

## T5 scratch 与 Task/upload 进程恢复候选

scratch 在原 mkdir/Git 前写 Task-owned pre-materialized plan，operationRef 保持 null，不伪造 repository source。SC 接线复用原 scratch materializer/cleanup；仅 journaled scratch 恢复可复用已初始化的 HEAD，避免在 Git 完成、Task artifact 未写入的窗口重复空提交。既有 scratch GC 按原 24 小时条件重试未绑定 plan，活动/部分补偿记录传给原扫描器保护；已 admitted 不可被补偿。失败的 Task 投影与清理算法保留。

Task 上传编排复用原 applyUploadsToWorktree，并在完整上传成功后、Task admission 前持久化 request digest 与 packed-path receipt。同 Task artifact 的相同上传重放复用路径，避免默认 rename 变成 `attachment (1).txt`。该回执覆盖完整上传结束后的窗口；逐文件写入中断到完成回执之间的细化恢复仍待补齐，不能声称全上传窗口已闭合。

新增真实双库子进程测试使用生产 RootTaskLaunchKernel，分别在 repository prepared-before-upload、repository uploaded-before-admit、scratch root-before-artifact、scratch uploaded-before-admit 处 SIGKILL；新进程检查原目录/marker/commit、单一上传路径、唯一 Task 和 admitted 后拒绝补偿。待本批 hosted 验收，不能把源码存在记成通过。原 RFC349 scratch 假池测试迁到真实 eachProvider，保留全部物理 rollback 断言。

`fb0b97a28` Main `35507694692` typecheck 暴露 public source input 漏填固定 `kind: 'url'`，本批补齐合同字段。T5 call/fusion/DE、T7 required lane/facade 和完整 AC 继续待完成。

## T5 转交 artifact 与 T7 闭合 lane 候选

call 子启动、两个 fusion Task writer 和 DE 借用工作区在原 Task admission transaction 中记录并接受 pre-materialized artifact；Task 只接收引用，既有 parent call-node / KE / DE 物理准备、所有权和补偿路径保持。admission 失败时同事务回滚 artifact，不把调用方目录误当 Task orphan。新增真实双库 borrowed kernel、child 与 selected fusion writer 断言，以及三种 hand-off 回滚后调用方文件保留测试。

Root prepared workspace 的 admission 方法现为必填，返回闭合 TaskWorkspaceLaunchLane；repository lane 从 SC live snapshot 返回 source 与 Task plan，pre-materialized lane 返回 Task journal 的 artifact ref。原 Task 写入事务消费该 lane，并拒绝已带物理目录的 deferred lane。旧任务 retry 的无 journal 兼容面明确不能用于新 Task admission；原记录池夹具显式返回其替代的 prepared lane。

上传 writer 增加 Task-owned 文件名 intent checkpoint，仍沿用原 target、rename/overwrite 与路径处理。恢复使用原已选择的名称；文件尚未写入则写入，已写且内容一致则复用，内容改变报告冲突并走原失败补偿。Task receipt 保存每个名称再执行对应写入，完整结果仍先于 Task INSERT。新增 repository/scratch 在 reserve-before-file 和 file-before-receipt 处的双库 SIGKILL 例，总计 8 个 Task pre-admission 进程窗口，等待本批托管结果。

此批尚未完成 owned legacy facade/import 清退、application launch 归位和完整 AC/最终 CI；RFC363 保持 In Progress。没有因此把 RFC294 E1/W5 整波关单。

## T7 Task application 启动编排候选

`application/launch/launchTask` 现在裁决 preflight、prepare、上传、Task admission、workspace commit、事件发布、drive 与 guard settled 的顺序。事务前失败补偿一次；事务后 guard/event/drive 失败不删除已绑定工作区。基础设施只供应具体预检/上传/事务/发布适配，原 54 字段 Task INSERT 经 TypeScript AST printer 对拍完全一致。新增 application 失败窗口测试；生产真实双库/进程 oracle 继续覆盖完整链。

前批 `1827fbe7c` Main `35508969487` 已定位 DE adapter 参数类型、旧 child 假池没有 journal 和旧 service 行号 oracle 漂移。本批补类型并将 child oracle 改为真实双库，保留 inherited workspace、所有行集、提交后可见、终态赢家阻止 drive 的断言；上传 SIGKILL fixture 系统用户 identity 改为与真实 root 一致的 null。仍待 owned facade/import 清退、完整 AC 与最终托管结果。

## T7 Workspace adapter 边界与上传 journal 候选

Task workspace/retry 不再 import SC composition、cache identity/group services 或 Task 物理 facade。根的既有 preparation binding 显式供应 group display 和 pre-journal recovery，旧回收算法不改变，仅归入 SC infrastructure。Task 接收投影为私有结构数据，SC 不 import Task；public offered seams 不新增近义合同。旧 Task 的无 journal 恢复能力继续保留。

根启动上传现在必须读到准备好的 Task artifact；删除缺 journal 时直接调用原 writer 的 fallback。旧 Agent multipart recording-pool oracle 改用真实双库和实际 scratch driver，保留全部内容、路径、身份、闭包、记录集、drive 断言；新增缺 journal 写前拒绝且目录不存在用例。旧 guard 更新到 application 的唯一 prepare，并确认上传/admission 消费同一个 workspace；fusion fixture 补 gitName（生产身份规则未改）。前批 `929db4dc0` Main `35509624994` 对应失败待本批验证。

仍须清理剩余 service 导出/受控历史调用、逐 AC 汇总最终托管证据；不记 RFC363/364 Done。

## T7 旧物理 facade 退役候选与剩余边界

`services/task.ts` 的物理机制转发导出删除，`materializeSpace`/`resolveRepoSourceSingle` 收为私有。原物化行为测试直接验证 SC infrastructure；两个旧 SQLite 测试调用签名由 test-only 装配 helper 保持，未放入生产路径。Task multipart 错误报告和 child hand-off 消费 Task 私有接收投影。三个根的 deferred adapter 只拿必填 preparation binding，不再 import/传递 SC store；旧记录在同一 root-owned legacy capability 下准备，新 journal 在 public participant 下驱动。Task ownership、重试循环/分类/窗口/退避与历史 cleanup 保持。

旧 `services/task` 内部仅保留受控历史 Task/本地测试与已有 fusion writer 的兼容机制；不再作为新 root/Agent/Workgroup/multipart 的物理入口。SC composition 中旧机制的内部装配面、cache/repository CRUD/Git SCC、Task engine 与 detail/catalog 的其余迁移仍属完整 RFC294 E1/W5，不因本纵切退役服务导出而倒签完成。

W29 PostgreSQL 仍 161 statements；摘要变化仅为 deferred root 不再重复注入 SC store。三个根仍通过原 preparation binding 提供该能力。Task INSERT 的 lineage/origin 字段保留，行号按 AST 实际站点同步。

原生 Windows 工作流增加现有两份真实进程 suite（SC 7 个窗口、Task/upload 8 个窗口），沿用 Windows SQLite lane，Ubuntu 验证真实双库。`0584a1c23` Windows `35510245406` 已定位的日志类型、测试状态字面量收窄、空 UploadInputDef Map 类型问题随本批修复。完整 AC-1～8 与最终托管证据继续待验收，不将候选标 Done。
