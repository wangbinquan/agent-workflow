# RFC-371：完整泳道发布 CI 修复

原完整 Task trace 已发布于 `87424fa0`，正常退役后继 `335cc533` 的精确 CI `37156345771` 暴露两个本会话的问题，保留原失败证据。

原 alias HTTP 回归的泛型 page mock 参数缺少显式 Actor/string/unknown 类型，actor 注入中间件也未声明 Hono MiddlewareHandler；仅修类型声明，invocation/attempt 身份、分页、404/422 与原断言不变。

原双向 overlay AST 库存缺少真实新增的 CompleteObservationTrace Dialog。按实际一处 render 登记到 task-execution family，原 shared mobileOwner、scanner、匹配规则、既有 callsites 和 rendered 行为门全部保持。现有 rfc371-complete-observation-trace 只覆盖宽度、未知状态、分页和 EOF；打开详情、关闭与焦点恢复仍待专门页面验收，不能以库存登记宣称已经覆盖。

本机仅做自有 format/lint；需要发布后 exact-SHA hosted types、前端、浏览器、定时 CI 通过。这不是 native v2 接入或完整统计验收，两个 RFC 仍 In Progress。
