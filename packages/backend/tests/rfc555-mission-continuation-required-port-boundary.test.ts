// RFC-555 — development-automation 经 integration 的 required-ports 实现 Mission 续接（RFC-294 S9 第十步）。
//
// 锁四件事：
// ① development-automation 的生产文件里，取 integration 非 public 文件的只有指定 adapter
//    `application/adapters/integration-adapter.ts`，且只按类型取 `composition/required-ports`（判据带负对照）。
// ② integration 的 required-ports 交出续接端口；adapter 按这个端口实现续接，infrastructure 只把数据库绑定上去，
//    composition 与 bootstrap 的装配不变。
// ③ 目标 DAG 登记了这条虚线 required 边（`rfc294-design-parity` 另锁它与 RFC-294 design 的 Mermaid 一致）。
// ④ adapter 不碰数据库：拿一个内存里的 Mission 存储就能续接（匹配、唤醒判定与唤醒提示与原先相同）。
//
// 覆盖范围（C12）：① 覆盖 development-automation 的全部源码；② ③ ④ 只读点名的文件与常量。
import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'

import { missionCodeHostEventContinuation } from '../src/modules/development-automation/application/adapters/integration-adapter'
import { REQUIRED_CONTEXT_EDGES } from './architecture/rfc294Target'

const SRC = resolve(import.meta.dir, '..', 'src')
const DA = join(SRC, 'modules', 'development-automation')
const read = (path: string) => readFileSync(join(SRC, path), 'utf8')
const slash = (path: string) => path.split('\\').join('/')

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : /\.[cm]?tsx?$/.test(name) ? [path] : []
  })
}

/**
 * Imports and re-exports that reach a non-public integration file, as `<target rest> (<type|value>)`.
 * `@/` resolves to `src/`; relative specifiers resolve against the file's directory.
 */
function integrationInternalImports(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
  const out: string[] = []
  for (const statement of source.statements) {
    const isImport = ts.isImportDeclaration(statement)
    if (!isImport && !ts.isExportDeclaration(statement)) continue
    const specifier = statement.moduleSpecifier
    if (specifier === undefined || !ts.isStringLiteral(specifier)) continue
    const target = specifier.text.startsWith('@/')
      ? join(SRC, specifier.text.slice(2))
      : specifier.text.startsWith('.')
        ? resolve(dirname(path), specifier.text)
        : null
    if (target === null) continue
    const rest = /^modules\/integration\/(.+)$/.exec(slash(relative(SRC, target)))?.[1]
    if (rest === undefined || /^public\/[a-z]+$/.test(rest)) continue
    const typeOnly = isImport
      ? statement.importClause?.isTypeOnly === true ||
        (statement.importClause?.name === undefined &&
          statement.importClause?.namedBindings !== undefined &&
          ts.isNamedImports(statement.importClause.namedBindings) &&
          statement.importClause.namedBindings.elements.every((element) => element.isTypeOnly))
      : statement.isTypeOnly
    out.push(`${rest} (${typeOnly ? 'type' : 'value'})`)
  }
  return out
}

describe('RFC-555 —— 只有指定 adapter 取 integration 的 required-ports', () => {
  test('development-automation 的生产文件取 integration 非 public 文件的只有 adapter，且只按类型', () => {
    const files = walk(DA)
    expect(files.length).toBeGreaterThanOrEqual(200)
    const found = files.flatMap((path) =>
      integrationInternalImports(path, readFileSync(path, 'utf8')).map(
        (edge) => `${slash(relative(DA, path))} -> ${edge}`,
      ),
    )
    expect(found).toEqual([
      'application/adapters/integration-adapter.ts -> composition/required-ports (type)',
    ])
  }, 60_000)

  test('负对照：内部文件、值导入、转出与相对路径都会被认出，public 不算', () => {
    const at = join(DA, 'infrastructure', 'probe.ts')
    expect(
      integrationInternalImports(
        at,
        "import type { A } from '@/modules/integration/application/ports/codeHostEventResponse'\n" +
          "import { B } from '@/modules/integration/composition/required-ports'\n" +
          "import { type C } from '@/modules/integration/composition/required-ports'\n" +
          "export type { D } from '@/modules/integration/composition/required-ports'\n" +
          "import { E } from '../../integration/infrastructure/codeHost/connections'\n" +
          "import type { F } from '@/modules/integration/public/participants'\n" +
          "import type { G } from '@/modules/source-control/composition/required-ports'\n",
      ),
    ).toEqual([
      'application/ports/codeHostEventResponse (type)',
      'composition/required-ports (value)',
      'composition/required-ports (type)',
      'composition/required-ports (type)',
      'infrastructure/codeHost/connections (value)',
    ])
  })
})

