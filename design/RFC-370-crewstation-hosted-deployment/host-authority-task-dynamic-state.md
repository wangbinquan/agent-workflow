# RFC-370 C2-W2-D：动态生成状态的准备与原结果

继续已批准的阶段 A/H7。`19bf1e1d3d22f75b6aa44f94e9dc7ada75c6e53d` 的主 CI 37901830295 全 72/72 作业和同 SHA 完整 Windows 37901896472 均成功；298 个相关实际用例已逐项核对。N2 的源码、一次原生成、配套、后继修复与正式运行证据已经分别消费。这只解除继续实施的 CI 门槛，完整 H7/A-T7/A-G、十九 owner/三 roots 和 CS M0～M4 仍未完成。

## 三个实际动作

原 [dynamicWorkflowRunner.ts](../../packages/backend/src/services/dynamicWorkflowRunner.ts) 只有三处 `persistence.saveState(taskId, dw)` 调用；按调用前已经发生的动作分类，不按方法名或 phase 分类。

| 原位置 | 原动作                                                                                                | 目的          | 保持的后续行为                                                             |
| ------ | ----------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------- |
| 341    | 人工恢复耗尽的生成任务，将原尝试预算重置为 0                                                          | preparation   | 然后才进入原循环、mint 和 orchestrator 派发                                |
| 447    | 原 orchestrator 返回、原解析与验证通过，保存 generatedDef/awaiting_confirm，并消费原 rejectionComment | issuedResults | 随后开新的确认 gate；该 gate 的 mint/set 继续使用已上库的 Node preparation |
| 460    | 原 orchestrator 返回失败或原生成验证未通过，登记该次失败并增加 generateAttempts                       | issuedResults | 原 warn 和预算判断保持；下一轮新 mint/派发另由 preparation 受理            |

取消与 processUnreaped 分支仍按原顺序返回，不新增状态保存。awaiting_confirm 重入仍只查原 holder，确需补 holder 时沿原 Node preparation。原生成预算、错误文本、触发上下文、member token、nonce、prompt、hooks 参数、discardWrites、输出转换、日志与返回值保持。

本批不接管 Resource Catalog 的人工确认/拒绝、共享 workgroup state、Task 创建与 child 创建、控制/boot 恢复写入。它们有各自的真实动作和原事务，后续逐项分类；不能因同写 dw_state_json 就归入这里的结果目的。

## 中立合同和本地装配

Task application 增加只含原 `saveState(taskId, state, now?)` 的 `DynamicWorkflowStateWriter`，以及 preparation/issuedResults 两个具名视图。现 `DynamicWorkflowPersistence` 的四个读方法和原保存方法保持，增加可选的 `writeMode: 'host-selected'` 与完整 `writePurposes`。这些合同只有原 Task/DwState 数据，没有 provider、SQL、事务 callback 或 CS DTO。

独立 application selector 在未选择时返回原 persistence 对象；显式标记或目的视图存在时，返回对应视图，缺项明确报 `task-dynamic-workflow-write-purposes-not-composed`，不补 native。三个原调用点各选择上表目的；不在通用 saveState 或整个生成 pass 上统一登记一次目的。

`composition/dynamicWorkflowPersistence.ts` 接收可选 Task `hostWrites`。缺省继续返回原 `DrizzleDynamicWorkflowPersistence` 实例，不新增选择字段；明确选择时保留四个原 reader 的 receiver，并提供两个真正不同目的的本地 writer。现三个真实 bootstrap 仍使用其原缺省装配；全根选择在后续 A-T7 单独验收，不因本工厂可选就签三 roots。

## 原快照与真实事务

原 native `saveState` 在第一次 await 前求默认 `Date.now()`，执行原 `DwStateSchema.parse` 和 `JSON.stringify`；因此调用方后来修改 state 或恢复另一个 Task 的 ambient context，不能改变已经开始的保存。这个时间与字节快照必须保持。

