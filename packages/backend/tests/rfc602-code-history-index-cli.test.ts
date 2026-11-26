import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { databaseCommand, type LocalDatabaseMigrationOperations } from '@/cli/database'
import { composeLocalDatabaseMigrationCommandOperations } from '@/bootstrap/commandBootstraps'
import {
  createCodeHistoryIndexCommands,
  createCodeHistoryQueryReader,
} from '@/modules/code-capability/composition/historyQueries'
import type { CodeHistoryIndexBuildReceipt } from '@/modules/code-capability/public/types'
import { acquireLock, readPidFromLock, type Lock } from '@/platform/execution/local/daemonLock'
import { Paths } from '@/platform/configuration/installationPaths'
import { tablesOf } from '@/platform/persistence/sessionTables'
import { describeEachProvider } from './helpers/eachProvider'
import {
  historyFixtureSource,
  historyFixtureContent,
  seedCodeHistoryRows,
  seedEmptyCodeHistory,
} from './helpers/legacyCapabilitySeed'

async function withHome(body: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'rfc602-history-cli-'))
  const previous = process.env.AGENT_WORKFLOW_HOME
  process.env.AGENT_WORKFLOW_HOME = root
  try {
    await body(root)
  } finally {
    if (previous === undefined) delete process.env.AGENT_WORKFLOW_HOME
    else process.env.AGENT_WORKFLOW_HOME = previous
    rmSync(root, { recursive: true, force: true })
  }
}

function recordingLock() {
  const acquired: Lock[] = []
  let releases = 0
  return {
    acquired,
    get releases() {
      return releases
    },
    factory(path: string): Lock {
      const held = acquireLock(path)
      const lock = {
        ...held,
        release() {
          releases++
          held.release()
        },
      }
      acquired.push(lock)
      return lock
    },
  }
}

