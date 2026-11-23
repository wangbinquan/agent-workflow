// RFC-539 — SQLite 文件快照的在途计数随数据库句柄走（RFC-294 S12 第二十步）。
//
// 锁三件事（design §3 的清单即退出门）：
// ① `platform/persistence/sqlite/systemProviderBackup.ts` 顶层没有 `let` 与 `new Map / Set / WeakMap / WeakSet`，在架构报告的模块级可变单例判据
//    里为空；生产代码不再引用删去的名字；`quickCheckOffThread(` 每处调用带两个实参、`vacuumIntoOffThread(` 每处带四个；备份取它快照的那个库
//    的计数器；迁移协调器的缺省安全备份用交进来的计数器；daemon 会话把自己库的那一份交给迁移模块，SQLite 维护适配器的 checkpoint 门问会话库
//    的那一份（语料下限 3,000）。
// ② 行为：计数器只在 `track` 期间在途、抛错也撤销、并发的两次都撤完才不在途；checkpoint 一拍在自己的库有快照时跳过、别的库有快照时照常；
//    两个库的上下文各一份，派生句柄与客户端共用，没有句柄上下文的对象取不到。
// ③ 两个引擎上的真库：两个独立的库各一份，真事务句柄与客户端共用同一份。
// 负对照只喂伪造的源码，不碰真实语料。
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import ts from 'typescript'
import { createFileSnapshotTracker } from '@/platform/persistence/fileSnapshots'
import {
  bindDatabaseHandle,
  fileSnapshotTrackerOf,
  inheritDatabaseHandle,
} from '@/platform/persistence/sessionTables'
import { persistenceSchemaBinding } from '@/platform/persistence/schema/tables'
import { createSqliteCapabilities } from '@/platform/persistence/capabilities'
import { databaseSessionFor } from '@/platform/persistence/databaseTransaction'
import { runSqliteWalCheckpointTick } from '@/platform/persistence/sqlite/systemMaintenanceOperations'
import { describeEachProvider } from './helpers/eachProvider'
import { mutableSingletons } from './architecture/architectureReport'
import { backendUnits, sourceUnit, type SourceUnit } from './architecture/census'

const REPO = resolve(import.meta.dir, '../../..')
const SRC = 'packages/backend/src/'
const BACKUP = SRC + 'platform/persistence/sqlite/systemProviderBackup.ts'
const TRACKER = SRC + 'platform/persistence/fileSnapshots.ts'
const COORDINATOR = SRC + 'modules/system-operations/infrastructure/databaseMigrationCoordinator.ts'
const SESSION = SRC + 'bootstrap/daemonSession.ts'
const ADAPTERS = SRC + 'bootstrap/daemonSessionAdapters.ts'
const CORPUS_TIMEOUT = 30_000
/** The process-level counter RFC-539 removed; production must not name it again. */
const REMOVED = ['activeDbSnapshots', 'isDbSnapshotInProgress']
const COLLECTIONS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet'])
const ARITY: Readonly<Record<string, number>> = { quickCheckOffThread: 2, vacuumIntoOffThread: 4 }

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  node.forEachChild((child) => walk(child, visit))
}
function calls(unit: SourceUnit, callee: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = []
  walk(unit.source, (node) => {
    if (ts.isCallExpression(node) && node.expression.getText(unit.source) === callee)
      found.push(node)
  })
  return found
}
/** The initializer texts of every `name: <initializer>` property assignment under `root`. */
function propertyValues(root: ts.Node, source: ts.SourceFile, name: string): string[] {
  const values: string[] = []
  walk(root, (node) => {
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === name)
      values.push(node.initializer.getText(source))
  })
  return values
}
function argumentTexts(unit: SourceUnit, call: ts.CallExpression): string[] {
  return call.arguments.map((argument) => argument.getText(unit.source))
}