将这一原准备和单条 SQL 抽到 Task 自有的 `infrastructure/dynamicWorkflowStateWrite.ts`：准备函数固定 taskId、原 schema 解析后的 JSON 字符串和原 updatedAt；写函数继续同一 `workgroupTaskState` UPDATE、两个 SET 字段、taskId WHERE 和原 `.run()`，原生返回值不改变。native 方法在原位置准备，再 await 同一个写函数的原返回值；其四个读方法与查询保持。

selected writer 同样先同步固定原默认时钟和 JSON，再在首次 await 前捕获该原 Task context/token/work/capture。之后调用现 `withTaskHostNewWork` 或 `withTaskHostIssuedAck`；原状态 SQL 使用 body 给出的**实际 transaction**，再由同一 transaction 消费该原工作。PostgreSQL 的根客户端与 transaction 是不同 executor，不能假定在外层事务里调用根客户端会自动加入事务。这里明确向同一个原 SQL 函数传 transaction，不新增 owner 条件或改写原 UPDATE。

prepared 字符串固定后不重新解析输入，不在等待后重新读取 state、当前工作或 grant。原 JSON/schema 错误在进入持久等待前传播；原 SQL/body 错误在 host 消费前传播，整笔回滚。host 消费失败时原状态写也回滚，后续对该原工作的重试按同一合同执行。只有数据库与原 host 消费在事务内，不把 hooks、网络、日志、mint 或下一次派发放入这一事务。

成功生成的结果保存与后来新开 gate 是两个原步骤：结果可在 draining 下登记，gate 的新准备仍可能被拒绝。失败结果可登记，下一次新派发仍须准备。保留已保存的准确检查点与原重入行为，不用 ACK 启动新 generation。

## 功能回归和交付

新增独立真实双 provider 套件，复用原 shared installation/Task host fixture 与真实 workgroupTaskState。覆盖 native 原实例/读方法、两视图及缺失选择；两目的的实际 SQL和消费一次、同 transaction、body/host 失败整笔回滚及原工作重试；默认/显式时钟、原 JSON/schema 错误和缺失行 no-op；等待期间 state 修改与另一 Task ambient 不改变原快照/工作。真实生成器配原测试既有 scripted hooks，核对人工预算重置、成功结果后开 gate、失败结果后再试、draining 下结果落账与新 gate/下一轮拒绝，保持真实 Node SQL和原参数。

有限源码合同双向枚举三个原保存调用及 1 preparation/2 issuedResults 的位置和输入，同时核对原 Node preparation 与四个只读调用不变。现 RFC-167、RFC-223 和 RFC-370 N1/N2 测试的完整正文、全部旧断言/预算保留；不靠只测 selector 或假 SQL 代签业务接线。

先独立功能设计门并实际消费回执，再实施、独立源码实现门、一次原 scoped census、配套门与精确发布。新测试上 main 后再登记原 Windows workflow；同 SHA 全仓主/Windows 总绿与实际案例逐项验收。不得重复原 N2 的 census 或把本地格式/lint当作 hosted 运行。所有门只审功能；安全相关一律不扫描、不分析、不验证、不提问、不提 findings、不提建议、不转成任务，也不得影响门检视结论。

本批尚未实施，尚无 CS adapter 或部署；RFC 继续推进。完整 A-G 后，各层分别编写独立 CS adapter，先 M0 必要能力实际部署，再逐项接入 M1～M4。

## 设计消费后的有限实现候选

DESIGN44-R1 独立功能门有效稳定 PASS、0 findings；完整回执 500004 bytes／sha256:cff043e8754a65d1bfa15f72672777480321bd65c6dc6dc0e22317830aa9659a，根已核对全 44 项、三个包装及全部功能分析并消费。上述“尚未实施”是设计冻结时的状态；现进入有限源码候选。