describeEachProvider('RFC-602 code history rebuild CLI with the real owner', (harness) => {
  const installation = { kind: 'converted' as const, source: historyFixtureSource }

  function operations() {
    const locks: Lock[] = []
    const owner = createCodeHistoryIndexCommands({
      db: harness.db,
      installation,
      content: {
        async read(ref) {
          // The outer command owns the lock through every archive read; the
          // owner and its content reader neither release it nor reacquire it.
          expect(readPidFromLock(Paths.lock)).toBe(process.pid)
          return historyFixtureContent.read(ref)
        },
      },
    })
    const migration = composeLocalDatabaseMigrationCommandOperations()
    return {
      locks,
      command: {
        ...migration,
        async codeHistoryRebuild(lock: Lock) {
          locks.push(lock)
          expect(lock.path).toBe(Paths.lock)
          expect(readPidFromLock(lock.path)).toBe(lock.pid)
          const result = await owner.rebuild()
          expect(readPidFromLock(lock.path)).toBe(lock.pid)
          return result
        },
      } satisfies LocalDatabaseMigrationOperations,
    }
  }

  async function seedOne() {
    await seedCodeHistoryRows(harness.db, 'code_work_items', {
      id: 'cli-item',
      codeHostEndpointId: 'endpoint',
      stableProjectId: 'project',
      capability: 'review',
      anchorKind: 'mr',
      anchorId: '7',
      status: 'open',
      epoch: 1,
      createdAt: 100,
    })
  }

  test(
    'JSON receipts describe fresh forced builds, retain source facts and hold one lock throughout',
    () =>
      withHome(async () => {
        await seedOne()
        const { codeHistoryArchives, codeHistoryIdIndex, codeHistoryQueryStates } = tablesOf(
          harness.db,
        )
        const originals = {
          archives: await harness.db
            .select()
            .from(codeHistoryArchives)
            .orderBy(codeHistoryArchives.id),
          ids: await harness.db
            .select()
            .from(codeHistoryIdIndex)
            .orderBy(codeHistoryIdIndex.sourceTable, codeHistoryIdIndex.originalId),
        }
        const binding = operations()
        const lock = recordingLock()
        const first = await databaseCommand(
          ['rebuild-code-history-index', '--json'],
          binding.command,
          lock.factory,
        )
        expect(first.status).toBe('ok')
        const initial = JSON.parse(first.output) as CodeHistoryIndexBuildReceipt
        expect(initial).toEqual({
          kind: 'ready',
          buildId: expect.any(String),
          previousBuildId: null,
          reused: false,
          records: 1,
        })
        const second = await databaseCommand(
          ['rebuild-code-history-index', '--json'],
          binding.command,
          lock.factory,
        )
        expect(second.status).toBe('ok')
        const rebuilt = JSON.parse(second.output) as CodeHistoryIndexBuildReceipt
        expect(rebuilt).toEqual({
          kind: 'ready',
          buildId: expect.any(String),
          previousBuildId: initial.buildId,
          reused: false,
          records: 1,
        })
        expect(rebuilt.buildId).not.toBe(initial.buildId)
        expect(first.output.endsWith('\n')).toBe(true)
        expect(lock.acquired).toHaveLength(2)
        expect(binding.locks).toEqual(lock.acquired)
        expect(lock.releases).toBe(2)
        expect(existsSync(Paths.lock)).toBe(false)
        expect(
          await harness.db.select().from(codeHistoryArchives).orderBy(codeHistoryArchives.id),
        ).toEqual(originals.archives)
        expect(
          await harness.db
            .select()
            .from(codeHistoryIdIndex)
            .orderBy(codeHistoryIdIndex.sourceTable, codeHistoryIdIndex.originalId),
        ).toEqual(originals.ids)
        expect(await harness.db.select().from(codeHistoryQueryStates)).toMatchObject([
          { state: 'ready', activeBuildId: rebuilt.buildId },
        ])
        expect(
          await createCodeHistoryQueryReader({ db: harness.db, installation }).find(
            'code_work_items',
            'cli-item',
          ),
        ).toMatchObject({ row: { id: 'cli-item', anchor_id: '7' } })
      }),
    30_000,
  )

  test(
    'a failed forced rebuild preserves its original diagnostic and repair permits an explicit retry',
    () =>
      withHome(async () => {
        await seedOne()
        const binding = operations()
        const lock = recordingLock()
        const first = await databaseCommand(
          ['rebuild-code-history-index', '--json'],
          binding.command,
          lock.factory,
        )
        expect(first.status).toBe('ok')
        const original = JSON.parse(first.output) as CodeHistoryIndexBuildReceipt
        const {
          codeHistoryIdIndex,
          codeHistoryQueryBuilds,
          codeHistoryQueryStates,
          codeHistoryQueryRecords,
        } = tablesOf(harness.db)
        const [entry] = await harness.db
          .select()
          .from(codeHistoryIdIndex)
          .where(eq(codeHistoryIdIndex.originalId, 'cli-item'))
        expect(entry).toBeDefined()
        await harness.db
          .delete(codeHistoryIdIndex)
          .where(eq(codeHistoryIdIndex.originalId, 'cli-item'))
        const failed = await databaseCommand(
          ['rebuild-code-history-index', '--json'],
          binding.command,
          lock.factory,
        )
        expect(failed.status).toBe('error')
        expect(JSON.parse(failed.output)).toEqual({
          code: 'code-history-index-invalid',
          message: 'code-history-index-invalid: code_work_items',
        })
        expect(existsSync(Paths.lock)).toBe(false)
        const [state] = await harness.db.select().from(codeHistoryQueryStates)
        expect(state).toMatchObject({
          state: 'unavailable',
          activeBuildId: original.buildId,
          failureCode: 'code-history-index-invalid',
          failureDetail: 'code-history-index-invalid: code_work_items',
        })
        expect(
          (
            await harness.db
              .select()
              .from(codeHistoryQueryBuilds)
              .where(eq(codeHistoryQueryBuilds.id, original.buildId!))
          )[0]?.state,
        ).toBe('ready')
        expect(
          await harness.db
            .select()
            .from(codeHistoryQueryRecords)
            .where(eq(codeHistoryQueryRecords.buildId, original.buildId!)),
        ).toHaveLength(1)
        await expect(
          createCodeHistoryQueryReader({ db: harness.db, installation }).find(
            'code_work_items',
            'cli-item',
          ),
        ).rejects.toMatchObject({ code: 'code-history-query-index-not-ready' })

        await harness.db.insert(codeHistoryIdIndex).values(entry!)
        const retried = await databaseCommand(
          ['rebuild-code-history-index'],
          binding.command,
          lock.factory,
        )
        expect(retried.status).toBe('ok')
        expect(retried.output).toMatch(/^Rebuilt code history index .+: 1 records\.\n$/)
        expect(
          await createCodeHistoryQueryReader({ db: harness.db, installation }).find(
            'code_work_items',
            'cli-item',
          ),
        ).toMatchObject({ row: { id: 'cli-item' } })
        expect(lock.acquired).toHaveLength(3)
        expect(lock.releases).toBe(3)
        expect(existsSync(Paths.lock)).toBe(false)
      }),
    30_000,
  )

  test(
    'human output retains the missing-table diagnostic and an initial failure can be repaired',
    () =>
      withHome(async () => {
        await seedEmptyCodeHistory(harness.db)
        const { codeHistoryArchives } = tablesOf(harness.db)
        await harness.db
          .delete(codeHistoryArchives)
          .where(eq(codeHistoryArchives.sourceTable, 'code_work_items'))
        const binding = operations()
        const lock = recordingLock()
        const failed = await databaseCommand(
          ['rebuild-code-history-index'],
          binding.command,
          lock.factory,
        )
        expect(failed).toEqual({
          status: 'error',
          output: 'database command failed: code-history-package-missing: code_work_items\n',
        })
        expect(lock.releases).toBe(1)
        await seedEmptyCodeHistory(harness.db)
        const repaired = await databaseCommand(
          ['rebuild-code-history-index', '--json'],
          binding.command,
          lock.factory,
        )
        expect(repaired.status).toBe('ok')
        expect(JSON.parse(repaired.output)).toMatchObject({
          kind: 'ready',
          previousBuildId: null,
          reused: false,
          records: 0,
        })
        expect(lock.releases).toBe(2)
      }),
    30_000,
  )

  test('unknown arguments do not acquire a lock or call the owner', () =>
    withHome(async () => {
      const binding = operations()
      const lock = recordingLock()
      for (const argv of [
        ['rebuild-code-history-index', '--force'],
        ['rebuild-code-history-index', '--json=true'],
        ['rebuild-code-history-index', 'extra', '--json'],
      ]) {
        const result = await databaseCommand(argv, binding.command, lock.factory)
        expect(result.status).toBe('usage-error')
        expect(result.output).toContain('agent-workflow db rebuild-code-history-index [--json]')
      }
      expect(binding.locks).toEqual([])
      expect(lock.acquired).toEqual([])
      const { codeHistoryQueryBuilds } = tablesOf(harness.db)
      expect(await harness.db.select().from(codeHistoryQueryBuilds)).toEqual([])
    }))

  test('an already held daemon lock leaves the owner untouched and keeps the existing lock', () =>
    withHome(async () => {
      const held = acquireLock(Paths.lock)
      try {
        const binding = operations()
        const lock = recordingLock()
        const result = await databaseCommand(
          ['rebuild-code-history-index', '--json'],
          binding.command,
          lock.factory,
        )
        expect(result.status).toBe('error')
        expect(JSON.parse(result.output)).toMatchObject({
          code: 'code-history-query-build-failed',
          message: expect.stringContaining(
            `daemon is running (pid ${process.pid}); stop it before`,
          ),
        })
        expect(binding.locks).toEqual([])
        expect(lock.acquired).toEqual([])
        expect(lock.releases).toBe(0)
        expect(readPidFromLock(Paths.lock)).toBe(held.pid)
        const { codeHistoryQueryBuilds } = tablesOf(harness.db)
        expect(await harness.db.select().from(codeHistoryQueryBuilds)).toEqual([])
      } finally {
        held.release()
      }
    }))
})

