# RFC-370 功能 CI：公开入口与完整启动根

本批修复已发布实现的功能 CI 失败。完整 H7、A-G、CS adapter 和 M0–M4 均未完成；AW 尚未部署到 CS。本机不运行 AW tests、typecheck、build、服务或 E2E。

## 正式失败依据

`79d31c961f858f4aff81543a9f5b70b22c951ccc` 的主 CI `37557367648` 已终态 failure：72 个作业，55 success、17 failure。四个初始失败日志及其余后端失败日志全文保留在本批私有证据中。Purpose 的原 EvidenceStore receiver 和旧 fixture 类型已由 `e4bd62318e12848d730b1c52f2dd29706e9da5e1` 修复；并行前端 null 类型修复已随 `fcb05baef62ddfe16fc2fe572a85b3c1e6cd6543` 发布。这些提交不能替代失败 SHA 的原终态。

`53be4913a91aad4385cdf52ee4c195abc0ba0e11` 的 Windows `37569551998` 已终态 failure，RFC-254 阶段有五条失败：原生采集 protocol 分支、W29 的实参断言、PG/SQLite 完整根、MCP 完整根。该 SHA 的 maintenance soak `37569551982` 和 git protocols `37569551980` 均已终态 success；主 CI 尚待终态。原生采集分支来自并行输出，其修复 WIP 保留，不随本批提交。每个 workflow、步骤和 SHA 独立记账。

初始日志索引错误地把通过用例名称中的 `(fail)` 当作失败，旧 r1/r2 诊断原样保留。r3 改为仅识别正式时间戳后的 `(fail)`，排除 `(pass)` 和末尾汇总重复。cross-clarify 实际通过，未修改该 fixture。只处理功能范围。

## 生产修复

- `HostExecutionAuthorityFactory.create.provider` 使用平台的 `DatabaseProvider`，保留全部其他成员和运行行为。绑定实现的 provider 别名 WIP 属于后续 H7 源码片，不并入本片。
- 原两条 evidence staging 完整性校验函数原样移到 DA application 层。exact `public/participants` 继续提供相同名称；模块内四处导入只改物理路径。删除本批自己引入的非标准 `public/evidenceStaging.ts`，恢复 exact public 入口形状。
- 不改变 staging 校验、资源对象、异步 ACK、旧持久化事实、效果顺序或业务运行时。

## 原判据保持

`rfc284-spawn-site-ratchet.test.ts` 仅把原 process-group 条目的物理路径更新为 `infrastructure/local/developmentAdapterProgram.ts`；原 detached/回收协议、治理说明、数量断言和预算保持。

两条 evidence 源码读者改为检查实际 Purpose 根：先验证每个根接收原完整 artifacts/documentCommands 对象，再验证 DA 消费该根的完整对象。DEOS 和 Mission 的原独立接线断言、异步 ACK 用例、双 provider HTTP 事实断言和 20 秒预算保持。

三条已存在的 DA→Integration exact public type 边精确入原 off-DAG 清单。目标 DAG、分类器、所有旧条目、理由和集合相等断言保持；清偿点明确为 RFC-370 A-T7，不能算该波已完成。

W29 与 MCP 原完整函数摘要、语句数、阶段/生命周期及 MCP 实参摘要保持。新 helper 只逆变换 `53be4913` 的精确已审 Task 配置及并行 Native 接线：三条真实根加 SQLite API 装配，每条新增/变化语句检查固定名字及完整 AST 打印摘要，完整人口和缺失项检查仍保留；其他语句交回原完整函数判据。历史语句正文来自真实父提交 `fcb05bae`，通过一次纯 AST 重建与该父提交逐条比对，不放宽成局部摘要。W29 同时检查当前 HTTP mount 的四个实参，包含新增 Task 配置。重新解析恢复全文后按同一文件名识别原 provider，避免把新 SourceFile 对象误认为另一 provider。该 helper 不执行产品代码。

所有实际运行用例、原超时预算和完整原摘要均保留。本机只做自有格式/lint、纯 AST/全文对照与唯一原 scoped census；这些不冒充正式 hosted CI。独立功能门、配套清单门、精确发布及新 SHA CI 另行留证。后续继续 H7 三根执行权、19 个 handle、早期恢复、同事务 holder 准入和 UI，随后 A-G，先 M0 部署再逐项接入 CS。

## SOURCE16-R1 功能失败与 R2 修正

SOURCE16-R1 独立检视为有效稳定 FAIL，仅一项 P2：DEOS materializer 的实际调用是 `await evidenceStore().materializeBundle(...)`，读者仍精确匹配旧的 `store.materializeBundle`，因此实际计数为零。原 57 项首末全文、两项完整补充控制及原正式失败回执完整保留。根会话已实际消费全部内容和三个 wrapper，未将 FAIL 当作可发布的通过。

R2 仅把该读者字面量改为真实调用地址，原次数 1、直接 await 判据、全部双 provider 运行用例和预算保持。生产 lazy receiver 和 Task/Purpose 根不改；所有旧根完整摘要与语句数仍交原精确逆变换判据。原生采集分支修复随后由并行 `25da3dd426215aeb6873c19d575f1ec413e9f5fd` 正常发布，本文此前 WIP 记录作为当时事实保留。main/origin 当时精确同步，未发送跨会话消息。R2 独立门、原唯一静态生成、配套门与新精确 SHA hosted CI 仍分别验收；完整 H7/A-G、CS adapter 及部署保持开放。

## 2026-10-07 PostgreSQL 重解析后的原完整装配断言

698feafd 的 Windows 平台作业实际为 719 pass、3 skip、1 fail，唯一失败是 W29 PostgreSQL daemon 的原完整打印体摘要。Task 的严格语句逆变换返回同文件名的新 SourceFile；boot recovery 和 verification 两个旧逆变换仍比较旧 SourceFile 对象身份，因而跳过原已登记的两处恢复。现在它们与其余同文件 reader 一样按完整原文件名判定，仍完整验证各自唯一实际调用和原参数后才移除对应增量。

新增回归实际经过 Task 逆变换得到不同对象、相同文件名，证明两处原逆变换都执行，真实恢复与 DA 调用继续各保留一次。原全部 case、预算、176 条语句和 9130fad695ac09680662e30fdd71ed0175a058a27c3c56dc2091ca1fead78e3d 全体摘要保持。纯 AST 诊断先逐字复现该作业的 26d30af8ddb37afed40a2a5ab4054e9f45602d481ec386114b995d527338d8cc，再得到原摘要；没有运行本机 AW 测试、类型、构建、服务或新 census。两路径有限功能门、新精确 SHA CI 分别验收，不能将源码对照结果记为 hosted CI 通过；完整 H7、A-G 与 CS 部署继续开放。
