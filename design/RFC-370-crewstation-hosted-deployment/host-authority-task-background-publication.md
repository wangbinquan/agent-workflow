# RFC-370 Task 后台执行权切面发布

本批新增 Task application 的独立执行权/后台运行合同，composition startAuthority 为每个原执行权回调及 receiver 保留自己的配置读取、循环、启动、正常暂停、失权停止派发和真实排空 ACK。过期读取不打开 gate 或启动 auto-resume；下一代等待旧代实际 drain 后读取新配置。失权不发行批量取消，正常暂停和最终关闭保持原 reason、runtime tickets 和真实停止责任；失败仅继续缺少的 ACK。

SOURCE4-R1 原有效 FAIL 和唯一 P2 H7-TASK-BACKGROUND-SOURCE4-F01 完整保留。R2 将必需 module.resume 的成功纳入 moduleOpen 启动 ACK；原 autoResume 继续 detached，并由 ownedStartup 跟踪。实际 gate 已 sealed 时启动拒绝，所有已建 timer 清理并实际排空后报告错误。SOURCE4-R2 独立有效稳定 PASS；原整个 native AST、三套旧测试、R1 九个新增 case 的完整逆变换及原文档前缀保持。新增第十个 case 使用真实 TaskExecutionModule.seal。两 provider 共二十个 case 的执行结果交提交后的 hosted 精确 SHA CI。

WF1-R1 只在原 Windows push、PR path filters 与原平台命令三处登记新套件，完整原 YAML 逆变换一致，全部旧步骤、环境、用例与预算保留。配套清单由四条原规则在 dbd44392fa0d8257fa18b6b98d8cfffb9e682559 的完整已提交非本批来源，加一份冻结原生产、一份新 Task application port 和一份新测试，进行一次 original scoped census。其它会话 WIP 全部排除。

13 份原输出完整保留；原 27411 个 owner 行全部保持，只新增 port 的 file root、两个接口和 composition 的私有 lifetime 共四项，owner 到 27415。生产、backend、module 文件数各加一，Task 模块文件数到 451。原 background 全部 366 项保持，一条物理 timer 标记由 118 行移到 134 行；其余所有 import、exception、public、opaque mutation、effects、SCC、target 和 JSON payload 不变，classic 完整前后 0/0 相等。129 有序 ledger/why 和全部非测量字段保持，只对四项实际 owner 增长添加一条消费声明；普通后继将仅退役该声明，不重跑 census。原 status 全文使用原生成结果。

本机只做本批格式/lint、静态 AST/字节/JSON 和上述唯一原生成，没有运行 AW tests、typecheck、build、service 或 E2E。源码、Windows 登记与配套门的完整原回执分别留证；有限 PASS 不等于 hosted CI 通过。

目前尚无真实根消费 startAuthority，也未完成 Task 原事务、命令内部逐 Task 派发或全入口 admission。实际启动根、完整 19 owner、UI、H7/A-G 和 CS M0–M4 仍开放，不声明 Task group ready。AW 尚未部署到 CS。