describe('RFC-602 rebuild CLI bootstrap lock ownership', () => {
  test(
    'the real bootstrap reuses its caller lock during fresh installation and never releases that external lock',
    () =>
      withHome(async () => {
        const assembled = composeLocalDatabaseMigrationCommandOperations()
        const lock = recordingLock()
        let passed: Lock | undefined
        const command = {
          ...assembled,
          async codeHistoryRebuild(held: Lock) {
            passed = held
            expect(readPidFromLock(Paths.lock)).toBe(held.pid)
            const result = await assembled.codeHistoryRebuild(held)
            expect(readPidFromLock(Paths.lock)).toBe(held.pid)
            return result
          },
        }
        // A fresh provider necessarily asks for the installation lock. Without
        // forwarding the caller's lease, this attempts to acquire its own lock again.
        const result = await databaseCommand(
          ['rebuild-code-history-index', '--json'],
          command,
          lock.factory,
        )
        expect(result.status).toBe('ok')
        expect(JSON.parse(result.output)).toEqual({
          kind: 'fresh-install',
          buildId: null,
          previousBuildId: null,
          reused: false,
          records: 0,
        })
        expect(passed).toBe(lock.acquired[0])
        expect(lock.acquired).toHaveLength(1)
        expect(lock.releases).toBe(1)
        expect(existsSync(Paths.lock)).toBe(false)
        expect(existsSync(Paths.databaseGenerationPointer)).toBe(true)
        const second = await databaseCommand(['rebuild-code-history-index'], assembled)
        expect(second).toEqual({
          status: 'ok',
          output: 'No converted code history is installed.\n',
        })
        expect(existsSync(Paths.lock)).toBe(false)
      }),
    30_000,
  )
})
