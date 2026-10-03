# 完整报告的既有维度链接

这是已批准 RFC-371 的完整统计修复，保留已有 `selection` 链接的含义。任务数量、调用次数和原始用量都读到 EOF；维度选择发生在完整贡献分配与原始人民币计价之后，不能选择当前展示页作为统计范围。

## 数据流

1. 保留原 Task 范围及子任务遍历、每个 Task 的全部 attempts、accepted invocations、native/platform captures 和原始 usage EOF 回执。复用已通过审阅的完整报告 Worker、原数据库快照、缓存与 seal；不修改这批基础合同或生成器。
2. `CompleteObservationTaskBuild` 增加 `sourceGaps`。在合并各调用的 fold 之前冻结不能归属到单个调用的缺口，补上未关联到调用的真实执行与尚未投影的来源。这样选中一个已知调用也不能把来源缺口隐去；不能用汇总 gaps 减去调用 gaps 推断来源完整。
3. 新的同模块 application 选择器使用已有 `parseObservationSelection`、`invocationDimensionMatch`、`modelDimensionMatch`，保持 authority/source、Agent ID/revision、runtime registration/configuration/protocol、purpose、actual model 的交集语义。明确 excluded 的调用不属于选择范围；unresolved 的归属产生 `dimension-unresolved`，报告不发布数字小计。
4. 以磁盘工作行记录调用选择及折叠状态，线性遍历完整 allocations，复制已冻结的贡献和计价。保持原 records/四类 Token/CNY，不重复分配、不按比例估算、不查当前费率。模型过滤只计实际模型匹配的记录，每个实际调用计一次；完整无记录的调用只能证明调用级零，不能证明一个特定模型为零。模型或采集归属未核实即 not-ready。
5. 使用同一份选择结果输出 Task/Agent/runtime/model/purpose/source 汇总、相关 Task、attempts、invocations、allocations、captures、趋势和状态。执行周期仅使用选中调用关联的 attempts；Task 墙钟保留原 Task 起止事实。所有来源回执仍覆盖过滤前完整来源，另外核对已访问原 Task 数与 Task EOF 数；选择后的 Task 数不得假冒原来源 Task 数。
6. 来源缺口即使没有已匹配调用也必须保留。没有调用的 Task 无法归属到已有维度，保留 unresolved。只有归属明确且完全 excluded 的 Task 才能从选择后的 Task 人口中剔除。
7. 指定 root Task 时，原 Task 事实作为详情锚点存在；数字与执行明细仍遵守请求范围，不能因 root 不匹配而丢失它的子任务匹配结果。正常页面从维度跳转到 Task 详情时不继承 `selection`，展示该 Task 与完整子任务的整体消耗；返回时恢复原维度范围、报告和分页位置。

## 窄实施范围

- `application/completeObservationTask.ts` 与 `ports/completeObservationTask.ts`：归属前来源 gaps。
- 新 `application/completeObservationSelection.ts`：完整工作行上的选择投影。
- `application/completeObservationCohort.ts`：读完来源后选择，保留原回执，分别核对来源与选择人口。
- 新 provider 回归：已有维度交集、跨旧上限的完整匹配人口、真实模型分配和原 CNY、明确排除、未知归属/无记录模型/来源缺口无数字、root 外的子任务匹配。
- `CompleteRunObservability.tsx` 与其当前 UI 回归：Task 详情去除继承维度；返回保留原范围。

不增加“更多筛选”或工作流筛选控件，不变更旧业务断言或预算，不重新运行已经完成的全量源码门。本批先限定功能设计门，实施后限定改动源门；行为由新的精确 SHA hosted CI 验证。

## 验收

合法既有维度 URL 不再在完整报告入口抛出 `Choose dimensions within the same complete report`。不同展示页共享同一完整选择汇总；每个原调用/用量都参与完整选择判断。缺一条来源证明、未知匹配或缺失原记录，状态必须说明缺口且没有数字小计。Task 详情仍显示其整体消耗，返回维度列表恢复原报告、位置和焦点。完整 native v2、正式 roots、真实任务与部署、100K Task/10M usage 的性能验收仍单独开放，不能由本批门检视冒领通过。
