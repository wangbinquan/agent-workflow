# RFC-370 C2-W2-R：Task 执行期原生会话租约切面

本批继续已批准的 Stage A／H7，只设计 Task 执行期七个具名会话租约操作。先完成 C2-W1 发布和 C2-W2-E effect 写入，再实施本批；正在发布或复核的文件保持原样。这里不签完整 Task 业务分类、三个启动根、十九个 owner、恢复管理面、A-G 或 CS 部署。

## 真实调用顺序

现有 `RuntimeSessionLeaseOperations` 同时含执行期操作和 `repairAfterOrphanReap`。后者由启动恢复、Task recovery administration 及 child lifecycle 使用，不能把整个旧合同统一换成执行 ACK。现有工厂和完整旧合同保留；新增 Task 自有执行期合同，只包含 load 和下列七个方法。原完整对象在结构上仍能作为执行期合同输入，native 调用行为不变。

Task runner 在 `preparation.compile`／实际 spawn 前依次 preclaimResume、confirmResume；confirm 只是把待恢复会话链接到当前 nodeRun，还没有执行恢复请求，所以两者都属于新准备。claimNew 在已启动进程的真实 stdout 首次返回 sessionId 时调用；rotate／markResetPending 接收同一个已发进程的会话事件；release／discard 在原清理路径中保存已持有租约的结果。

| 原具名方法       | 目的       | 保留的原行为                                                                          |
| ---------------- | ---------- | ------------------------------------------------------------------------------------- |
| preclaimResume   | new-work   | 当前 running run、原会话归属、原租约 CAS、nonce 和原结果 token                        |
| confirmResume    | new-work   | 原待恢复 token 与 nodeRun 的链接及原 native usage root 记录；不能视为已执行恢复的结果 |
| claimNew         | issued-ACK | 已发进程实际返回的新 sessionId、原 nodeRun 投影和原 native usage root 记录            |
| rotate           | issued-ACK | 已发进程的 reset 结果、新旧原生 session 归属、原事件回标及原 nonce                    |
| markResetPending | issued-ACK | 已收到的 reset／protocol-invalid 事实及原会话失效投影                                 |
| discard          | issued-ACK | 原已持有租约清理、原会话行删除和原 run 投影                                           |
| release          | issued-ACK | 原已持有租约释放 CAS 与原 boolean 结果                                                |

load 仍是原读取。旧 repairAfterOrphanReap、启动恢复与 child recovery 合同完整保留，在单独的具名 recovery／terminal-control 批次适配。resource-catalog 的 MCP 测试租约是另一份合同，不属于本 Task 切面。

## 分层与所选实例

Task application／ports 增加执行期合同，Task infrastructure 增加所选执行期 adapter，Task composition 暴露显式装配工厂。工厂要求原 db 与 Task 自有 hostWrites；不接受 CS DTO，不选择 provider，不导出数据库或回调到 public 合同。原 `createRuntimeSessionLeaseOperations(db)` 及其完整对象、源码、SQL、错误分类、自动序列化重试和修复循环保持。

新 adapter 在装配时保存同一 db、原 native operations、各原方法及 receiver。它用 C1 已有具名事务 helper 包住对应原方法：隔离档仍是 serializable，内层原方法通过原 DatabaseSession 的客户端 AsyncLocalStorage 帧复用同一实际事务。原 SQL／CAS 和 Host 消费共用一次真实 COMMIT；不在这里重写租约算法，也不以方法返回冒充 work complete。

claimNew／preclaimResume 在首个持久 await 前取得匹配 Task 的完整原 TaskExecutionContext 对象，保存该同一 context、其 token 关联的原 admitted work、capture 和所选 binding。原返回的 RuntimeSessionLeaseToken 对象不改字段、不复制，在实际事务成功后于 adapter 私有 WeakMap 关联这组原对象。confirmResume／rotate／markResetPending／discard／release 只取原 token 的关联；每次原方法调用及其嵌套事务均通过 runWithTaskExecutionContext(originalContext, ...) 使用同一原上下文和保存的 method／receiver，离开或遇到不同 ambient context 时仍使用 token 自身的原关联，不能依赖调用时上下文。rotate 成功后把原返回的后继 token 关联到同一组对象。不可在 await 后按 Task id、当前 host grant 或数据库行重建 work／context，不创建替代 TaskExecutionContext、不更换原 OwnershipToken，也不重新 acquire 或 complete。