describe('RFC-555 —— 端口、adapter 与装配', () => {
  test('integration 的 required-ports 按类型交出续接端口', () => {
    expect(read('modules/integration/composition/required-ports.ts')).toContain(
      "export type { CodeHostEventContinuationPort } from '../application/ports/codeHostEventResponse'",
    )
  })

  test('adapter 按端口实现续接；infrastructure 只做数据库绑定；装配不变', () => {
    const adapter = read(
      'modules/development-automation/application/adapters/integration-adapter.ts',
    )
    expect(adapter).toContain('): CodeHostEventContinuationPort {')
    expect(adapter).toContain('shouldWakeForWebhook({')
    const infra = read(
      'modules/development-automation/infrastructure/missionCodeHostEventContinuation.ts',
    )
    expect(infra).toContain("from '../application/adapters/integration-adapter'")
    expect(infra).toContain('missionCodeHostEventContinuation(createMissionPersistence(db))')
    expect(infra).not.toContain('shouldWakeForWebhook')
    expect(read('modules/development-automation/composition.ts')).toContain(
      "export { createMissionCodeHostEventContinuation } from './infrastructure/missionCodeHostEventContinuation'",
    )
    expect(read('bootstrap/daemonModules/integration.ts')).toContain(
      'createMissionCodeHostEventContinuation(input.db)',
    )
  })

  test('目标 DAG 登记了 development-automation implements CodeHostEventContinuationPort → integration', () => {
    expect(REQUIRED_CONTEXT_EDGES).toContainEqual([
      'development-automation',
      'integration',
      'CodeHostEventContinuationPort',
    ])
  })
})

describe('RFC-555 —— adapter 不碰数据库', () => {
  type Store = Parameters<typeof missionCodeHostEventContinuation>[0]
  function memoryStore(
    claim: { state: string; missionId: string } | null,
    terminalKind: string | null,
  ) {
    const hints: unknown[] = []
    const store = {
      findMrClaim: () => (claim === null ? null : { id: 'claim-1', ...claim }),
      getMission: (id: string) =>
        claim !== null && id === claim.missionId ? { id, terminalKind } : null,
      recordWakeHint: (input: unknown) => {
        hints.push(input)
      },
    } as unknown as Store
    return { store, hints }
  }
  const mr = { provider: 'gitlab-main', repoPath: 'group/repo', mrIid: '7' }

  test('不认识的 MR 不续接；active claim 续接到它的 Mission', async () => {
    expect(
      await missionCodeHostEventContinuation(memoryStore(null, null).store).match(mr),
    ).toBeNull()
    expect(
      await missionCodeHostEventContinuation(
        memoryStore({ state: 'active', missionId: 'm-1' }, null).store,
      ).match(mr),
    ).toEqual({
      continuationRef: 'm-1',
      definitionRevision: 'claim-1',
      displayName: { 'zh-CN': '继续开发任务 m-1', 'en-US': 'Continue development mission m-1' },
    })
  })

  test('released claim 只有 closed-unmerged 的 Mission 续接（reopen 信号）', async () => {
    const released = (kind: string | null) =>
      missionCodeHostEventContinuation(
        memoryStore({ state: 'released', missionId: 'm-2' }, kind).store,
      ).match(mr)
    expect(await released('merged')).toBeNull()
    expect((await released('closed-unmerged'))?.continuationRef).toBe('m-2')
  })

  test('consume 记一条按投递去重的 webhook 唤醒提示', async () => {
    const { store, hints } = memoryStore({ state: 'active', missionId: 'm-3' }, null)
    await missionCodeHostEventContinuation(store).consume({
      continuationRef: 'm-3',
      eventDeliveryId: 'delivery-9',
      occurredAt: 1_700_000_000_000,
    })
    expect(hints).toHaveLength(1)
    expect(hints[0]).toMatchObject({
      missionId: 'm-3',
      source: 'webhook',
      deliveryKey: 'event-center:delivery-9',
      now: 1_700_000_000_000,
    })
  })
})
