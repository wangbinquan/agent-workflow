// RFC-548 — source-control 的守护进程级状态归实例（RFC-294 S12 第二十七步）。
//
// 锁三件事（design §3 的清单即退出门）：
// ① 批量导入、镜像缓存与存储端口三个文件顶层没有 `let`，在架构报告的模块级可变单例判据里为空；删去的状态、重置与失效函数在生产代码里不出现；
//    生产代码只在 daemon 应用的组合里构造批量导入（语料下限 3,000）。
// ② 行为：两份批量导入的批次、发起者与并发名额各算各的；同一个库上的存储共用切面代次与在途页读取，另一个库互不影响；按库状态在库与它的
//    事务上是同一份、不同键各一份、没有 provider 绑定过的对象报错。
// 负对照只喂伪造的源码，不碰真实语料。
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import {
  batchOwnerUserId,
  composeRepositoryWorkspaceStore,
  createRepositoryBatchImports,
  type RepositoryBatchImports,
} from '@/modules/source-control/composition'
import {
  gcBatches,
  getBatchSnapshot,
  startBatchImport,
  type RepoBatchImportDeps,
} from '@/modules/source-control/infrastructure/local/repositoryBatchImport'
import { composeSourceControlTaskPorts } from '@/modules/task-execution/composition'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  bindDatabaseHandle,
  databaseStateKey,
  databaseStateOf,
  inheritDatabaseHandle,
  tablesOf,
} from '@/platform/persistence/sessionTables'
import { insertOne } from '@/platform/persistence/singleInsert'
import { mutableSingletons } from './architecture/architectureReport'
import { backendUnits, sourceUnit, type SourceUnit } from './architecture/census'
import { describeEachProvider } from './helpers/eachProvider'

const REPO = resolve(import.meta.dir, '../../..')
const SRC = 'packages/backend/src/'
const MODULE = SRC + 'modules/source-control/'
const FILES = [
  MODULE + 'infrastructure/local/repositoryBatchImport.ts',
  MODULE + 'infrastructure/local/repositoryMirrorCache.ts',
  MODULE + 'ports/repositoryWorkspaceStore.ts',
]
/** The one production site that builds the daemon's batch imports. */
const COMPOSER = SRC + 'bootstrap/daemonApplication.ts'
const CORPUS_TIMEOUT = 30_000
/** The module state RFC-548 removed; production must not name it again. */
const REMOVED = [
  '__resetBatchImportForTests',
  'globalConcurrency',
  'globalInFlight',
  'setGlobalConcurrency',
  'repoPageFlights',
  'invalidateRepoFacetsCache',
  'repositoryFacetCacheEpoch',
  'currentRepositoryFacetCacheEpoch',
  'invalidateRepositoryWorkspaceFacetCaches',
]

export function sourceControlStateViolations(units: readonly SourceUnit[]): string[] {
  const errors = new Set<string>()
  for (const path of FILES) {
    const unit = units.find((candidate) => candidate.path === path)
    if (unit === undefined) {
      errors.add('missing source: ' + path)
      continue
    }
    const file = path.slice(path.lastIndexOf('/') + 1)
    for (const statement of unit.source.statements)
      if (
        ts.isVariableStatement(statement) &&
        (statement.declarationList.flags & ts.NodeFlags.Let) !== 0
      )
        for (const declaration of statement.declarationList.declarations)
          errors.add(`module-level let:${file}:${declaration.name.getText(unit.source)}`)
    for (const entry of mutableSingletons([unit]))
      errors.add(`mutable singleton:${file}:${entry.symbol}`)
  }
  const constructions: string[] = []
  for (const unit of units) {
    if (!unit.path.startsWith(SRC)) continue
    const walk = (node: ts.Node) => {
      if (ts.isIdentifier(node) && REMOVED.includes(node.text))
        errors.add(`names ${node.text}: ${unit.path}`)
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'createRepositoryBatchImports'
      )
        constructions.push(unit.path)
      node.forEachChild(walk)
    }
    walk(unit.source)
  }
  if (constructions.length !== 1 || constructions[0] !== COMPOSER)
    errors.add(`batch imports constructed in: ${constructions.join(', ') || 'nowhere'}`)
  return [...errors].sort()
}

