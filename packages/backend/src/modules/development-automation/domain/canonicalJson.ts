// RFC-310 T3 —— canonical JSON 与 digest（design.md §4.1/§4.6）。
//
// 决策确定性的字节基础：同一个逻辑值必须序列化成同一串字节，digest 才能作
// replay oracle。规则：对象键按码点排序、数组保序、只接受 JSON-safe 值
// （undefined/NaN/±Infinity/函数/bigint/循环引用都是编程错误，直接抛），
// 不做任何浮点归一（合同层禁止非整数预算，schema 已挡）。
// hash 走 util/hash 的单步 idiom（RFC-284 T7 锁），domain 白名单精确放行该纯函数。

import { sha256Hex } from '../../../util/hash'

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue }

export function canonicalStringify(value: unknown): string {
  const seen = new Set<object>()
  const encode = (v: unknown): string => {
    if (v === null) return 'null'
    switch (typeof v) {
      case 'boolean':
        return v ? 'true' : 'false'
      case 'number':
        if (!Number.isFinite(v)) throw new Error('canonicalStringify: non-finite number')
        return JSON.stringify(v)
      case 'string':
        return JSON.stringify(v)
      case 'object':
        break
      default:
        throw new Error(`canonicalStringify: unsupported type ${typeof v}`)
    }
    const obj = v as object
    if (seen.has(obj)) throw new Error('canonicalStringify: circular reference')
    seen.add(obj)
    try {
      if (Array.isArray(obj)) {
        return `[${obj.map((item) => encode(item)).join(',')}]`
      }
      const entries = Object.entries(obj as Record<string, unknown>).filter(
        ([, val]) => val !== undefined,
      )
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${encode(val)}`).join(',')}}`
    } finally {
      seen.delete(obj)
    }
  }
  return encode(value)
}

export function canonicalDigest(value: unknown): string {
  return sha256Hex(canonicalStringify(value))
}
