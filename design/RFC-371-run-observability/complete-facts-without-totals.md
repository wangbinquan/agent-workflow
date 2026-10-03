# RFC-371：未完整用量下的完整执行事实

这是完整统计设计的展示修正，适用于原输入已经实际 EOF、但原生用量证明缺失的范围。Task 名称、原 attempts、accepted invocations 和已保留执行事实仍应可查看；不能因一个任务未观测就让整个任务列表和泳道消失，也不能因此恢复部分 Token 或费用小计。

现状：正式快照构建在 metrics 为 not-ready 时直接返回 gaps，随后丢弃已经完整读完的事实。真正的 Task 因原生用量未观测而没有可打开的执行详情，原正式 E2E 的任务查看和 attempt 对话框也失去入口。该失败不能用旧有限查询、固定模拟总览或伪造零来处理。

响应仍为 building / ready / not-ready / failed。not-ready 保留 reportId 和具名 gaps；只有全部原输入 EOF、完整原来源收据、冻结 scope 和 sealed output 均通过时，可附加 facts。facts 保留同一 header、全量事实页及事实集合的精确基数，但不附加 Token、人民币、observed numericRecords 或 nativeCaptures 小计。Task / attempt / accepted invocation 基数来自完整原查询，表示执行事实数量，不声称用量已观测。未知时间保持未知；已知原开始/结束可定位泳道，不冒充完整 native trace 的执行时长。

facts 与 ready 使用相同 spool、每页顺序摘要、staging、完整 manifest、实际行数与 scope 校验。不同点是最终发布状态保持 not-ready，并只开放事实集合：tasks / attempts / invocations、执行 span facts/statuses、质量、维度事实与任务归属、趋势中的日期和 Task 数量。对外 Task、调用、维度和趋势的 metrics 全部为 not-ready；span 的数值/CNY links 清空。allocations、原数值 capture 文档等统计/数字集合不开放。不是将缺页内容当成 ready，也不是给总量补零。

不可恢复的原证据缺失继续阻止 Token/CNY 统计成功；原查询本身未 EOF、快照/传输失败、重复或跨范围游标、坏 seal、清理/失去原范围都不能产生 facts。building 和 failed 没有事实页或数字。只有完整输入 sealed 后才可发布 not-ready 的完整事实。页大小继续仅约束传输，事实/Task/调用/泳道总量没有上限。

前端复用现有标准卡片、列表、Dialog、ExecutionSwimlane 和分页。not-ready 提示持续可见，四类 Token 标签对应未知值，人民币未知；Task/Agent 名称、状态、原调用、已知时间仍可查看。显式进入一个证据完整 Task 时，另构建该 Task 的完整报告，才能显示其完整四桶/CNY。关闭和返回继续保留筛选、滚动及焦点，禁止追加旧“需要关注任务”、更多筛选或 CSV。

回归：真实双 provider 的一个完整 Task 加一个未观测 Task，要求同一 not-ready 报告包含全部事实、最后一页及精确事实基数，所有层级均无 Token/CNY 小计；直接数字页请求明确拒绝。删除一个 retained fact 或破坏 seal 后，事实也必须不可读取。原真正 Task 的正式 browser / a11y 验收通过事实入口验证全部 agents/attempts 和 unknown 状态，不用 display fixture 冒充模型任务。完整 ready 的四桶/人民币/原 selection/页范围/损坏输出回归保持。

这不改变或免除原 native v2 的完整 baseline、持久 emission、高水位/source ACK、生产接线、原 producer 总量限制清理以及真模型/规模验收。两个 RFC 继续 In Progress，CS 开发 producer 保持 OFF。