describe('RFC-548 ① 守护进程级状态不在模块级', () => {
  test(
    '真实语料：三个文件没有模块级状态，删去的名字不出现，批量导入只在 daemon 应用的组合里构造',
    () => {
      const units = backendUnits(REPO)
      expect(units.length).toBeGreaterThanOrEqual(3000)
      expect(sourceControlStateViolations(units)).toEqual([])
    },
    CORPUS_TIMEOUT,
  )
})

describe('RFC-548 ② 批量导入各算各的', () => {
  const held = (() => new Promise<never>(() => {})) as unknown as NonNullable<
    RepoBatchImportDeps['resolveCachedRepo']
  >
  const deps = (input: Partial<RepoBatchImportDeps> = {}): RepoBatchImportDeps => ({
    store: {} as never,
    resolveCachedRepo: held,
    emit: () => undefined,
    ...input,
  })
  const statusOf = (imports: RepositoryBatchImports, batchId: string) =>
    getBatchSnapshot(imports, batchId)?.rows[0]?.status

  test('一份里起的批次另一份查不到发起者与快照；并发名额也各算各的', async () => {
    const first = createRepositoryBatchImports()
    const second = createRepositoryBatchImports()
    const a = startBatchImport(
      first,
      deps({ concurrency: 1 }),
      { urls: ['https://example.test/acme/a.git'] },
      { userId: 'u-first' },
    )
    const b = startBatchImport(
      second,
      deps({ concurrency: 1 }),
      { urls: ['https://example.test/acme/b.git'] },
      { userId: 'u-second' },
    )
    expect(batchOwnerUserId(first, a.batchId)).toBe('u-first')
    expect(batchOwnerUserId(second, a.batchId)).toBeNull()
    expect(getBatchSnapshot(second, a.batchId)).toBeNull()
    expect(batchOwnerUserId(second, b.batchId)).toBe('u-second')
    // 各自只有一个名额、各自一行：两行都能开跑，名额不跨实例。
    for (
      let i = 0;
      i < 200 &&
      (statusOf(first, a.batchId) !== 'cloning' || statusOf(second, b.batchId) !== 'cloning');
      i += 1
    )
      await Bun.sleep(5)
    expect(statusOf(first, a.batchId)).toBe('cloning')
    expect(statusOf(second, b.batchId)).toBe('cloning')
  })

  test('回收只扫自己那一份', async () => {
    const registered = deps({ register: async () => ({ cachedRepoId: 'cr-548', created: true }) })
    const first = createRepositoryBatchImports()
    const second = createRepositoryBatchImports()
    const a = startBatchImport(
      first,
      registered,
      { urls: ['https://example.test/acme/a.git'] },
      { userId: 'u' },
    )
    const b = startBatchImport(
      second,
      registered,
      { urls: ['https://example.test/acme/b.git'] },
      { userId: 'u' },
    )
    for (
      let i = 0;
      i < 200 &&
      (getBatchSnapshot(first, a.batchId)?.state !== 'completed' ||
        getBatchSnapshot(second, b.batchId)?.state !== 'completed');
      i += 1
    )
      await Bun.sleep(5)
    const future = Date.now() + 10 * 60 * 60 * 1000
    expect(gcBatches(first, { now: () => future }).evicted).toBe(1)
    expect(getBatchSnapshot(first, a.batchId)).toBeNull()
    expect(getBatchSnapshot(second, b.batchId)?.state).toBe('completed')
  })
})

describe('RFC-548 ② 按库状态', () => {
  test('库与它的事务取到同一份；不同键、不同库各一份；没有 provider 绑定过的对象报错', () => {
    const database = bindDatabaseHandle({}, {} as never, {} as never)
    const transaction = inheritDatabaseHandle({}, database)
    const other = bindDatabaseHandle({}, {} as never, {} as never)
    const key = databaseStateKey(() => ({ value: 0 }))
    const sibling = databaseStateKey(() => ({ value: 0 }))
    const state = databaseStateOf(database, key)
    expect(databaseStateOf(database, key)).toBe(state)
    expect(databaseStateOf(transaction, key)).toBe(state)
    expect(databaseStateOf(database, sibling)).not.toBe(state)
    expect(databaseStateOf(other, key)).not.toBe(state)
    expect(() => databaseStateOf({}, key)).toThrow('no session table set')
  })
})