export function fileSnapshotViolations(units: readonly SourceUnit[]): string[] {
  const errors = new Set<string>()
  const find = (path: string) => {
    const unit = units.find((candidate) => candidate.path === path)
    if (unit === undefined) errors.add('missing source: ' + path)
    return unit
  }
  // The backup file and the tracker file hold no module-level state (the count lives in each tracker's closure).
  for (const path of [BACKUP, TRACKER]) {
    const unit = find(path)
    if (unit === undefined) continue
    const file = path.slice(path.lastIndexOf('/') + 1)
    for (const statement of unit.source.statements) {
      if (!ts.isVariableStatement(statement)) continue
      for (const declaration of statement.declarationList.declarations) {
        const name = declaration.name.getText(unit.source)
        if ((statement.declarationList.flags & ts.NodeFlags.Let) !== 0)
          errors.add(`module-level let:${file}:${name}`)
        const init = declaration.initializer
        if (
          init !== undefined &&
          ts.isNewExpression(init) &&
          COLLECTIONS.has(init.expression.getText(unit.source))
        )
          errors.add(`module-level collection:${file}:${name}`)
      }
    }
    for (const entry of mutableSingletons([unit]))
      errors.add(`mutable singleton:${file}:${entry.symbol}`)
  }
  const backup = find(BACKUP)
  if (backup !== undefined) {
    const vacuum = calls(backup, 'vacuumIntoOffThread')
    if (
      vacuum.length !== 1 ||
      argumentTexts(backup, vacuum[0]!)[3] !== 'fileSnapshotTrackerOf(opts.db)'
    )
      errors.add('backup:snapshot tracker of the snapshotted database')
  }
  for (const unit of units) {
    if (!unit.path.startsWith(SRC)) continue
    walk(unit.source, (node) => {
      if (ts.isIdentifier(node) && REMOVED.includes(node.text))
        errors.add(`removed name:${unit.path}:${node.text}`)
    })
    for (const [callee, arity] of Object.entries(ARITY))
      for (const call of calls(unit, callee))
        if (call.arguments.length !== arity)
          errors.add(`snapshot without its tracker:${unit.path}:${callee}`)
  }
  const coordinator = find(COORDINATOR)
  if (coordinator !== undefined) {
    const created = calls(coordinator, 'createSqliteMigrationSafetyBackup')
    if (
      created.length !== 1 ||
      argumentTexts(coordinator, created[0]!).join(',') !== 'options.fileSnapshots'
    )
      errors.add('coordinator:safety backup tracker')
  }
  const session = find(SESSION)
  if (session !== undefined) {
    const modules = calls(session, 'composeDatabaseMigrationModule')
    const argument = modules[0]?.arguments[0]
    const values =
      modules.length === 1 && argument !== undefined
        ? propertyValues(argument, session.source, 'fileSnapshots')
        : []
    if (values.join(',') !== 'fileSnapshotTrackerOf(db)')
      errors.add('session:migration snapshot tracker')
  }
  const adapters = find(ADAPTERS)
  if (adapters !== undefined) {
    const gates = propertyValues(adapters.source, adapters.source, 'fileSnapshotInFlight').sort()
    if (
      JSON.stringify(gates) !==
      JSON.stringify(['() => false', 'fileSnapshotTrackerOf(db).inFlight'])
    )
      errors.add('adapters:checkpoint gate')
  }
  return [...errors].sort()
}

describe('RFC-539 ① 文件快照计数没有进程级状态；会话把自己库的那一份交下去', () => {
  test(
    '真实语料：备份文件没有模块级计数，快照都带计数器，备份取所快照库的那一份，会话把自己库的交给迁移与 checkpoint 门',
    () => {
      const units = backendUnits(REPO)
      expect(units.length).toBeGreaterThanOrEqual(3000)
      expect(fileSnapshotViolations(units)).toEqual([])
    },
    CORPUS_TIMEOUT,
  )
})

