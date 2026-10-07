# RFC-370 Task 原写上下文捕获与具名事务发布

Task application 捕获原 host write port 的三个方法、receiver 和 receipt，跨 await 后继续消费同一个原工作。Task execution context 的原冻结对象、字段、品牌和 ALS 行为保持；capture 在 Task 自有私有映射中传递。独立 infrastructure 提供 new-work、recovery、issued-ACK 三个具名事务入口：原业务 SQL 和 owner 条件先完成，成功后才在同一原事务消费原收据，失败整体回滚，实际 ACK 被等待。

native 路径继续原事务行为；selected 必须装配完整 capture 和 binding，缺项明确拒绝。实际 Task claim、heartbeat、driver、业务写入及 finalization 调用者尚未接入；下一 C2 设计必须完成实际原受理、失权后的回执清理与重试。当前仍是阶段 A，H7／A-T7／A-G、三个 roots、19 owner、UI 与 CS M0～M4 继续，AW 尚未部署 CS。

## 功能复核与真实回归

设计门的原 schema 绑定失败与修正后 PASS 保留，root 在创建新生产文件前实际消费修正后的设计回执。SOURCE6-R1 有效 FAIL 的两处 P2 都是新用例的 provider 配置：嵌套事务必须传原 database client，以复用原 PostgreSQL transaction frame；跨库回滚用例必须显式配置 `databaseCount:2`。root 消费真实 FAIL 后，仅修这两处输入，另外五个 owned 文件不改。

SOURCE6-R2 有效稳定有限 PASS：6 owned／23 control／27 evidence，共56项、1,695,212 bytes，FP `3983717af40e8774f08183992c6d1bc1c2285d5a97f0a7d455588bc740f4851a`。原12个 case、75个 expect、名称、预算及全部原语义保持；两处 fixture 修正没有删改任何原断言。新增套件使用真实两个 provider、原 Task claim／owner CAS、实际事务与 SQL，覆盖 await 后原方法保留、失权后整笔回滚、已发出 ACK、错误优先级、实际 ACK 等待、嵌套原事务和另一数据库拒绝。

Windows 只在原三个位置追加这一套件，原78个命令 token 内容／顺序和完整旧 YAML 逆向恢复保持。本机仅对自有文件做格式、lint 和纯 AST／字节核验，没有 AW tests／typecheck／build／services／E2E。新精确 SHA 的正式 CI 另行验收，有限源码门不等于全仓绿。

## 一次原架构生成与配套

唯一实际 original scoped census 固定 `3dc43c139e645abca6deaf10d8179bff63f57c75`，叠加已复核的3个 production 文件（1个原文件、2个新文件）和1个新测试，其余6720个非本批源路径取该 SHA 的原 Git blob。原四条规则全文保持，成功一次，13项原完整输出在投影前保存。sourceDigest 为 `sha256:27dc496dc8e2e0c0f8cf303d1d98146b62f088aa06808a2eddd4a9fff39d536b`；完整 classic before／after 数组均为0／0且相等。

原全部 manifest 行、相对顺序、业务字段和129项有序 ledger 的 why／预算保持。实测新增21个 owner、两个 recovery 函数被原规则识别为 execution-local 条目、两个原 transaction callback，以及一条 Task infrastructure 到既有 `ProviderNeutralDatabase` 类型的 observed import／exact classifier exception。新增 exception 按原生成字段保存，不把新边称为旧债；没有新增定时器、SCC、mutation 或 public surface。

五项实测 baseline 变化附一次声明：transaction 271→273，background 367→369，imports 6814→6815，exceptions 5981→5982，owners 27444→27465。沿原五个纯 JSON 函数刷新 ledger payload 摘要；本批消费后由普通后继删除五条声明，无须再次 census。状态 Markdown 保留原生成全文，STATE／plan 的完整旧前缀及全部并行输出保持。配套独立功能门、精确提交／远端同步和正式 CI 各自验收。

私有修正证明的两次失败和缺少有效证明而停止的 freeze 包装均保留；成功证明使用原 TypeScript AST，显式允许上述两处 fixture 输入差异，完整核对其他用例与断言。原失败回执、源码候选和唯一原生成输出不改写，不以证明失败触发新 census。
