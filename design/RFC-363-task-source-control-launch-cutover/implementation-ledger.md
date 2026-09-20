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
