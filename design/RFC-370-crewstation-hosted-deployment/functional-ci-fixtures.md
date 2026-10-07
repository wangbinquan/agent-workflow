# RFC-370 功能 CI 夹具与登记修正

本批依据原 4c4ecbc14afa80982298c47a2ac57761bb1ac74c 的主 CI37592876200 failure 修复功能夹具；原失败及完整日志保留，最终以本批精确 SHA hosted CI 为准。

六处 TypeScript 报错保持原断言和控制流：diagnostics getter 显式返回 Readonly<Record<string, unknown>>；drain 的 void／PromiseLike 以 Promise.resolve 保留真实完成确认；两个 optional 值明确 expect 泛型；启动参数补既有必需 inputs；supervisor release 仍按原 boolean 合同返回。

真实启动请求使用现有 scratch:true，并补用户 Git 提交所需 email；不改变启动 schema 或生产能力。工作组恢复续接夹具按原 decoder 提供 v1 gate、operationId、节点 projection 和 continuationLineage，保留原恢复断言。源码 reader 精确匹配当前 launchConfigurationOverrides spread 和 selected 调用，原 fresh-read、唯一解析函数及预算保持。

Task insert 四个原站点与 executionLineageId／lineageSlotPathJson／launchOrigin 齐全判据不变，仅更新原 AST 派生的两个物理位置：postgresqlFusionEngineTaskOperations.ts:118→121，services/task.ts:2473→2504。原 matcher、测试、断言与四站点顺序完整保留。

Off-DAG 的原46条记录全文与顺序保留，新增实际 Task infrastructure hostExecutionWriteContext.ts→system-operations exact public type 消费一条；保留原 Task application 无 SO／DB 形状。原 ledger 此项仍为43，按实际完整声明修正至47，其中三个 Task Runner→memory 地址已在此前源码中提交。本批仅登记一条实测 one-commit growth 许可，消费后普通后继退役。完整129行库存、why、预算、排序及其余字段保持；digest 使用原五个纯 JSON 函数重算。原 DAG、分类器、测试预算及 assertion 不变，各记录原清偿波次保持。

本机只有本批 format／lint、纯 AST／字节／JSON核对，无 AW tests／typecheck／build／service／E2E、无整套架构 census。本批不包含 C1 production 在制输出，不声称行为 CI 通过。独立有限实现门、根实际消费、精确路径上库、远端同步及新精确 SHA hosted CI 分别验收；H7／A-T7／A-G、CS独立adapter与M0先部署至M4继续开放，AW尚未部署CS。

## 2026-10-07 功能 CI 夹具修复发布与一次声明退役

SOURCE12-R1 有效稳定有限 PASS，root 实际消费完整41项及3wrappers后，十二相关路径精确发布8fb6742f7baf70f57fe223c8c7bf06aa29dcb3b7。main／origin同步0／0、index为空，C1及C2的全部在制工作字节保持。主CI37623212828和Windows37623212950已登记，终态待验，未记全仓通过。

本普通后继只退役已经消费的 rfc294-review-off-dag-offered-edges 一条实测许可；47完整声明及原129有序ledger/baseline/why/预算保持，使用原五个纯JSON函数重算payload digest。原八份测试和所有源码／架构快照不动，无新census或本机AW运行。原source有限门、精确发布、普通后继有限门和正式CI分别留证。

C1的首轮两项测试配置P2、原FAIL/root消费及修正保留，修正后的SOURCE6-R2继续复核，不包含在这四路径提交。实际Task调用者、原退场ACK、19owner/roots/UI、完整H7/A-G及独立CS adapters/M0先部署至M4继续，AW尚未部署CS，RFC未完成。旧共享正文与并行内容完整保持。
