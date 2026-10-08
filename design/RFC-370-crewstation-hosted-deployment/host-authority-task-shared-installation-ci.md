# Task 跨任务用例的共享安装实例修正

## GitHub 失败证据

`fbf85b2710180228f84a7e98b2becf7756ac50ae` 的主 CI `37782710720` 中，Linux 后端 24/32 分片与 macOS 后端 12/12 分片的 `old issued release restores its complete Task context even inside a different Task` 用例均在创建第二个 fixture 时失败；SQLite 和 PostgreSQL 的失败栈都指向安装实例写上下文的第二次 `prepare`。其余两个失败分片是已由 `84a17eb580f533c8046f19e43fc68234827f1a1b` 修正的 RFC-294 原始 status 投影格式问题。

## 修正及验证边界

原测试把同一数据库错误地当作两个并存安装实例。安装实例表使用固定 `installation` 标识，一个活跃实例不能再次准备另一个实例。测试应模拟一个安装实例驱动多个 Task。

测试 helper 抽取原有工作流、Task 和 intent 的播种过程，新增 `additionalTaskHostFixture`：复用原安装实例的模块、持久化、绑定和 admission，在同一数据库播种第二个真实 Task，并通过原模块 claim 其独立 intent。完成次数与 lease 列表仍通过原 fixture 的实时 getter 读取；不调用第二次安装实例 `prepare`，不修改生产安装实例规则。

runtime lease 用例继续使用两个完整真实上下文和不同的原始 ownership token，增加共享模块/绑定、两条已接纳 lease、其他 Task 的原始行完全不变和实际 release 清空 lease 的断言。尚未发布的执行投影用例采用同一修正，保留显式上下文优先、跨 await 恢复、其他 Task 的所有行不变和原始业务错误优先的断言；单任务仍要求一条 lease，双任务要求恰好两条。

三个测试源文件的范围格式、lint 和纯语法检查不执行产品代码。后续独立功能门只检视该候选及直接原合同；实际 SQLite/PostgreSQL、macOS 和 Windows 结果以发布 SHA 的 GitHub CI 为准。该修正没有生产代码变化，不重跑已完成的架构生成，也不声称 H7、A-G 或 CS 部署完成。
