// RFC-284 T27（D18 目录规则示范）——正体已迁 services/clarify/seal.ts；
// 本文件是过渡 facade，保住既有 import 路径（scheduler 等热区消费方零改动）。
// 新代码请直接 import `@/services/clarify/seal`。
export * from './clarify/seal'
