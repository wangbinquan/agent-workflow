# 原 Task 的原生采集生命周期

本片接续已批准的 v2 原页、唯一数字 source 与历史修订合同。实现可由原 Task owner 显式装配的 before/final 生命周期；默认生产装配继续使用既有采集，不能把此片当成所有入口已切换或两个 RFC 完成。

实际 Task 执行上下文在 invocation 调用点绑定持久 participant，读取原 accepted source、claim 和 node。原 OpenCode 路径只由既有 material 环境解析，物理 generation 来自实际文件的 dev、inode 和出生时间；正常 WAL 写入不更换 generation，替换原文件会拒绝混用。没有新建 claim、数据库或数字账本。

接受本地 invocation 后、启动进程前，fresh 持久明确的空 before，resume 把同一旧 root 的原 BEGIN 快照逐页读到 EOF。每页先提交原 Task page/source，再给 reader 肯定 ACK。final 只在原进程结束并排空输出后读取，同样遍历全部页到 EOF；单个运输包大小不限制任务、session 或步骤总量。原 readonly Worker 不在 daemon 事件循环执行 SQLite 扫描。

实际 native execution adapter 提交原 PID、launch nonce、spawn/reap/drain 时刻和终态；逻辑 execution result 不增加物理字段。观测写入异常记录告警，不改业务进程结果。final 页异常后，已经提交的数字仍投影到实际 source EOF；模型元数据重试与 span 最终写入独立继续。正常 final 则投影、遍历原 baseline 历史修订、重新生成原 seal，并再次投影到 EOF。原 frozen complete ACK 继续重放，partial 可以在原历史修订完成后形成新证明。

修复了原 source 投影的合并错误：正在处理别的 node 时，其返回的零条不能被当前 node 用作 EOF。相同 node 的请求继续合并，不同 node 等待后运行自己的原查询。新增双 provider 回归明确断言 unrelated=0、requested=1、requested EOF=0 和唯一账本的一条记录；没有减少任何原断言或统计人口。

新增实际 SQLite/WAL、Bun 子进程和原 Worker 的双 provider 用例，经过原 Task claim、页持久化、真实进程事实、唯一四桶账本和历史 owner：1001 个步骤全部入账，下一 Task 的 resume 修订原 1001 条并只新增四条；未知输出保留全部已知输入和两类缓存，capture 明确 partial。物理文件替换与 WAL generation 有独立回归。此处描述的是新增用例的预言，尚未运行的 hosted CI 不能写成通过。

本机只运行精确文件格式、lint 和原静态登记生成，不运行 AW tests/typecheck/build/新服务。正式生产全部入口、原快照中断恢复、多个原生 root/epoch、baseline 规模成本、CS 托管/独立接线、100K Task/10M usage、真实模型任务与正式页面完整验收继续；它们未验核前，默认 native producer 不切换。
