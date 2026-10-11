# Task 资源恢复：源码与清单发布候选

本片把 Task 启动恢复和 active 周期恢复接到已有宿主资源写入端口，保留原业务写入内核、事务边界、原 receiver、事件发布顺序和 native 路径。boot 使用 preparing 阶段的 `consumeRecovery`，periodic 使用 active 阶段的 `consumeNewWork`；两者都不伪造已准入的 Task 执行上下文。完整设计与原写入原子说明见 [task-resource-recovery-write-purposes.md](task-resource-recovery-write-purposes.md)。

## 已消费的源码门与历史失败

SOURCE R1 的正式 FAIL／一条 finding 保留：R14 原期望三次 periodic 消费，而既有 Node 转移、run event、Task lifecycle、Task event 实际是四个独立写入原子。R2 只修正这一条期望并保持原案例、预算和断言，独立 PASS／零 findings 已由根会话实际消费。

R2 上第一次原 scoped census 在原脚本校验阶段以 `public surface opaque type allowlist mismatch` 退出 1，未生成配套产物、未写主树清单。这次失败与日志原样保留。R3 把原 `Readonly<Record<string, unknown>>` heritage 写成等价的显式 readonly string index，原 literal 字段、参数和全部运行时函数保持。有限逆变换恢复完整原模块；七个公共类型的字段、方法及已解析引用保持，仅去掉额外 opaque heritage `extends:Readonly`。原 opaque allowlist 和四条 census 规则保持。

SOURCE R3 的 93 份材料、完整身份、16 条功能分析及 17 个案例结论已经核对，正式 PASS／零 findings 已由根会话消费。新测试完整 SHA 为 `f895756cfa73ff1b8f4f535a6cbbd82c9461b5263357e813a2e42a08692dc43c`。这是源码结论和注册数量，尚不是行为执行验收。

## 一次成功生成的真实变化

共享 main 已同步到 `4d27826d93aaca4c1b5523059196a405746d0923`。相对原 SOURCE base，新增提交只涉及 RFC-371 的两份文档；这批已审源码和控制材料完整字节不变。生成输入采用该提交的全部非本片源码，加上冻结的 30 份本片 owned 材料。原四条规则执行一次，13 份配套输出只保存在私有候选；没有运行本机 AW test、typecheck、build 或 service。

本片历史累计两次 whole census attempt：R2 一次中止，修改后 R3 一次成功。没有对同一候选重复完整生成。28 个原纯声明再现全部 13 份原输出，用于核对投影、库存与紧邻退役；它不再执行 whole census。

| 原 ledger ID                            | 同步基线 | 本片真实值 |
| --------------------------------------- | -------: | ---------: |
| `rfc294-mutation-entrypoints`           |     1994 |       1995 |
| `rfc294-background-jobs`                |      374 |        379 |
| `rfc294-cross-context-observed-imports` |     6907 |       6909 |
| `rfc294-architecture-exceptions`        |     6049 |       6051 |
| `rfc294-public-surfaces`                |     1260 |       1267 |
| `rfc294-module-symbol-owners`           |    27803 |      27824 |
| `rfc294-transaction-callbacks`          |      277 |        275 |

原 130 行 ledger 的 ID、顺序和 why 完整保持。前六项只声明本片真实增长许可；事务 callback 的下降来自相同原规则对复用事务帮助函数及行号变化的记录，不代表删掉原写入原子。新 owner 全部落在本片 23 个生产文件，新增 mutation 为 `createSelectedTaskRecoveryWritePurposes`，原 lease operations 的 mutation 行随闭合视图更新。公共面新增七个中立类型，不隐藏既有方法。

原 classic boundary 规则对同一 23 文件输入的有限核对也保留：本片 inbound 为 8→9，outbound 为 0→0；services 的类型引用换到具名恢复视图，未增加 infrastructure→composition 依赖。这是原规则的真实记录，不将 canonical role 解释成 classic boundary 通过。原 Task/HumanGate/lifecycle 内核及三份全文件有限逆变换结论保持。

## 发布与后续验收

配套功能门将审查冻结源码、13 份真实输出、全部库存差异、原控制、历史失败及本文件。通过并由根会话消费后，在短发布锁内精确提交 46 个路径；共享 STATE／plan 原正文及并行内容完整保留。紧邻普通后继提交仅删除六项一次性增长许可，恢复这一次成功 census 的完整原 ledger 字节；不改库存基线、原 why、顺序或历史。

