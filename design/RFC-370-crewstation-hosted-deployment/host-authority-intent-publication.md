# RFC-370 Intent 排队恢复切面发布

本批将 Intent 的排队恢复分成原 native 生命周期和捕获执行权回调的 selected 生命周期。原 `.start()` 保持零参数；`.startAuthority()` 固定原回调身份与 receiver，在每次配置读取之前及读取完成后检查本代执行权。过期代不恢复业务，待处理 ID 留在原集合，由下一代按新配置继续；已经发出的恢复等待原真实 ACK。原批处理、错误传播、正常停止及排空语义保持。

SOURCE4-R1 独立功能复核有效 PASS；WF1-R1 仅在 Windows push、PR 和原平台命令三处加入新回归集，完整 YAML 逆变换保持旧输入、步骤及预算。新回归覆盖两种数据库 provider 的失权、持有读取、真实恢复 ACK、回调 receiver 和原 native 行为。功能执行结果以提交后的 hosted 精确 SHA CI 为准；本机没有运行 AW tests、typecheck、build、service 或 E2E。

配套清单由四条原规则在 `4c4ecbc14afa80982298c47a2ac57761bb1ac74c` 的完整已提交非本批源码，加两份冻结生产文件和一份新测试输入进行一次 original scoped census 生成。非本批 Task 和 RFC-371 在制源码被明确排除。13 份原生成输出完整保持；12 份 JSON 的所有业务 payload、数组、分母和 129 条有序 ledger/why 全部不变，只更新该源码快照摘要及原 provenance。classic 完整前后数组相等；没有一次性增长声明，也无需退役后继。原生成 status 全文直接使用，没有修改四条规则。

本批只形成 Intent owner 切面。实际启动根尚未接入此入口，完整 19 个后台 owner、Task 原事务与执行准入、UI、H7/A-G 和 CS M0–M4 均继续开放；AW 尚未部署到 CS。源码、配套清单及 Windows 登记各自独立门的原始回执完整保留，有限 PASS 不代表完整 RFC 或部署通过。
