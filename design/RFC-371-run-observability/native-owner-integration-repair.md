# 原生证据 owner：数字回执与归档集成

原始页候选已发布为 `6df57fa20c4e87756264076233eff597e581e768`，匹配增长许可在普通后继 `1f0a2dc17206108395995e5be6e9951224ebf291` 退役。正式 producer 尚未切换，已有页面继续使用原运行链路。

## 本批功能

- `DrizzleNativeUsageEmission` 在原 Task claim、accepted invocation 和 node 事务内冻结完整输入、分配修订、追加原 `task_execution_observation_sources`，再保存该原行的映射和 ACK。只有原事务真实提交后返回 ACK。重发同 eventId 校验原输入及原 source 字节，返回原 observedAt、修订和水位；投影已经消费该行也不会再写数字。
- 修订分配沿原 node source 主键以 200 行传输页持续到空页 EOF，包含 pending 与已经投影的全部原行。检查点和每个原 record 的高水位只在这笔原事务里推进；再与原 ledger 已观察修订取最大值。它们是分配元数据，不贡献第二套 Token 总量。失败绑定、原 claim 变化和外层未提交事务都不能产生肯定 ACK。
- v2 scope 检查真实持久 pass、page 和 parent 索引。从当前 session 到实际 root 逐链接验证 ordinal、深度和路径摘要；不截断到 64 层，也不构造全人口 ancestry 数组。缺失或矛盾的原链接拒绝本帧。
- 原数字 ACK 同时联校该 pass 的真实 step membership。`opencode:step:` 必须指向已在引用页进度内持久的原步骤，其 session、原时间、实际模型与四桶完全匹配；只接受该原步骤的 request／delta／self／invocation 映射。真实 child-80 step 的正向回归保留完整父链；不存在的步骤、其他 session、改数字／模型／时间以及把步骤伪装成汇总均拒绝，原 source 与修订不增加。
- 原 managed process 直接记录出生、reap 和各输出 pump EOF 的观察时刻，Agent adapter 原样传递；cleanup 后的当前时间不替代这些原时刻。未启动、不可 reap、输出回调错误和未 drain 保留缺失事实。计时 metadata 不改变原 stdin、output、outcome、TERM/KILL、deadline、cleanup 或激活策略。
- 八张原 native 关系进入活着的 Task archive coordinator。使用真实主键续页及 invocation/pass 子查询，把全部行逐批写入原 JSONL，最终原 manifest 冻结数量，然后沿原收尾流程删除 Task。500 是单次传输页大小；每张表一直读取到实际 EOF，不作为总量上限，不把证据列入归档豁免。
- 原数值 schema 的两个定义移到纯叶子，定义保持一致，原根 API 继续 re-export。原 native 合同从共享根入口导出，所有生产消费者使用该已有正式入口，避免原第一方依赖检查器看不到子路径。新 process 数字帧的合同仍仅供尚未接线的原 owner 使用。

## 原 CI 失败及修复依据

`1f0a2dc1` 主 CI `37239208244` 的原作业日志保留，不能将此候选写成全套成功：

1. lint job `111544396652` 在原 depcheck 阶段报告六条无法解析的 native schema 子路径。共享 package 原本已有 wildcard exports，本批直接采用仓库既有根 API；没有放宽检查器或增设豁免。
2. SQLite logical source 两项原断言仍使用 208，原生产合同已新增八表，实际为 216。原测试标题、内容断言和预算保持，只把真实表数量改为 216；backup 的原 active 表数量由 202 同步到 210，archive-only 仍为 6。
3. Ubuntu job `111544396596` 与 macOS job `111544396582` 的原传递级联闭包对账发现八表尚未进入归档清单。此项通过实际完整导出修复，原闭包算法、测试、删除前提和唯一租约豁免不变。
4. 同 SHA 后续原作业确认 PostgreSQL parity 及 schema contract 的旧 202／208 断言、机器／人工报告和 rolling 0237 head 尚未登记这八表。同步为实际 210／216 与 0238；原 generator 仅生成两份匹配报告，archive-only 仍为原六表，全部旧字段与断言保留。
5. macOS job `111544396824` 的原七个 native owner 用例因 fixture 漏 Task 必需 `startedAt` 而未进入断言。只补原字段，不改用例或超时。两份新 OpenCode 原生 SQLite 文件夹具按实际调用数进入原逐文件登记；AW owner／source／数字回执仍走真实双 provider，分类器与原未迁移债清单不变。

同 SHA 原主 CI 已正式 failure；Windows 在原平台作业中 cancelled，full E2E／WebKit／visual 各自正式 success。全部终态保留。新候选的确切 SHA 和所有正式终态另留证，不通过取消旧作业、改测试预算或本机 AW gate 获得绿灯。

## 验证与继续工作

回归直接使用原双 provider Task claim、accepted invocation、事务和物理 source。覆盖丢 ACK／重建 owner／投影后重发、超过两个传输页的 pending/已消费水位、原 ledger 已观察版本、回滚、stale claim、外层未提交事务、80 层父链与并发修订；真实原 process 用例核对 cleanup 前已冻结时间以及输出失败的缺失 EOF。原 archive 用例在两个 provider 真正归档并删除 Task，逐字核对八张关系和 1001 个 membership 的全部 JSONL。用例仅写入原 hosted 流程，未在本机执行。

本批是数字 ACK 与必要集成，尚未实现 seal、逐 baseline 配对／历史修订闭合、正式分页 producer 装配、CS 对应原 journal/Pod owner，或真 100K Task／10M usage 验收。既有完整页与本批有限功能检视、格式／lint、匹配原静态登记、确切 SHA hosted CI 是各自的证据，互不替代。两个 RFC 保持 In Progress。

首轮 SOURCE25 有限门为 FAIL（1 P2／0 P1），回执 `/private/tmp/observability-native-emission-source-v1/review.json` 保留，不覆写或改为 PASS。其指出仅 parent 链不足以证明步骤数字；下一窄增量增加原 step 校验并将错误的虚构 deep-step 正向替换为真实 child-80 原生记录，独立回执和确切 SHA CI另留证。

SOURCE26 v2 原 P2-01 已闭合，但真实 CI 的缺失 `startedAt` 形成 P2-02，仍为 FAIL；原回执保持。v3 只补 fixture 必需字段及同 SHA 的实际登记遗漏，独立有限检视另留证；不重开已逐字通过的数字／归档实现或将旧 FAIL 改为 PASS。
