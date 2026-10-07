# RFC-370 宿主执行权轮询切面发布

本批在原 daemon runtime helper 增加独立 selected polling binding。启动等待原 beforeStart ACK；每次 run 前后读取同一原 grant 的动态 current，旧查询返回后不派发新工作。正常 stop／drain 保留原语义；失权只停止本轮新派发与自有等待 timer，真实 run／error ACK 仍归原 handle，旧 handle 不影响新 generation。resource-only 不创建这些运行效果。

SOURCE3-R1 和 WF1-R1 独立有效稳定 PASS，完整原 native AST 和原整套测试保持。新增 12 个用例在双 provider 上覆盖真实 RuntimeSession、启动 ACK、轮询／失权排空、实际 timer 清理、原方法／receiver／error 与旧 handle。Windows 的 push、PR filters 和原平台命令只增加该 suite 三处登记，原命令及预算保持；执行结果交精确提交的 hosted CI。

四条原清单规则按 0fdaa3ca312ef392d3df0dad72ab9c9357712da2 的已提交非本批来源，加一份冻结原生产和一份新测试，排除全部其它 WIP。首轮私有包装器在原生成器返回后因沿用上一批 production=2 而失败，输出未及时落盘；完整失败脚本、日志和 started 记录保留。按共享 main 对未完成／无效校验的例外修正为本批 production=1，原输出在后续步骤前保存。实际计数为两次原生成：一次未完成、一次完整成功；不记成一次，不再重跑。

13 份完整原输出保持。旧 27416 owner 行全部保持，只新增两个接口与一个 binding 声明至 27419；旧 366 background 项保持，一条原 timer 标记由 106 移至 250，并新增该 polling binding 分类至 367。全部原 opaque mutation 行全文保持，只新增该函数的原生成器分类至 1956。其余 JSON payload、import／exception／public／effects、SCC、target、旧分母和 classic 完整 0/0 前后保持。129 有序 ledgers 及 why 保持，对这三处测量增量消费三个声明，普通后继退役且不重跑 census。

并行 RFC-371 在普通后继 f0c94c3c65e5287940d21bf9be02f2c661bc3cc1 仅退役自己的既有 owner 声明，没有改变任何生产来源；基于该提交保留其当前完整内容，只向前投影本批已核对的清单与 provenance，不重复生成或恢复已退役的声明。STATE／plan 的旧全文及并行内容完整保留，附加本批事实。

本机未运行 AW tests、typecheck、build、service 或 E2E。有限源码、Windows 登记与配套 PASS 不代表 hosted CI 通过。实际 provider roots、19 owner、Task 全入口原事务／admission、UI、H7／A-G 与 CS M0～M4 仍开放，AW 尚未部署 CS。本批只发布 polling helper、测试、CI 登记和配套清单；独立 Task 事务包仍是后续未发布候选。
