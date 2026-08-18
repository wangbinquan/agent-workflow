// RFC-310 T3 —— unknown-key mutation harness。
//
// 「strict 到每一层」不能靠人眼核对：给任意 valid fixture，本 harness 枚举其
// JSON 树上每一个对象节点，逐个注入 `__mutant__` 键并要求 parse 失败。返回
// 「没被拒绝的注入路径」清单——期望恒为空数组；任何一层漏了 .strict() 都会
// 在这里现形（AC-9 / plan T3 验收「新增 unknown field 全红」）。

import type { z } from 'zod'

function clone<T>(value: T): T {
  return structuredClone(value)
}

function objectPaths(value: unknown, base: (string | number)[] = []): (string | number)[][] {
  const out: (string | number)[][] = []
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      out.push(...objectPaths(item, [...base, index]))
    })
    return out
  }
  if (value !== null && typeof value === 'object') {
    out.push(base)
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out.push(...objectPaths(child, [...base, key]))
    }
  }
  return out
}

function injectAt(root: unknown, path: (string | number)[]): unknown {
  const copy = clone(root)
  let cursor: unknown = copy
  for (const segment of path) {
    cursor = (cursor as Record<string | number, unknown>)[segment]
  }
  ;(cursor as Record<string, unknown>).__mutant__ = 'unknown-key-injection'
  return copy
}

/** 对 fixture 每个对象节点注入 unknown key；返回未被拒绝的路径（期望 []）。 */
export function unknownKeySurvivors(schema: z.ZodTypeAny, fixture: unknown): string[] {
  const survivors: string[] = []
  for (const path of objectPaths(fixture)) {
    const mutated = injectAt(fixture, path)
    if (schema.safeParse(mutated).success) {
      survivors.push(path.length === 0 ? '<root>' : path.join('.'))
    }
  }
  return survivors
}

/** round-trip 判据：parse 成功且再序列化后逐字节稳定（配 canonical stringify 用）。 */
export function parseOk<T>(schema: z.ZodType<T>, fixture: unknown): T {
  const result = schema.safeParse(fixture)
  if (!result.success) {
    throw new Error(`fixture should parse but failed: ${result.error.message}`)
  }
  return result.data
}