describeEachProvider(
  'RFC-548 ② 缓存仓库的读缓存按库',
  (harness) => {
    const storeOn = (db: PersistenceDb) =>
      composeRepositoryWorkspaceStore(db, composeSourceControlTaskPorts(db))
    const rawInsert = async (db: PersistenceDb, id: string) => {
      const { cachedRepos } = tablesOf(db)
      // 绕过存储的写方法（不触发失效），直接插一行。
      await insertOne(db, cachedRepos, {
        id,
        urlHash: `hash-${id}`,
        urlEnc: null,
        urlRedacted: `https://example.test/acme/${id}.git`,
        localPath: `/cache/${id}`,
        defaultBranch: 'main',
        lastFetchedAt: 200,
        createdAt: 100,
        hasSubmodules: false,
        lastSubmoduleSyncOk: null,
        lastSubmoduleSyncError: null,
        lastAutoRefreshAt: null,
      })
    }
    const facetsAll = async (store: ReturnType<typeof storeOn>) =>
      (await store.listCachedRepoPage({ limit: 20 })).facets.all

    test('同一个库上，一个存储失效，另一个存储的切面缓存随之作废；另一个库的失效不作废它', async () => {
      const db = harness.db
      const reader = storeOn(db)
      const before = await facetsAll(reader)
      await rawInsert(db, 'repo-548-a')
      expect(await facetsAll(reader)).toBe(before)
      storeOn(harness.database(1).db).invalidateCachedRepoFacets()
      expect(await facetsAll(reader)).toBe(before)
      storeOn(db).invalidateCachedRepoFacets()
      expect(await facetsAll(reader)).toBe(before + 1)
    })

    test('同一个库上的并发同一查询只读一次，另一个库各读各的', async () => {
      const db = harness.db
      const reader = storeOn(db)
      const writer = storeOn(db)
      const [a, b] = await Promise.all([
        reader.listCachedRepoPage({ limit: 20 }),
        writer.listCachedRepoPage({ limit: 20 }),
      ])
      expect(a).toBe(b)
      const [c, d] = await Promise.all([
        reader.listCachedRepoPage({ q: ' acme ', limit: 20 }),
        reader.listCachedRepoPage({ q: 'acme', limit: 20 }),
      ])
      expect(c).toBe(d)
      const [e, f] = await Promise.all([
        reader.listCachedRepoPage({ limit: 20 }),
        reader.listCachedRepoPage({ limit: 19 }),
      ])
      expect(e).not.toBe(f)
      const [g, h] = await Promise.all([
        reader.listCachedRepoPage({ limit: 20 }),
        storeOn(harness.database(1).db).listCachedRepoPage({ limit: 20 }),
      ])
      expect(g).not.toBe(h)
    })

    test('真实库的事务与库取到同一份按库状态', async () => {
      const db = harness.db
      const key = databaseStateKey(() => ({}))
      const outer = databaseStateOf(db, key)
      const inner = await databaseSessionFor(db).transaction(async (tx) => databaseStateOf(tx, key))
      expect(inner).toBe(outer)
    })
  },
  { databaseCount: 2 },
)

describe('RFC-548 负对照', () => {
  const clean = [
    ...FILES.map((path) => sourceUnit(path, 'export const ready = true\n')),
    sourceUnit(COMPOSER, 'const imports = createRepositoryBatchImports()\n'),
  ]
  const replace = (path: string, text: string) =>
    clean.map((unit) => (unit.path === path ? sourceUnit(path, text) : unit))

  test('伪造的干净语料没有违例', () => {
    expect(sourceControlStateViolations(clean)).toEqual([])
  })

  test('模块级状态、重置函数与第二处构造都会被认出', () => {
    const units = [
      ...replace(
        FILES[0]!,
        'let globalInFlight = 0\nexport function __resetBatchImportForTests() { globalInFlight = 0 }\n',
      ),
      sourceUnit(
        SRC + 'bootstrap/daemonSession.ts',
        'const again = createRepositoryBatchImports()\n',
      ),
    ]
    expect(sourceControlStateViolations(units)).toEqual([
      `batch imports constructed in: ${COMPOSER}, ${SRC}bootstrap/daemonSession.ts`,
      'module-level let:repositoryBatchImport.ts:globalInFlight',
      'mutable singleton:repositoryBatchImport.ts:globalInFlight',
      `names __resetBatchImportForTests: ${FILES[0]}`,
      `names globalInFlight: ${FILES[0]}`,
    ])
  })

  test('没有任何构造也会被认出', () => {
    expect(
      sourceControlStateViolations(FILES.map((path) => sourceUnit(path, 'export {}\n'))),
    ).toEqual(['batch imports constructed in: nowhere'])
  })
})