候选七个生产文件完成中立 writer/两目的、selector、可选本地装配、原快照/单 SQL 抽取和三个真实调用。三处调用及新增 selector import 做完整逆向后精确恢复原生成器全文；四个原 reader 的完整方法正文逐字保留。原状态 UPDATE 从无 Task owner 条件或 owner revision 更新，本次也不新增；只将原 SQL 与已有 host 消费放入同一实际事务。

新增独立真实双 provider 测试有 26/provider 和一个有限源码合同，含真实生成器与 Node SQL。覆盖两目的真实保存/消费一次、实际 transaction、host 拒绝及原 NOT NULL SQL 错误回滚与原工作重试、输入与默认时钟快照、原 Task、schema/JSON 错误、缺行、预算恢复、生成成功/失败与独立 gate/retry、draining、取消/未回收退出、原 holder 重入。旧 RFC-167、RFC-223 动态 token、N1/N2 正文及预算保持。已做限定格式/lint/差异检查，尚未运行新案例；没有本机 AW tests/typecheck/build/services/E2E 或 census。

下一步独立源码功能门并消费，随后只运行一次原 scoped census、处理配套、精确上库，再登记新 Windows 测试并验收同 SHA 全仓 main/Windows 总绿与实际新案例。其余 H7/A-T7/A-G、十九 owner/三 roots、CS adapters/M0～M4 和 RFC 完成仍开放。

## 2026-10-09 C2-W2-D 原生成与配套候选

动态状态 SOURCE9-R2 有效稳定 PASS、0 findings 已实际消费：43 项（9 owned/31 control/3 evidence）、三个包装及全部功能分析首末一致；回执 127314 bytes／sha256:ca524961177d191483b19a0048a4b7a7ed57b6db94735994e7973bfffaf557f8。七个生产文件、一个新测试保留 1 preparation/2 issuedResults 的三处原动作、原 SQL/时钟/JSON/Task 工作与同一实际事务，四个原 reader 和完整生成器逆向证明保持。26/provider+1 global 的新案例尚未运行，旧 RFC-167、RFC-223、N1/N2 全文和预算不改。

本最终源码候选的原 scoped census 只执行一次，固定 19bf1e1d3d22f75b6aa44f94e9dc7ada75c6e53d，8 冻结 TS（7 production）与 6797 个非本批已提交源码，四条原规则全文不改；13 完整私有输出 sourceDigest sha256:a2416dd0cf4891ecedea696fc545c118dc4e44e5048ce5c9a7654e75e03005e5。并行观测的 7 tracked/6 untracked TS 在制内容被排除并完整保留，无本机 AW tests/typecheck/build/services/E2E。

实测 classic inbound 4→5，唯一新增为原 services/dynamicWorkflowRunner 到 Task application selector 的 value 边；原四条边逐项保持，outbound 0→0。不用 canonical role 推断 classic 分类；生成器完整 public 边界收口仍在 A-T7。原 130 行有序库存与每条 why、356 条 authored debt、40 required SPI/69 target edges 和空 implementation SCC 保持。

四项实际增长各只声明一次：mutation 1983→1984、observed imports 6889→6894、exact compatibility exceptions 6033→6037、symbol owners 27728→27738。新增三个生产文件及十个 file/symbol owner、五条实测导入、四条原规则精确兼容项和一条分类 entry 全部保留原输出。原纯治理/JSON 函数先整字节复现四份治理输出，八份 canonical 与另外三份治理、status 原完整输出保持；增长声明在源码消费后的普通后继退役。

配套功能门、精确上库、新测试上 main 后的原 Windows 登记、同 SHA 全仓 main/Windows 总绿与真实新增案例分别验收。历史 19bf 总绿和 298 例只作已消费前置，不代签本候选。其余 Task 生命周期/人工控制/child/workgroup/boot、十九 owner/三个 roots、完整 H7/A-T7/A-G 和各层 CS 独立 adapter、M0 首次部署到 M4 继续；AW 尚未部署 CS，RFC 未完成。全部旧正文与并行输出保持。
