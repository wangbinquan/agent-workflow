# RFC-371：完整原生读取器 CI 接续

状态：独立源码门通过，修复候选待发布与 exact-SHA hosted CI；正式 producer 尚未切换。

`2129976f85aac2cd837b06e9c616f00b13206d03` 发布了真实原生 SQLite 的完整 EOF reader 与 Worker。`57f6c29303a17a2a6b28db5966da1f9bc69b1548` 修正只读克隆的测试类型，并退役该提交已消费的五项真实增长登记。其主 CI `37151884308` 为 completed/failure，旧失败日志完整保留；本次不能据有限源码门称该 CI 通过。

实际失败有三项。本机未运行 AW tests、typecheck、build 或服务。

1. macOS 的原 60 秒完整原生用例耗时 111.127 秒。可空续页条件 `after IS NULL OR id > after` 不能作为复合索引的真正范围，使每条 part 都重复扫描此前原记录。首查询保持没有 after 的完整范围，后续查询使用严格的 session/id 和 parent/id 游标条件；保留原字段、原始顺序、冻结页、ACK、摘要、实际 EOF 和全部 60,002 个 parts、10,001 个 steps、1,025 个 sessions、深度 80 的断言与时间预算。新增空 part/session 主键回归，防止将首游标替换为空字符串而静默漏掉异常原记录。
2. Worker、Protocol 和 Host 直接导入 runtime-management 内部，导致原 R1 精确边账本出现四条新增边。它们改为经过该 owner 的 exact `public/participants` 合同；原读取器和合同只做公开转出，不新增越界债务或放宽判据。
3. 原生 OpenCode 专用 SQLite 夹具的一个真实 `new Database` 调用漏登记。按原精确账本加一条带 `real-file-database` 理由的记录；它验证实际 OpenCode 固定文件格式。AW 的原数据库、完整来源、追踪、数值关联与人民币仍由真实双 provider 用例验证。原扫描器、分类、其余记录及断言保持。

有限 SOURCE7 回执 SHA256 为 `65b45c956e40672aaba59d20110736cd9d593d2590ef3bdd21924ba08893cda5`。七个源码、原字节和 CI 证据首尾稳定，目标格式与 lint 通过。此处不认证新的 hosted 性能或生产接入；原 native v1 和 span producer 的总量上限、v2 完整 baseline/emission/source ACK、正式执行链接线与真实任务验收仍未完成，必须继续。
