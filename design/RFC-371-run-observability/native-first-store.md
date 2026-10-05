# 原生数据库首次创建的 before / final

本片接续已批准的 RFC-371 原 native owner 和 before / final 方案，只修正式分页 participant 在第一次 OpenCode 启动前文件尚不存在时的入口。它不打开默认 producer，不替代多 root、恢复、CS v2、规模或模型验收，也不把原生来源未知补成零。

## 原问题与所有权

`runtime-management/application/nativePageCapture.ts:58` 读取原文件 generation；:59 对 null 无条件拒绝。新运行时可在真实 spawn 后才创建该数据库，导致其原 before-spawn owner 无法准备，之后 final 也没有该原 owner 回执。现有有文件 fresh / resume 正向和旧 v1 不变。

`runtime-management/infrastructure/opencodeNativeStoreGeneration.ts` 从实际 dev / inode / birthtime 构造 generation，ENOENT 返回 null；当前非普通文件也返回 null。本片将非普通文件拒绝，只把实际 ENOENT 当文件不存在。其他 stat 错误沿用失败，不能称不存在。

`task-execution/infrastructure/drizzleNativeUsagePages.ts:101` 在原 Task claim、accepted invocation 与 node 事务中准备并提交 before；:165 在同一 owner 中准入原 pass。`drizzleNativeUsageCompletion.ts:91` 从原已存 before 与原 pass 核对完整资格，不从调用方请求补造 proof。数字仍进入既有唯一 usage ledger。

## before 与首次 generation

已存在文件继续使用原非空 `sourceGeneration` 和原 receipt 形状。新增的 fresh、不存在文件选择使用 `sourceGeneration: null` 和 `sourceAbsentAt`：该时间由真实 ENOENT 观察之后、原 prepare 调用之前读取。它只陈述当时文件不存在，不是数字 baseline 或虚拟 generation。resume、不提供时间、时间非法、晚于 owner 的 preparedAt 均拒绝；非空 generation 不能同时带 absence 时间。既有字符串 generation 的 schema、receipt hash 和文档字节保持。

原 owner 将 before 文档、原 Task fence、native source 和实际 preparedAt 作为同一提交保留。丢 ACK 重放返回原文档与原时间；不把重试的新时间写回原 receipt。null generation / fresh 的新重放可以再次观察文件不存在，但不能把原准备改成已存在 generation，也不能在原已封存 owner 中重新开始。

第一次 final 在真实 reap / drain 后读取当前实际 generation，它必须已存在。pass identity 仍使用真实非空 generation。新增原 Task owner 的 `task_execution_native_usage_store_bindings` 原来源身份收据表，按原 invocationId 唯一，外键回原 preparations；只保存原 before receipt ID 和实际非空 generation。已有文件在原 prepare 同事务保存该绑定；首次不存在来源在 prepare 时无绑定行，admit 在原 Task owner 事务中首次条件插入实际 final generation。已存在绑定必须与原 before receipt / generation 一致，所有后续 pass 必须保持这个已准入的 generation，不能借 null before 混入替换文件。首次条件插入或内容核对失败整事务失败，不返回肯定 ACK。尚无绑定保持未知；不会补造完整来源。

原 before 文档和 owner receipt 保持不可变。新表是同一原 owner 的来源身份收据，不保存用量、模型、估值或数字投影。旧记录尚无绑定行：原非空 before generation 继续是原准入依据，第一次后继准入仅补同一个 generation 的原来源绑定；首次不存在的新 before 必须拥有已准入绑定才能验证 final。

仓内 `platform/persistence/postgresqlMigrationSequence.ts:641` 的 expand-only 机制只允许新增表和索引；现有 row shape 不支持 ADD COLUMN。本片使用原 SQL / immutable upgrade generator 的新增表方案，更新原精确 logical-schema roster 与 SQLite snapshot / append-only journal，生成一条新增表 upgrade。保留所有历史 SQL / upgrade / root 原字节，不扩展迁移引擎、不强制改任何旧数据。

完成判断改用原 before 非空 generation，或该原 owner 已准入来源绑定的 generation；若两者均有，必须相同，绑定也必须指向原 before receipt。仍核对每页、全部 parent / step membership、原 EOF、源 ACK / 数字修订、实际原 launch nonce 与 spawn / reap / drain。fresh 的原 rootCreatedAt 仍来自同一原 SQLite snapshot，且不早于真实 spawn，preparedAt 不晚于 spawn；没有该 birth 或进程事实仍 partial。不存在文件、目录、替换 generation、原 root 早于 spawn都不能成为 complete。

## 本片落点与验证

修改共享 before schema，Runtime 的 durable-owner prepare port / capture / 文件 generation 读取，Task 的 prepare port / 原来源绑定 schema / 精确 logical roster / owner准入 / completion，以及一条原双 provider 新增表迁移。新增回归与现有生产 participant / real child 用例共用原 owner 与唯一 ledger；不改原有限 packet 预算或总体 EOF 规则。

必须覆盖：

- 原文件实际不存在，实际 child 进程创建数据库与 root，1,001 原步骤按 EOF 到唯一四桶 ledger；原 before 的 null / absence 时间不可变，最终 generation 与实际文件相同，原出生和进程收据共同满足 complete。
- 相同原 before 重放、同 generation 准入重放；原来源 generation 已锁定后不同 generation 准入拒绝，无新 page / 数字 / ACK；真正回滚后没有 generation 绑定回执。
- resume 文件不存在、目录、无 absence 时间 / 非法时间 / 原 preparedAt 之前缺证明拒绝；进程未创建文件或缺 root birth 保留 partial 与已观察数字。
- 所有原 fresh / resume 四桶和历史修订正向继续；旧非空 schema 和 receipt 形状保持，原 assertions、原五秒或 120 秒预算不变。使用实际 SQLite 与 PostgreSQL provider，不用 mock generation 替代首次文件来源证明。

本机只执行精确 format / lint 与必要纯静态登记，不运行 AW 测试、类型、构建或服务。设计和源码分别有限功能检视，再按自有白名单上库与精确 SHA CI；旧失败证据保持。两 RFC 保持 In Progress。

## 设计后继的限定依据

DESIGN1 的功能 PASS 与原冻结说明保留。读取原迁移 engine 后确认它禁止改变已发布 row shape，原 nullable-column 实施选择不可由现有 PostgreSQL upgrade 生成。本后继仅把同一 generation pin 的物理落点改为原 owner 的新增来源绑定收据表，原 before / final 契约、完整资格、独立 ledger、回归、预算与范围不变；尚未写生产候选，也未运行任何规模或新路径验收。
