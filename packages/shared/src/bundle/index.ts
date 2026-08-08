// RFC-271 — `ResourceBundle` 表达层。
//
// payload.ts  六类资源 payload —— **逐字段对照正式 create/snapshot schema**
// op.ts       12 分支 discriminated op union + 各类型专属的内容级 CAS token
// bundle.ts   顶层 + 引用闭合性（重复 slug / 悬空引用 / external root 需 rootType）
// secrets.ts  脱敏投影 —— **产物必须仍过各自的严格 schema**

export * from './payload'
export * from './op'
export * from './bundle'
export * from './secrets'