所选执行期装配缺原 Task work、原 token 关联或 binding 时明确报装配错误，不补 native。未选这个 adapter 的原 native 工厂照旧运行。失权／draining 下 preclaimResume 和 confirmResume 拒绝并回滚；五个真实结果方法消费原 issued-ACK。原业务体先执行，保留原业务错误优先级；Host 消费失败则原 SQL 和 owner revision 一起回滚。序列化重试使用首个 await 前保存的同一 capture、同一 method 与 receiver。

Task runner 的租约输入类型及 services/runtimeSessionLease.ts 中 get／claim／preclaim／confirm／rotate／reset／discard／release 八个执行 helper 的 operations 参数一同收窄到同一执行期合同；原完整 native 对象仍满足它，原参数验证、转发 method／receiver 与返回值不变。repairRuntimeSessionLeasesAfterOrphanReap 继续要求原完整 RuntimeSessionLeaseOperations，旧完整类型出口和 native 工厂保留。实际 roots／provider runtime 的选择、child／boot 的独立 recovery 装配在后续根接线批次验收，不能因本工厂存在就记为已接入。Task 尚未部署 CS。

## 必须验收的功能

使用 C2-W1 真实 Task claim／context／token、真实 nodeRun 与两种 provider，验证七个原方法的成功结果和原数据库事实；load 保持原读取。检查内层原 serializable 方法与外层消费复用真实事务，没有第二次 BEGIN 或独立 COMMIT。

在原 preclaim／confirm SQL 完成后失权，验证租约、nodeRun、native usage root、owner revision 全部回滚，调用者没有取得下一次恢复准备。draining 下五个真实结果可落库，原原生 token 字段、对象与 nonce 保持；原 work 没有被完成。覆盖 rotate 后的原后继 token、原 token 离开 ambient context 或处于另一 Task 上下文时仍用自身完整原上下文保存清理 ACK；验证原 context／OwnershipToken 对象没有重建、替换或依赖调用时上下文。覆盖原业务错误优先级、ACK 失败后真实重试、selected 缺少原关联，以及窄执行期对象能经过原八个 helper 输入合同而旧 repair helper 仍要求完整合同。旧完整 native 套件、修复循环和预算保留，恢复本身不在此取得实现完成信用。

先独立功能设计门并实际消费回执；前置批次发布后才实现。本批再走独立源码门、一次原静态生成和配套门、精确发布及 exact-SHA hosted CI。本机不运行 AW tests／typecheck／build／service／E2E。完整 H7／A-G 之后才进入各层 CS adapters，按 M0 先部署、M1～M4 逐步接入继续。

## 有限设计门修订

DESIGN1-R1 的稳定正式 FAIL 已由 root 完整消费，F01／F02 保留：原 token 没有完整 TaskExecutionContext 时，原 fence 会按 ownerless 拒绝仍 claimed 的 owner；仅收窄 runner 输入而未收窄原八个执行 helper 也无法闭合类型。R2 明确保存和恢复同一完整原上下文，并一同收窄八个执行 helper，repair 合同保留。此处仍是设计候选，须取得并实际消费 R2 独立回执，前置批次实际发布后才实施；不记实现、CI、完整 H7／A-G 或部署完成。

## W2-R 实现候选与验收边界

原设计 DESIGN1-R1 为实际 FAIL，原完整 TaskExecutionContext 和8执行helper参数切面按原结论补齐，DESIGN1-R2 正式有效稳定 PASS 已由根实际消费，FP `6cd75e6964727ffca721fd3b0666ab1aea9d9bb93bd71af805bf9973b4c4aad4`；29原条目在实施前完整保持。C2-W1原认领片与 W2-E effect/原 CI 修复 exact26实际发布 `00ce2fea044e3ed32a02cb7d13f1bcdd6affd6c8` 完成后才应用本候选。

