# RFC-370 Task host callers 精确 CI 修复

## 事实与范围

已上库 `290f4d26a26385818edc4ed227c37dab92ad3991` 的主 CI `37683909758`：Format/Lint/Typecheck 在 taskHostClaimFailure:203 与两份真实 provider 回归报四处 TypeScript 错误；Ubuntu18 的 direct/provider PostgreSQL loss-after-SQL-body 在原 owner INSERT 断言失败；Ubuntu32 的原 RFC-328 corpus 判据报告 taskHostClaimFailure 内直接调用 createOwnershipToken。保留原失败和全部测试、断言、预算，不记 CI 通过。功能日志位于 `/private/tmp/observability-aw-ci-290f4d26-functional-20261008-v2/`。没有本机 AW tests/typecheck/build/services。

本片只修复上述真实功能失败。原架构判据、允许文件、全部旧库存条目、预算和测试矩阵不改；并行原生用量修复由原会话拥有。W2-E effect SOURCE4 已独立有效 PASS，配套生成另行完成，本片不代签其匹配门，也不改 effect 的任何方法。

## 设计

1. `taskHostClaimFailure.ts` 的原 frozen binding `transactionFor` 回调只补 `DatabaseTransaction` 参数类型；类型擦除后原返回、receiver 和调用完整保持。
2. failed-claim 测试的原 `expect(this).toBe(captured.receiver)` 只补已在同一 claim callback 记录的 receiver 的非空类型投影，运行时断言完整保持。
3. finalization 测试保留原 attachment object identity 断言，给 expect 显式 `TaskExecutionContextRef` 类型以匹配实际 public ref；原 `.db` 兼容连接断言保留独立读取 `execution.db`，只在测试内加擦除型 `typeof execution & { readonly db: typeof h.db }` 投影，仍断言与同一 h.db 对象相同。完整类型擦除后的测试与原全文相同，不能以改读另一个字段代替原兼容连接断言。不得重建 context，也不放宽 brand 或原端口。
4. 原 SQL recorder 实际录制 PG schema-qualified `insert into "agent_workflow"."task_execution_owners"` 与 UPDATE。只使两条原 SQL 断言识别原精确 `agent_workflow` schema 或原 SQLite 无 schema 表名，并加入标识符边界；原 toBe(true)、ROLLBACK、owner 空集、intent pending、work completion、idle 断言完整保持。在私有纯源码证明中核对十二条原 SQL 字面量正/负样本，证明双 provider 语法和错误表/错误 schema 不匹配；仓库继续使用这两条原真实 provider 回归，不增加只镜像 regex 的测试，不调用数据库替身。
5. `createOwnershipToken` 的构造继续由原 `DrizzleTaskOwnershipPersistence` 基础设施 adapter 装配：注册失败 ACK 时显式传入原 factory reference，失败 ACK helper 只保存并调用这个 purpose callback，其参数使用原完整 taskId/identity/epoch/ownerRevision/leaseUntil 类型。原 completedTuple/confirmed SQL outcome 条件、创建时点、参数内容、taskHostWork association、markRecoveryRequired captured receiver/重试/原时间、全部原业务错误/事务内容保持。helper 不直接导入或调用 domain factory；不新开 public capability，不加 allowlist 例外。原调用层与单一原 factory 继续一致。

## 实施与验收

先完成独立有限 DESIGN 功能门；后修改上述两 production 与三 tests，保持原原子操作和未触及源码。使用纯 AST/字节证明整个原文逆向、类型擦除、旧断言/样本/预算保持与三种 recorder SQL 语法匹配。只对自有文件 format/lint 与必要原 promise lint；实际双数据库、Ubuntu/macOS/Windows typecheck 和全部测试由新 exact-SHA hosted CI 执行。新增 design 文档随本片提交。

生产变化会进入同一实际候选的原配套输出，已运行的 W2-E 原 census 不重复；用完整 committed 输入与两项明确生产差额及原完整 helper 做必要静态投影，保留原 13 产物、129 有序 inventory 和全部 authored debts，对已消费许可只做普通后继退役。若与并行 metadata 重叠，先核对其实际已发布候选，保留全部内容。独立 SOURCE 和 matching 后精确 allowlist 上库；原 290f 的失败仍保留，不将后继通过写成原提交通过。

RFC 仍处于阶段 A。H7、剩余 Task 写入、恢复、owner/roots、A-T7/A-G、CS adapters、M0 部署与 M1～M4 尚待完成。

## DESIGN1-R2 真实失败与修正

R2 独立正式有限门有效稳定 FAIL：CI-DESIGN1-R2-F01 指出 legacyConnection 与 compatibility.db 是两个独立字段，改读前者会丢失原 .db 回归。根已完整消费原17项/三个包装 FAIL，保留原回执及失败。R3 按第3条保留原 execution.db，只补擦除型类型投影，原读取、对象 identity、品牌及全部断言/样本/预算不改。十二条 recorder grammar 样本只作为私有字面量证明，原两个真实 PostgreSQL/SQLite SQL 断言继续验收，不新增镜像测试。尚未实施 production 或 tests。

## 精确 Ubuntu7 原 Driver wrapper 登记

补充的实际 Ubuntu7 功能日志显示原 W5 PostgreSQL runtime 形状人口缺两条：failed-claim 和 finalization 各1。两者都用 `harness.applicationBinding` 的原真实池和 reserved connection；正常 SQL/rows 逐条委托原连接，只在真实 COMMIT/ROLLBACK 响应点注入失联和延迟，用真实锁/MVCC验证原行 writer 终结前不能 ACK，不返回罐头行。源码、真实库断言、时序和60秒预算不变，不把类型名字改写来躲原分类。

按原 W5 文件已明确准许的 Driver/编译探针登记方式，准确增加这两条形状清单及其类别说明；原68条、完整统计函数、全部正负样本、全部expect和预算完整保持，新增后人口70。配套129有序ledger只把这一行68→70，保留完整原why并追加这两真实Driver completion probe的说明，按原流程记录一次实际增长许可并由普通后继退役。这是漏记既有已上库测试人口的CI配套修复，不增加或放宽判据，不降低断言，不改变生产行为；额外 source owned 只有这份原库存文件。SOURCE6-R1 尚未派发，包装保留并标为被 SOURCE7-R2 后继取代；新增功能日志与原全文作为有限 SOURCE7 证据。原设计R2 FAIL/R3 PASS和已实施五文件的完整 runtime 逆向证明保留。

## 有限实现与配套事实

SOURCE7-R2 实际独立功能PASS已由根完整消费，37项/三个包装 EOF 首末稳定，完整原runtime逆向、68旧库存与全部原判据/断言/预算保持。与 W2-E 共用一次原生成及其3文件有限投影，不重复 census。精确290f主CI failure、Windowscancelled保留；新确切SHA CI、remote同步和实际发布分别留证。配套细节见[effect记录](host-authority-task-effect-writes.md)。RFC与CS部署未完成。
