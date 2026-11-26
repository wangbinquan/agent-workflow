// RFC-606 — runtime-management 合同里的开放类型：JSON 值、有限键映射与失败原因（RFC-294 S9 余项）。
//
// 为什么存在：runtime-management 的四条 public 类型偏差都是“开放”的误记。
// - 用量事件与探测回执视图是 JSON，却写成 `unknown`。
// - 清扫失败原因唯一的实现给的是字符串。
// - shared 的清单声明是按封闭的 `z.enum` 映射的有限对象类型，检测器却把一切映射类型记为开放。
// 现在 JSON 用平台的 `JsonValue` / `JsonObject`（指定的平台合同类型，design §3.3 的“JSON-safe value”），失败原因是 `string`，键集合封闭的映射类型算闭合
// （规则三）。锁三件事：
// ① 检测器：两个 JSON 类型放行、同文件的其他导出照旧记债；键集合封闭的映射类型放行（值类型照旧检查），原始键、含原始键的联合、模板字面量、
//    `PropertyKey` 照旧记债。
// ② 四处类型：用量事件 `JsonObject`、探测回执视图 `JsonValue | null`、清扫失败原因 `string`、清单声明仍是按 `InventoryFace` 的映射类型。
// ③ `JsonValue` 只有一份定义：迁移转换的同名类型从平台合同转出。
//
// 覆盖范围（C12）：① 在合成语料上跑检测器；② ③ 读源码。真实语料的逐条相等由 `rfc294-architecture-preflight` 执行。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { publicSurfaceViolations, sourceUnits } from './architecture/rfc294Gates'

const BACKEND = join(import.meta.dir, '..')
const read = (path: string) => readFileSync(join(BACKEND, path), 'utf8')
const parse = (path: string) => ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true)

const violationsOf = (body: string) =>
  publicSurfaceViolations(
    sourceUnits({ 'packages/backend/src/modules/delta/public/types.ts': body }),
  ).map((line) => line.replace(/^modules\/delta\/public\/types\.ts#/, ''))

/** The type text of a member of a named interface or type alias property. */
function memberType(path: string, owner: string, member: string): string {
  const source = parse(path)
  for (const statement of source.statements) {
    if (ts.isInterfaceDeclaration(statement) && statement.name.text === owner) {
      for (const element of statement.members) {
        if (element.name?.getText(source) !== member) continue
        if (ts.isPropertySignature(element)) return element.type?.getText(source) ?? ''
        if (ts.isMethodSignature(element))
          return element.parameters.map((p) => p.type?.getText(source) ?? '').join(', ')
      }
    }
  }
  return '<missing>'
}

describe('RFC-606 —— JSON 值、有限键映射与失败原因', () => {
  test('检测器：平台 JSON 类型放行，同文件的其他导出照旧记债', () => {
    expect(
      violationsOf(
        [
          "import type { JsonObject, JsonValue } from '@/platform/contracts/json'",
          'export interface DeltaPort {',
          '  observe(event: JsonObject): boolean',
          '  readonly lastProbe: JsonValue | null',
          '}',
        ].join('\n'),
      ),
    ).toEqual([])
    expect(
      violationsOf(
        [
          "import type { JsonArray } from '@/platform/contracts/json'",
          'export interface DeltaPort { readonly rows: JsonArray }',
        ].join('\n'),
      ),
    ).toEqual(['DeltaPort: forbidden type import @/platform/contracts/json#JsonArray'])
  })

  test('规则三：键集合封闭的映射类型是有限对象类型，开放键照旧记债', () => {
    expect(
      violationsOf(
        [
          "export type Face = 'agents' | 'skills'",
          'export type Declared = { readonly [F in Face]: { readonly support: boolean } }',
          "export type Literal = { readonly [K in 'a' | 'b']: number }",
          'export type Keys = { readonly [K in keyof Declared]: string }',
        ].join('\n'),
      ),
    ).toEqual([])
    expect(
      violationsOf(
        [
          "export type Face = 'agents' | 'skills'",
          'export type Open = { readonly [K in string]: number }',
          "export type Mixed = { readonly [K in string | 'a']: number }",
          'export type Pattern = { readonly [K in `x-${string}`]: number }',
          'export type Any = { readonly [K in PropertyKey]: number }',
          'export type Valued = { readonly [F in Face]: unknown }',
        ].join('\n'),
      ),
    ).toEqual([
      'Any: unsafe/open type MappedType',
      'Mixed: unsafe/open type MappedType',
      'Open: unsafe/open type MappedType',
      'Pattern: unsafe/open type MappedType',
      'Valued: unsafe/open type UnknownKeyword',
    ])
  })

  test('四处类型：JSON、字符串与按清单面的映射', () => {
    const meter = 'src/modules/runtime-management/domain/usageMeter.ts'
    expect(memberType(meter, 'RuntimeUsageMeter', 'observe')).toBe('JsonEvent')
    expect(read(meter)).toContain(
      "import type { JsonObject as JsonEvent } from '@/platform/contracts/json'",
    )
    expect(
      memberType('src/modules/runtime-management/public/types.ts', 'RuntimeView', 'lastProbe'),
    ).toBe('JsonValue | null')
    expect(
      memberType(
        'src/modules/runtime-management/application/ports/agentMaterialEvidence.ts',
        'SystemAgentSessionSweepOutcome',
        'failureReason',
      ),
    ).toBe('string')
    expect(read('../shared/src/schemas/runtimeInventory.ts')).toMatch(
      /export type InventoryDeclaration = \{\n {2}readonly \[F in InventoryFace\]: \{/,
    )
  })

  test('JsonValue 只有一份定义：迁移转换从平台合同转出', () => {
    const conversion = read('src/platform/persistence/migration/conversion/types.ts')
    expect(conversion).toContain("import type { JsonValue } from '../../../contracts/json'")
    expect(conversion).toContain('export type { JsonValue }')
    expect(conversion).not.toMatch(/export type JsonValue\s*=/)
    expect(read('src/platform/contracts/json.ts')).toMatch(/export type JsonValue =/)
  })
})
