# 同一次调用的全部原生会话根

本片接续已批准的完整原生采集，修复正式 durable 分页入口只读取最终 root 的缺口。它不改变任务、调用或执行尝试的数量，不新增数字账本。新的默认 producer 仍须等独立功能门、双 provider 回归、实际多根进程、原规模与双部署验收后启用。既有 v1/v2 原事件及已受理运行的合同保持。

## 实际缺口

`taskAgentRun.ts` 在已受理的原 session lease claim／conversation reset rotation 后维护 `nativeSessionEpochIds`，但 `bindObservationRoot` 被 span participant 的存在条件挡住。其 durable final 只传 `sessionId ?? effectiveResumeSessionId`。`nativePageCapture.ts` 因而只扫描这个 root；resume 还拒绝与初始 root 不同的 final。原 `drizzleNativeUsageCompletion.ts` 的 `head` 明确拒绝第二个 final root。简单传数组、循环扫描、忽略这个错误或拿最后一个 root 的 complete 证明替代全部根，都不满足完整统计。

## 原始根集合与版本

使用同一 Task 原 owner，逐条保留来自实际 claim／rotation 的根转换回执：原 invocation、Task／node、真实执行 claim、原 native source、native epoch 序号、root ID、fresh／resume／reset 事实、原 spawn receipt 和观察时刻。receipt 提交后才确认；没有 span participant 也必须保留。同一转换重送返回原回执，不能换根或重写时刻。根转换是原执行身份与交付事实，不保存 Token、费用或 numeric projection。

根转换允许 A→B→A；final 人口按同一 invocation／原 generation 下的不同实际 root 读取，A 只扫描及计账一次。转换顺序和去重后的根集合分别保留原物理水位，不靠调用方提交的数组或总数判定封闭。Task owner 使用新增的原根回执关系和原 pass heads；所有 keyset 页到 EOF，没有根数或 epoch 总上限。原 generation binding、prepared before、原进程 launch／spawn／reap／drain 仍为唯一来源。不能新造 invocation 来容纳多个 root。

根集合的 complete 合同显式使用 `opencode-child-root-pages-v3`，原有 `opencode-child-pages-v2` 保留原单根含义和严格解析。原 transport page／ACK 仍沿用既有分页合同，不重写原页字节。v3 completion 是小型原 owner 引用：根集合原水位、转换数／不同根数、逐根验证结果的持续 digest、原 before 和 process、原 numeric／revision 水位。完整根／pass／parent／step 人口保留在原关系中；completion 不含随人口增长的数组。接收方不支持 v3 时保持待核对，不确认或清除来源。

## before、final 与已有用量

只有初始实际 resume root 使用启动前的真实 baseline EOF。fresh 和 reset 根的空 before 资格必须同时满足原 before receipt、同一个实际 generation 和该根从真实 reader snapshot 读出的 birth ≥ 原进程 spawn；缺 birth、原旧根被意外复用或未确认的转换均保持 partial，已有用量仍显示。A→B→A 若 A 是初始 resume 根，始终使用同一真实 baseline，不重复扣减；其他旧根没有启动前 baseline 时不能补造空基线。

真实 reap／drain 后冻结原转换来源的水位，逐个不同 root 读取原 final 到真实 EOF。某一根失败不能跳过它并宣告 complete；其他已提交原页和数字继续保留及投影。最终资格从原关系推导：所有已接受根有正确原 final、完整 parent／step、原 source ACK 和 numeric 修订，初始 resume baseline 的每个旧步骤都已对照，实际 process 与所有水位一致。原时刻、source generation、scope reference 和唯一 ledger 身份不能由 final 请求补填。

数字逐页沿原 source → 原 usage ledger → 原估值进入已有账本，scope 指向各自原 pass 的完整 parent 引用。原 history owner 和真实受理价目表负责 baseline 修订；全调用汇总只合并经过验证的逐根结果。调用数保持一，任务、Agent 与全局四桶和 CNY 不重复。v1 历史 owner 接续到新调用的 v3 baseline 必须验证原唯一归属和历史修订，不能把版本变化当成第二份用量。

## 实现边界与验收

Runtime 只管原文件和分页读；Task Execution 只管原 claim、转换、页、source 与冻结 ACK；Run Observability 只消费原数字、父链和 completion 引用。新增原 owner 身份关系通过原 SQLite／PG append-only generator，不改既存 migration、schema 根或 ledger。正式启动根待上述消费者就绪才注入新的默认 persistence；没有可用的完整 participant 时保留原能力状态。

新增实际双 provider／真实 child 回归，保持既有断言、超时与预算：fresh A→B，两根各超过一个 packet；resume A→B→A，baseline 历史修订且不重复扫描／计价；无 span participant；丢根 ACK／重建 owner；缺前根 final、缺末页、错误 root birth／generation、drain 未完成时，全部已知四桶与 CNY 保留并标记缺口；独立/托管与旧 v1/v2 重放保持。根集合及每条原步骤逐页对拍至 EOF；不得以根计数、fixture 数组、最后一个 root 或现有小规模 PASS 替代原来源。

本机仅做 AW 精确格式、lint 与纯静态生成；原功能与规模在 exact-SHA GitHub Actions 验证。此片属于既有 RFC 的完整根采集，不增加未请求的产品能力。两个 RFC 保持 In Progress。