推送后按最终完整 SHA 验收主 CI 与默认完整 Windows。旧 HumanGate／lifecycle 的 398 次实际案例与新资源恢复的 67 次实际案例共 465 次：Ubuntu 231、macOS 117、Windows 117；案例名称、provider、预算和旧断言保持，缺失、重复、失败、skip、todo 都须为零。源码门、清单生成和测试注册均不代签这些结果。

完整 H7、十九个真实 owner、三条真实启动根、A-T7／A-G、各层独立 CS adapter 与 M0～M4 继续开放。AW 尚未部署到 CS，RFC 未完成。既定顺序继续保持：先完成宿主切面重构和原本地回归，再编写所属模块内的独立 CS adapter；M0 先实际部署并验收身份、编辑与持久化，然后逐步接入执行、环境、事件／webhook 和迁移能力。

## 配套 R1 未通过，R4 先修正 public 引用

上文是 R3 私有发布候选的历史数据与待执行计划。MATCHING R1 随后正式 FAIL／一项 P1，根已核对全部 114 份冻结身份并消费 12 条功能分析。原 classic inbound 实测 312，而候选登记 309；三处服务新增的 type-only import 指向 Task application 内部，原精确 equality 断言因此不能通过。canonical 分类和成功 census 都不能代签这个原断言。该候选没有提交、没有写主树清单；上述两次尝试、R3 成功输出及正式 FAIL 保留。

后续 R4 将这三处 import 改到既有 Task public/participants 类型出口，三个服务的完整方法体与测试／Windows 保持。采用已有正确合同，不增补内部依赖债务。R4 源码通过独立有限复核后，再对改变的候选生成一次原清单并消费新的配套门。届时增长许可、退役字节和精确路径按新实测数据核对；上文 R3 的六项许可与 46 路径计划尚不构成发布授权结论。新的源代码门、清单配套门、最终 SHA 总绿及 465 次执行验收仍待完成。

## R4 当前候选的原清单与配套输入

SOURCE R4 已正式 PASS／零 findings，根已消费 104 份完整材料与九条有限功能分析，按 89／93 份相同完整身份复用 R3 原分析和全部 17 个案例结论。修正后的三份服务按 import 字符串逆变换恢复 R3 全文件；原 public 类型与方法体、旧回归和 Windows 完整字节保持。正式 MATCHING R1 FAIL 不被覆盖。

改变后的 R4 源码执行一次原 scoped census 成功，原四规则及 opaque allowlist 保持，13 份输出仍只在私有候选。历史累计三次尝试：R2 中止一次、R3 成功一次、R4 成功一次；各自结果均保留，未对同一候选重跑。新 source digest 为 `sha256:b4ddc0dd210c3b8b5159fe69cfa898172328422953c7d73b6be85baa1203922c`。28 个原纯声明逐字节再现本次 13 份 raw 输出，没有第二次 R4 census。

R4 实测六项增长及 transaction callback 的下降数值与上表分别相同，新增 21 owner 和一项 mutation 的范围也相同，但三处依赖边的真实目标已换为 exact public，不能借用 R3 的旧边身份或旧配套结论。Classic 对同一 23 文件的 inbound 实测为 8→6、outbound 为 0→0。整仓实测与 commons-debt 登记均为 inbound 309、outbound 46；原两个旧 TaskRecoveryOperations 类型债随真实删除退役，剩余 authored 行的全部字段／why／顺序保持。这三条 public 类型边不需要新增内部债；canonical exceptions 的数量不能用作 classic 通过依据。原逐条相等断言完整保持，行为执行仍由 GitHub 验收。

本次待审发布候选仍精确 46 路径，包含 13 份真实清单和完整 STATE／plan；未来启动根设计文件不在本片提交范围。六项真实增长许可只在源码消费提交存在，紧邻普通后继提交恢复本次完整 raw ledger：137171 字节，SHA-256 `0e01b060b4bb85dbb34f37cfb084c891fc01c30781e1af183dfd5f04d2d9475d`。独立配套门及根消费、新 SHA 主 CI／默认完整 Windows／465 次实际案例仍待完成；完整 H7／A-T7／A-G、CS adapter 和 M0～M4 尚未闭合。
