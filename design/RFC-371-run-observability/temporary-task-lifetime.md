# 完整统计的 Task 临时行生命周期修复

本片修复已批准完整统计的大规模构建失败，不改变统计人口、Token 四分类、人民币估值或公开分页语义。2026-10-05 确切 `eef1e3ad12435d9d4192a6ca214153d641a6a3a4` 的 hosted 规模运行 `37366135115` attempt 2 已经在原表写入 100,000 个 Task、100,000 次尝试、100,000 次受理调用、100,000 份 capture 和 10,000,000 条用量；构建以 `database or disk is full` 失败。真实采样最大 TEMP allocated 为 80,980,574,208 字节，原数据库为 10,467,536,896 字节，报告 spool 尚为零；OS 峰值 RSS 为 416,244 KiB。失败及原测量保留，不视为规模验收通过。

## 原因与落位

`buildCompleteObservationCohort` 逐个构建 Task。每个 Task 的原输入副本、去重 identity、排序 run、覆盖索引、选择 allocation、调用 fold、时序及 trace 都位于该 Task 的 TEMP namespace。已选择的完整输出另外逐条转入 cohort 的 `report-rows`，计数、来源回执、任务汇总、趋势和维度也分别进入 cohort namespace。原循环未释放已完成 Task 的临时行，因此每个 Task 的中间材料一直累计到整个快照关闭；未选择 Task 也同样积累。

修复位于 run-observability application：增加一个 Task 临时 scope，代理原 `CompleteWorkingRows` 的现有方法，保留 receiver、错误、原批处理、读序、游标和 EOF 检查。它只登记该 Task scope 内实际仍存活的 namespace。原排序等调用 `clear` 时同步移除登记；不登记或清理 cohort 的汇总、输出、来源回执，以及任何原数据库关系。

原 cohort 循环为每个 Task 创建一个 scope，将它的 rows 传给原 Task 构建与 selection。原 Task、调用、allocation、原生和平台 capture、attempt、trace 均完成现有逐页复制及全部 population 检查后，先 flush cohort 输出，再释放本 Task scope。维度、趋势和汇总已保存它们需要的独立值；不会在下一 Task 中回读已释放的 Task 材料。未选中的 Task 在来源回执保存后释放 scope。失败或取消仍让原构建失败，不得发布尚未完整的报告。

scope 的 run 在 finally 结束此 scope 并尝试逐 namespace clear。普通异常且原快照仍活跃时，clear 可以完成；取消后原 workspace 的 `signal.throwIfAborted()` 会使 clear 同样抛错，此时不声称逐 namespace 已释放。原异常或取消优先传播，清理异常不得替代它；若没有原业务异常，clear 失败本身使构建失败。未完成的临时清理由原 snapshot 的既有 finally 执行：文件 SQLite 关闭原 reader、内存 SQLite DROP 原 TEMP、PostgreSQL 使用原 rollback/DROP/release 清理。不得另开连接、绕过原取消检查，或在取消后继续写报告。测试分别验证活跃快照内的异常释放与取消后的原 snapshot 清理。

namespace 登记仅为此 Task 的当前临时关系名称，不收集任务、用量或 allocation 全量数组。调用方不能通过此 scope 写入或删除其他 namespace。多个 Task scope 相互独立，release 仅在已结束的 Task 上调用；结束后该 scope 的读写拒绝，避免把误用变成空记录。原快照、SQL TEMP 表、完整来源水位、租约、价格与原数值 selection 算法保持。

## 功能验收与发布

新增 scope 的真实工作区回归须分别覆盖 SQLite 与 PostgreSQL：写入、读序、重复 identity 错误、upsert、逐页 EOF、主动 clear、release 后拒绝、外部 namespace 保持、两个 scope 不相互删除，以及释放后 cohort 输出仍逐字相同。不得用 mock TEMP 代替两种原快照。

原小型完整报告回归保留全部预言，新增跨 Task scope 的检查：捕获原快照 workspace 上的 insert/clear，证明每个 Task 的中间关系确实在下一 Task 开始前释放，而原 `report-rows` 未被释放。原 Task/调用/四桶/CNY/每条 allocation 与原完整 EOF 继续通过同一个 `qualifyScaleReport` 核对。普通异常在活跃原快照中释放当前 scope；取消保留原取消对象，由原 snapshot 结束释放 TEMP，两者均不得产生 ready。原报表过滤回归覆盖未选中 Task 的释放。

按有限设计和实现功能门、自有路径 format/lint、准确提交及 hosted CI 发布。AW 不运行本机 tests/typecheck/build/service。然后以新确切 SHA 再跑固定 100K Task/10M usage 与单组 10M self-total；不得减少数据量、放宽原 P95 <500ms 目标、增加任何总量停止条件或修改已有测试预算。清理的效果只能由新完整运行的真实 EOF、全部预言、RSS、TEMP/spool/原数据库磁盘和失败回执确认；本片本身不关闭两个 RFC。
