# RFC-370 Task resource recovery：真实 CI 回归修复

本片修复 `6db03c7dfc5e20077f302a938770656c8e14b9b3` 的实际功能失败。主 CI `38112405396` 的 Typecheck、Ubuntu 5/32、Ubuntu 22/32，以及完整 Windows `38112405402` 已给出对应失败；后续 SO 生命周期和 H7 根装配的生产实现继续等待修复提交的总 CI 全绿。本片不改变已批准的 boot／periodic 写入目的、原恢复 kernel 或原写入事务边界。

## 失败与原合同

原 `rfc370-boot-execution-recovery-family.test.ts` 要求 `create(input)` 只捕获 input，不读取输入。prepare、reap、repair、finalize 分别读取原 persistence／lock proof、persistence、lease port、persistence／lock proof／probe。当前构造阶段新增的 `input.persistence` 读取违反了这条原合同。原文件、案例、断言、次数、预算完整保留；修复生产实现。

新增 R01 和 R05 把 `DatabaseTransaction` 对象身份当成独立事务身份。实际 SQLite session 在每次显式 `BEGIN IMMEDIATE` 中复用原 db 对象，事务的独立性由 BEGIN／COMMIT／ROLLBACK 与原 async scope 决定。不能为了断言而改变原客户端、创建额外事务或按 provider 放宽数量。R01 仍须证明七个独立的已提交写入原子；R05 仍须证明两个独立原子且第一次提交、第二次回滚，原行状态和后续重试断言完整保留。

三个 TS7006 来自 `Object.freeze` 内回调失去上下文参数推断：`taskHostRecoveryWritePurposes.ts` 的 boot／periodic grant，以及 `taskResourceRecoveryWrite.ts` 的 transactionFor。只给它们添加原接口已经规定的参数类型。

## 修复设计

local boot factory 的构造保持零输入读取。第一次 prepare 或 reap 在该 stage 的第一个 await 之前，同步读取该 stage 的原 persistence，调用原 `selectTaskBootRecoveryWrites`，验证完整所选 family，并保留其原回调、receiver 和 grant 捕获。成功解析后，选择在这一 pairing 的生命期内固定。所选 family 后续阶段使用已经捕获的原目的端口，不再次读取 native persistence 或 lease fallback。

native 选择继续在每个原 stage 读取原输入，保持原读取顺序、次数、异常传播与省略 undefined probe 的行为。repair／finalize 仍先验证同 pairing 引用，错误引用在读取后续输入之前拒绝。第一次选择失败不能标记成成功解析；也不能调用任何 native recovery effect。

新 R08 的原功能判据是“缺 grant／family 在 native recovery 之前拒绝”。其断言从构造期拒绝改为第一 prepare 的同步选择失败所导致的 Promise 拒绝，以匹配原构造冷合同；保持全部四种不完整组合、原错误码、零写入调用和原 Task 行状态断言。periodic 的直接选择仍同步拒绝。补充可观察的所选 persistence 读取次数，证明构造为零、第一次 stage 为一、后续 stage 不重读。

R01／R05 使用现成 `harness.recordStatements()` 录制实际连接／池的语句。各次原 host consume 的 before 回调记录当前语句位置；一个纯测试断言 helper 将每个位置绑定到包围它的实际 BEGIN 与后继 COMMIT／ROLLBACK，要求 consume 前尚未关闭、consume 后无嵌套 BEGIN，并要求每次 consume 归属不同 BEGIN。七次与两次的数量判据保持，且分别检查七个 COMMIT、COMMIT／ROLLBACK。recording 只在这两条用例的目标操作窗口开启，并在 finally 停止；实际 persistence、host adapter、transaction mapper、async scope 和业务事务继续使用原实现。

## 实施与验收

仅修改三个生产文件、这一新增测试文件和本片文档／状态记录；原 boot 测试及前序 HumanGate／lifecycle 全文 oracle 不修改。原 H／L／R 案例人口、全 Windows 步骤、预算和所有未涉及断言保持。先由独立功能设计门审阅本片，再实施并做文件级 format／lint 和独立功能实现门。按新生产候选只执行一次原四规则 scoped census，保留全部原账本项、why、顺序与并行内容；若存在实际增长，按既有普通相邻提交办法精确登记并退役。

发布只提交本任务精确 allowlist，保留其他会话 WIP。最终依据修复提交的完整 GitHub 主 CI 与完整 Windows 终态，并逐条核对原 H／L／R 实际案例。此片修复门 PASS 不代表新运行成功，也不关闭 H7、A-T7、A-G、CS adapters、M0—M4 或 RFC；aw 尚未部署到 CS。

## 已实施的候选与原失败留证

有限设计门的 23 项完整材料、8 项功能分析和正式 PASS／零 findings 已由根实际核对。macOS 1/12／2/12 后续原日志也确认 R01／R05 与原 boot 的相同失败，没有据此签当前总绿。

三个原生产文件和新 R 测试已按本设计修复。local pairing 构造只分配私有状态；prepare／reap 第一次调用在 await 前成功解析并固定选择，失败不标已解析。原 native getter 四阶段和 foreign pairing 判据所在测试完整字节不改。新增 R01 getter 只读一次，R08 构造零读取，失败 prepare／reap 各保持效果前拒绝。

R01／R05 的 consume 回调只记录实际原 SQL 语句数组的位置；纯断言 helper 要求位置前的最后边界为 BEGIN、位置后第一边界为 COMMIT／ROLLBACK，因此已经关闭的事务或中间新增 BEGIN 不能通过。不同 BEGIN 数量仍为七／二，并分别要求七个 COMMIT 和 COMMIT／ROLLBACK。两个 recorder 均在 finally 停止，原业务行、回滚和重试断言保持。R05 仍是原 boot lease purpose，未改为 periodic。

这些记录是源码候选事实，尚未签新行为执行。实现门、当前候选的唯一原生成及配套门、精确发布与新 SHA 主 CI／完整 Windows继续分别验收。
