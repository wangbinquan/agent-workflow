// RFC-271 决策 29 — 统一引用模型。
//
// ast.ts        归一化 AST（九变体）+ 稳定 key
// codecs.ts     七个域的 wire codec —— **既有拼写逐字保留**
// resolution.ts 五属性解析契约 + typed Result（不 throw）
// runtime.ts    RuntimeRef 域 resolver（节点 agent 引用的唯一读取点、去重键；RFC-460 自 services/ 迁入）
// callTarget.ts call 选择器绑定到哪一行的唯一判据（RFC-291 面 D；RFC-460 自 services/ 迁入）

export * from './ast'
export * from './codecs'
export * from './resolution'
export * from './runtime'
export * from './callTarget'