/** A provider-bound handle without a real connection: the context is what the tracker rides on. */
function boundHandle(): object {
  return bindDatabaseHandle(
    {},
    persistenceSchemaBinding().nativeTables.sqlite as never,
    createSqliteCapabilities(),
  )
}
function deferred(): {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
} {
  let resolvePromise!: () => void
  let rejectPromise!: (error: Error) => void
  const promise = new Promise<void>((resolveIt, rejectIt) => {
    resolvePromise = resolveIt
    rejectPromise = rejectIt
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}
const checkpoints: string[] = []
function fakeDatabase(name: string): Parameters<typeof runSqliteWalCheckpointTick>[0] {
  return {
    $client: { exec: () => checkpoints.push(name) },
  } as unknown as Parameters<typeof runSqliteWalCheckpointTick>[0]
}

describe('RFC-539 ② 随句柄走的行为', () => {
  test('只在 track 期间在途；抛错也撤销；并发的两次都撤完才不在途', async () => {
    const tracker = createFileSnapshotTracker()
    expect(tracker.inFlight()).toBe(false)
    const first = deferred()
    const second = deferred()
    const one = tracker.track(() => first.promise)
    const two = tracker.track(() => second.promise)
    expect(tracker.inFlight()).toBe(true)
    first.resolve()
    await one
    expect(tracker.inFlight()).toBe(true)
    second.reject(new Error('rfc539 snapshot failure'))
    await expect(two).rejects.toThrow('rfc539 snapshot failure')
    expect(tracker.inFlight()).toBe(false)
  })

  test('checkpoint 一拍在自己的库有快照时跳过，别的库有快照时照常', async () => {
    checkpoints.length = 0
    const mine = createFileSnapshotTracker()
    const other = createFileSnapshotTracker()
    const running = deferred()
    const snapshot = other.track(() => running.promise)
    expect(runSqliteWalCheckpointTick(fakeDatabase('mine'), mine)).toBe('checkpointed')
    expect(runSqliteWalCheckpointTick(fakeDatabase('other'), other)).toBe('skipped-snapshot')
    running.resolve()
    await snapshot
    expect(runSqliteWalCheckpointTick(fakeDatabase('other'), other)).toBe('checkpointed')
    expect(checkpoints).toEqual(['mine', 'other'])
  })

  test('两个库各一份；派生句柄与客户端共用；没有句柄上下文的对象取不到', async () => {
    const first = boundHandle()
    const second = boundHandle()
    expect(fileSnapshotTrackerOf(first)).not.toBe(fileSnapshotTrackerOf(second))
    expect(fileSnapshotTrackerOf(inheritDatabaseHandle({}, first))).toBe(
      fileSnapshotTrackerOf(first),
    )
    const running = deferred()
    const snapshot = fileSnapshotTrackerOf(first).track(() => running.promise)
    expect([
      fileSnapshotTrackerOf(first).inFlight(),
      fileSnapshotTrackerOf(second).inFlight(),
    ]).toEqual([true, false])
    running.resolve()
    await snapshot
    expect(() => fileSnapshotTrackerOf({})).toThrow('file-snapshot-handle-unbound')
  })
})

describeEachProvider(
  'RFC-539 ③ 两个引擎上的真库',
  (harness) => {
    test('两个独立的库各一份；真事务句柄与客户端共用同一份', async () => {
      const first = harness.db
      const second = harness.database(1).db
      const tracker = fileSnapshotTrackerOf(first)
      expect(fileSnapshotTrackerOf(second)).not.toBe(tracker)
      await databaseSessionFor(first).transaction(async (tx) => {
        expect(fileSnapshotTrackerOf(tx)).toBe(tracker)
      })
      const running = deferred()
      const snapshot = tracker.track(() => running.promise)
      expect([tracker.inFlight(), fileSnapshotTrackerOf(second).inFlight()]).toEqual([true, false])
      running.resolve()
      await snapshot
      expect(tracker.inFlight()).toBe(false)
    })
  },
  { databaseCount: 2 },
)

describe('RFC-539 负对照', () => {
  const clean = [
    sourceUnit(
      TRACKER,
      'export function createFileSnapshotTracker() { let active = 0; return { inFlight: () => active > 0 } }',
    ),
    sourceUnit(
      BACKUP,
      [
        'export async function quickCheckOffThread(dbPath, snapshots) { return snapshots.track(() => run(dbPath)) }',
        'export async function vacuumIntoOffThread(sqlite, dbPath, dest, snapshots) { return snapshots.track(() => run(dest)) }',
        'export async function createBackup(opts) { await vacuumIntoOffThread(sqlite, file, dest, fileSnapshotTrackerOf(opts.db)) }',
      ].join('\n'),
    ),
    sourceUnit(
      COORDINATOR,
      'const safetyBackup = options.safetyBackup ?? createSqliteMigrationSafetyBackup(options.fileSnapshots)',
    ),
    sourceUnit(
      SESSION,
      'const databaseMigration = composeDatabaseMigrationModule({ contract, fileSnapshots: fileSnapshotTrackerOf(db) })',
    ),
    sourceUnit(
      ADAPTERS,
      [
        "const sqlite = { maintenance: ({ db }) => ({ provider: 'sqlite', fileSnapshotInFlight: fileSnapshotTrackerOf(db).inFlight }) }",
        "const postgresql = { maintenance: () => ({ provider: 'postgresql', fileSnapshotInFlight: () => false }) }",
      ].join('\n'),
    ),
    sourceUnit(
      SRC + 'modules/system-operations/infrastructure/safety.ts',
      'await quickCheckOffThread(path, snapshots)',
    ),
  ]
  const replace = (path: string, text: string) =>
    clean.map((unit) => (unit.path === path ? sourceUnit(path, text) : unit))

  test('伪造的干净语料没有违例', () => {
    expect(fileSnapshotViolations(clean)).toEqual([])
  })

  test('模块级的计数、删去的名字与不带计数器的快照都会被认出', () => {
    expect(
      fileSnapshotViolations(
        replace(
          BACKUP,
          [
            'let activeDbSnapshots = 0',
            'export function isDbSnapshotInProgress() { return activeDbSnapshots > 0 }',
            'export async function createBackup(opts) { await vacuumIntoOffThread(sqlite, file, dest, fileSnapshotTrackerOf(opts.db)) }',
          ].join('\n'),
        ),
      ),
    ).toEqual([
      'module-level let:systemProviderBackup.ts:activeDbSnapshots',
      'mutable singleton:systemProviderBackup.ts:activeDbSnapshots',
      `removed name:${BACKUP}:activeDbSnapshots`,
      `removed name:${BACKUP}:isDbSnapshotInProgress`,
    ])
    expect(
      fileSnapshotViolations(
        replace(
          TRACKER,
          'let active = 0\nexport function createFileSnapshotTracker() { return { inFlight: () => active > 0 } }',
        ),
      ),
    ).toEqual([
      'module-level let:fileSnapshots.ts:active',
      'mutable singleton:fileSnapshots.ts:active',
    ])
    expect(
      fileSnapshotViolations(
        replace(
          SRC + 'modules/system-operations/infrastructure/safety.ts',
          'await quickCheckOffThread(path)',
        ),
      ),
    ).toEqual([
      `snapshot without its tracker:${SRC}modules/system-operations/infrastructure/safety.ts:quickCheckOffThread`,
    ])
  })

  test('备份不取所快照库的、协调器不用交进来的、会话交错了、checkpoint 门问错了，都会被认出', () => {
    expect(
      fileSnapshotViolations(
        replace(
          BACKUP,
          'export async function createBackup(opts) { await vacuumIntoOffThread(sqlite, file, dest, createFileSnapshotTracker()) }',
        ),
      ),
    ).toEqual(['backup:snapshot tracker of the snapshotted database'])
    expect(
      fileSnapshotViolations(
        replace(
          COORDINATOR,
          'const safetyBackup = createSqliteMigrationSafetyBackup(createFileSnapshotTracker())',
        ),
      ),
    ).toEqual(['coordinator:safety backup tracker'])
    expect(
      fileSnapshotViolations(
        replace(
          SESSION,
          'const databaseMigration = composeDatabaseMigrationModule({ contract, fileSnapshots: createFileSnapshotTracker() })',
        ),
      ),
    ).toEqual(['session:migration snapshot tracker'])
    expect(
      fileSnapshotViolations(
        replace(
          ADAPTERS,
          "const sqlite = { maintenance: () => ({ provider: 'sqlite', fileSnapshotInFlight: () => false }) }",
        ),
      ),
    ).toEqual(['adapters:checkpoint gate'])
  })
})
