# RFC-371：完整任务追踪接入

状态：实现候选；不是已发布、CI 通过或原生 producer 切换的回执。

任务统计、调用汇总和执行追踪使用同一个原数据库快照。Task 请求在完整 accepted invocation 工作区核实归属，遍历原持久 span source 的所有实际续页。旧的 1,000 次受理、100 页和 20,000 个来源片段不再参与正式报告的取数。单页大小只控制传输；非 span 的原来源行也推进真实源游标，不能以过滤后的空结果冒充 EOF。

原始来源按页落到连接私有 TEMP 工作区，创建事实外部排序，原 spanKey 的状态与问题按有界缓存折叠。修订保留原 accepted owner、创建行/项位置、创建文档与 scope 逐字证明；原 `immutable/merge/unknown` 规则是共同实现，重送、冲突和历史修订不会制造新的调用。全部数值关联读取完整原 allocations，不用前 20,000 条或本页记录计算四类 Token 和人民币。

报告新增 `span-facts`、`span-captures`、`span-statuses` 三个派生页集合。完整 counts 是整个冻结集合的基数；每个 attempt 的状态只有 complete 才有 spanCount、captureCount、priorRepairCount 和全程范围。缺捕获、错误归属、来源解析失败、未结束或冲突的原时间均为 not-ready，不携带数字小计；单独保留已知原事实的时间边界供泳道定位，不将它称作完整执行时长。Native 用量尚未完整时，执行事实不能使它变成可显示的 Token；链接只取原 invocation 已 ready 的四桶与完整可见 CNY 金额。

正式 Task 页的 attempt 弹窗展示原生工具、模型与子 Agent 泳道；一次保留一页，完整汇总不随页数改变，不再有前端最多自动读 100 页的追踪。完整 Task report 下的 spans 别名只读同一 reportId 的保留页，并按原 attempt/invocation 身份读取对应保留集合，不忽略调用筛选，也不退回旧有限查询。维度筛选之后仍保留完整源证明，追踪、捕获和数值关联只包含匹配的原调用。旧 v1 查询仍留给原回归/未装配 report 的内部兼容面，其行为不能作为正式完整统计依据。

新增真实 SQLite/PostgreSQL 回归写入 1,001 个原 attempts/invocations、20,021 个原持久 spans、10,001 个原用量；要求越过旧边界后的全部 identity、四桶、完整 CNY 链接与 100 页之外的续页一致。再删除一份原 capture，要求 not-ready 且无计数，不能改成零。此处描述用例和候选，结果以 exact-SHA hosted CI 为准；AW 未在本地运行测试、类型、构建或服务。

第一轮独立 SOURCE18-v2 门发现三处 P2：筛选丢失追踪、not-ready 的历史泳道被 asOf 范围压成零宽、spans 别名忽略 invocationId。原 FAIL 保留；SOURCE21-v3 有限增量及组合审查 PASS，回执 SHA256 `b161cfe01decd7189059c5e6fffb6841665e9aa85bcafddef967f8e78a0c000a`。21 个候选与 7 个原控制首尾字节稳定；新增双 provider、正式别名和前端实际泳道回归仍须新 exact-SHA hosted CI。

仍待：原 native v2 的完整 baseline/page ACK/emission high-water 与 Runner 接线；v1 native 和 span producer 自身 session/part/step/owner 总量上限仍是缺陷；只改报表和持久追踪不能补回从未保存的原生数据。CS producer 保持 OFF。完整报表 E2E、真实模型四桶/CNY、规模/RSS/磁盘/P95、浏览器和 CS 最终本机部署仍待验收，两个 RFC 不关闭。
