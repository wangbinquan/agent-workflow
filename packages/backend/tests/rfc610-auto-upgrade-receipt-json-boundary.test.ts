// RFC-610 — 自动升级结论的回执取发布时的 JSON（RFC-294 S9 余项：public 类型偏差 12 → 11）。
//
// 为什么存在：`db migration auto` 的结论在成功时带回执，此前类型是 `Readonly<Record<string, unknown>>`，是 public 类型污染清单里 system-operations
// 唯一的一条。回执由自动升级的记录端口 `receipt()` 发布：第一次把值序列化写进 `receipt.json`，恢复时读回原来的字节——它本来就是 JSON；
// 可第一次调用返回的是传进来的对象本身（值为 undefined 的键还在），与恢复时读回的形状不一致。现在端口两次都返回发布字节的解析结果，
// 结论的回执是平台的 `JsonObject`（RFC-606 指定的平台合同类型）；记录层其余载荷照旧不透明（RFC-398 §2.7）。锁三件事：
// ① 行为：文件记录实现第一次返回所写 JSON 的解析结果，恢复时返回原来发布的 JSON、不看新值；文件里的字节就是第一次的序列化。
// ② 类型：结论的 `receipt` 与端口 `receipt()` 的返回都写成 `JsonObject`（AST）。
// ③ 检测器：伪造的 public 类型里 `Readonly<Record<string, unknown>>` 照旧记债，`JsonObject` 不记（负对照只喂伪造源码）。
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { createAutoUpgradeRecords } from '@/modules/system-operations/infrastructure/epochSwitch/autoUpgradeRecords'
import { autoUpgradeRoot } from '@/modules/system-operations/infrastructure/local/autoUpgradeState'
import { publicSurfaceViolations, sourceUnits } from './architecture/rfc294Gates'

const BACKEND = join(import.meta.dir, '..')
const SO = 'src/modules/system-operations/'
const OPERATION = 'dbm_e2_rfc610receipt'
const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function appHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'rfc610-'))
  homes.push(home)
  return home
}

const parse = (path: string) =>
  ts.createSourceFile(path, readFileSync(join(BACKEND, path), 'utf8'), ts.ScriptTarget.Latest, true)

/** The written type of an interface property, or of an interface method's return. */
function declaredType(path: string, owner: string, member: string): string {
  const source = parse(path)
  for (const statement of source.statements) {
    if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== owner) continue
    for (const element of statement.members) {
      if (element.name?.getText(source) !== member) continue
      if (ts.isPropertySignature(element)) return element.type?.getText(source) ?? ''
      if (ts.isMethodSignature(element)) return element.type?.getText(source) ?? ''
    }
  }
  return '<missing>'
}

const violationsOf = (body: string) =>
  publicSurfaceViolations(
    sourceUnits({ 'packages/backend/src/modules/delta/public/types.ts': body }),
  ).map((line) => line.replace(/^modules\/delta\/public\/types\.ts#/, ''))

describe('RFC-610 —— 自动升级结论的回执取发布时的 JSON', () => {
  test('第一次返回所写 JSON 的解析结果，恢复时返回原来发布的 JSON', async () => {
    const home = appHome()
    const records = createAutoUpgradeRecords(home)
    const first = {
      operationId: OPERATION,
      runId: undefined,
      restrictions: [{ kind: 'retained', table: 'events' }],
      backup: { path: '/backups/1', bytes: 12, verified: true, note: null },
    }
    const published = await records.receipt(OPERATION, first)
    expect(published).toEqual({
      operationId: OPERATION,
      restrictions: [{ kind: 'retained', table: 'events' }],
      backup: { path: '/backups/1', bytes: 12, verified: true, note: null },
    })
    expect(Object.hasOwn(published, 'runId')).toBe(false)
    expect(published).not.toBe(first)
    const file = join(autoUpgradeRoot(home), 'sessions', OPERATION, 'receipt.json')
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(first))

    const recovered = await records.receipt(OPERATION, { operationId: OPERATION, later: true })
    expect(recovered).toEqual(published)
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(first))
  })

  test('结论的回执与端口的返回都写成 JsonObject', () => {
    expect(
      declaredType(SO + 'domain/epochSwitch/autoUpgrade.ts', 'AutoUpgradeConclusion', 'receipt'),
    ).toBe('JsonObject')
    expect(
      declaredType(SO + 'application/ports/epochSwitch.ts', 'AutoUpgradeRecordPort', 'receipt'),
    ).toBe('Promise<JsonObject>')
  })
})

describe('RFC-610 —— 负对照（伪造源码）', () => {
  test('任意对象的回执照旧记债，平台 JsonObject 不记', () => {
    expect(
      violationsOf(
        [
          'export interface DeltaConclusion {',
          "  readonly outcome: 'done' | 'failed'",
          '  readonly receipt?: Readonly<Record<string, unknown>>',
          '}',
        ].join('\n'),
      ),
    ).toEqual(['DeltaConclusion: unsafe/open type UnknownKeyword'])
    expect(
      violationsOf(
        [
          "import type { JsonObject } from '@/platform/contracts/json'",
          'export interface DeltaConclusion {',
          "  readonly outcome: 'done' | 'failed'",
          '  readonly receipt?: JsonObject',
          '}',
        ].join('\n'),
      ),
    ).toEqual([])
  })
})
