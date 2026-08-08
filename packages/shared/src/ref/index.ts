// RFC-271 决策 29 — 统一引用模型。
//
// ast.ts        归一化 AST（八变体）+ 稳定 key
// codecs.ts     六个域的 wire codec —— **既有拼写逐字保留**
// resolution.ts 五属性解析契约 + typed Result（不 throw）

export * from './ast'
export * from './codecs'
export * from './resolution'