Task application新增执行用窄port，仅load与七个原执行mutators；Task agent输入与原facade八个执行参数同型收窄，repair参数、旧完整native类型出口及原native factory/recovery实现保持。所选adapter保存原八method refs/receiver与原complete TaskExecutionContext、OwnershipToken关联work/capture/binding；所有mutator第一await前选择原工作，token WeakMap只在真实外层提交完成后登记，rotate继承完整原关联。preclaim/confirm是新工作；收到新session、rotate/reset/discard/release是原结果ACK。token方法即使在原ambient之外或另一Task中仍恢复同一个原context对象，C1外层serializable与原native嵌套frame、SQL、业务错误和返回保持。load只读调用原ref，不增加admission或事务；不调用acquire/complete，不构造替代context，不给boot repair混入执行窄port。

新增14个真实 SQLite/PostgreSQL用例/每provider，保留旧两个原native suites与全部assert/budget，覆盖两protocol issued/new resume、SQL后失权回滚、原完整context恢复、token身份、原receiver跨await、rotate原后继、ACK失败重试与原错误/false结果；Windows原双path过滤与同原命令登记一次，不改变预算。用例由精确SHA hosted CI验收，本机仅owned format/lint/纯AST/字节JSON，无AW tests/typecheck/build/services/E2E。

此记录只登记 W2-R有限源码候选，独立源码门、一次不同源码候选原scoped生成、matching与实际publication/精确CI另留证。原Task agent真实root、两个provider/HTTP组装、child/boot recovery、其余Task/Node与19owners/三执行roots继续后续明确接线；H7/A-T7/A-G尚未完成，AW尚未部署CS。继续完成阶段A后各层独立CS adapters；M0先实际部署，再M1～M4逐步接管，RFC未完成。

原设计29个条目及六份原生控制全文在当前 b8c13249 仍相同；此 SHA 主 CI 37768698721 全72作业及同 SHA Windows 37768853703 正式成功，用户总绿门槛已满足，才恢复本批源码实施。Windows 并行 historical 接线完整保留；本批发布先排除该共享 workflow，等其引用的并行新测试上库后再验收完整 Windows 接线。

## 2026-10-08 W2-R 源码门与一次配套生成

SOURCE9-R1 独立正式有效稳定 PASS 已由 root 实际消费：9 owned、19 control、7 evidence 共35项／835583字节，FP `057bf16243206d931363ebdcfe7771afdb407a5ecce7588771dce9d9e6242133`。八项原方法的完整原 context／token／work、实际提交后关联、同一原事务、业务错误及旧 native factory／repair保持；完整旧回归不改。新增14例/每provider由 hosted CI验收，本机只做 scoped格式／lint与纯AST／字节核对。

唯一原scoped census固定已总绿的 `b8c132497e1845d5268cc6bddf27089374a1c687`，覆盖本批7个TypeScript（6生产）和6756个已提交非本批源blob，排除并行源码在制内容；原四规则字节保持，13原始输出完整保留。实测owners27615→27623、mutation1969→1971、observed6853→6855、exceptions6001→6003，登记4项一次声明并由普通后继退役；129项完整有序库存、旧why及全部其余预算保持。原355条 authored debt全文保留，移除实际消失的Task→legacy窄类型边，登记实际新增的facade→Task执行port类型边；总数356，classic inbound309→310／outbound47→46。其余既有所有owner行、公共表面、guard内容保持，原8 canonical与原status输出全文保持，sourceDigest为 `sha256:8f8dfe8bb9a7ed2fba18babadbcbd8d7b4980b91e905e7bdcec499c03d4f8576`。

配套仅调用原纯JSON治理函数及原pretty/ascii格式函数投影；首轮私有presentation断言失败记录保留，修订后复现原4治理对象和原格式字节。未再跑整仓census、canonical采集器或AW tests/typecheck/build/services/E2E。旧共享STATE/plan完整前缀与全部并行输出保持。MATCHING16功能门、精确23路径发布和新 SHA主CI仍需实际验收；共享Windows暂不提交，避免收编其引用的并行未追踪测试。实际roots/provider接线、child/boot恢复、其余Task/Node及19owner/三roots、H7/A-T7/A-G与CS M0～M4继续开放，AW尚未部署CS。

原生成status及新追加文档只作Prettier空白与表格分隔线排版归一，原JSON输出和正文内容保留；配套门按实际最终字节绑定。
