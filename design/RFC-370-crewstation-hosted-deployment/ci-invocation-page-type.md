# CI：调用分页原测试的显式返回类型

`5b8c7b320d89bb694a872282455e021e8b777463` 的主流水线 `37761392727`，共享作业 `113258382764` 在 Typecheck 阶段报告 `rfc371-system-complete-report-provider.test.ts:238` 的 TS7022：调用分页循环的 `page` 推断为隐式 `any`。失败作业的完整日志及 API 元数据保留；该作业前面的格式、lint 和依赖检查已成功。

本次只添加 `Awaited<ReturnType<typeof original.service.page<CompleteObservationInvocation>>>`，直接取现有泛型方法的返回合同。原调用、两个分页循环、游标重置、limit=1、total=2、null EOF、调用人口及 Agent ID／名称严格断言保持。并行会话已经提交的 Agent 名称、四桶 Token、费用、原 214／203 人口、两种 provider、全部 matcher 和 60000／120000 ms 预算完整保留；此前三处类型修复保持。

完整运行时 AST 在忽略纯类型节点后必须前后相等；原完整断言与测试预算按纯解析结果对账。只运行定向格式／lint 检查和独立有限功能门，没有本机 AW 产品测试、typecheck、build、服务或 census，也没有生产、架构清单、依赖或 CI 规则变更。

发布后的 GitHub 完整主流水线与 Windows 仍须独立验收。有限源门和类型标注不能代签全绿。总 CI 全绿前继续暂停 runtime／Node／CS 新实施；RFC-370、H7／A-G、M0～M4 及 AW 在 CrewStation 的部署尚未完成。
