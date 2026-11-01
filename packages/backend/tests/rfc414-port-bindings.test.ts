// RFC-414: the persistence / filesystem / git work that left task-execution composition runs in infrastructure and is
// bound back unchanged. These cases drive the new owners directly — the shared task status and workspace reads and the
// digital-employee execution metadata read on both providers, the preparation GC phase's delegation and receipt merge,
// the zero-delta canonical delta's no-base refusal, the local action workspace entry check — and lock that composition
// still binds them where the moved code was.
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { taskFixture, workflowFixture } from './helpers/model'
import { describeEachProvider } from './helpers/eachProvider'
import {
  readTaskStatus,
  readTaskWorkspaceRef,
} from '@/modules/task-execution/infrastructure/taskExecutionTaskReads'
import { readDigitalEmployeeExecutionMetadata } from '@/modules/task-execution/infrastructure/digitalEmployeeExecutionReads'
import { runWorkspacePreparationGcPhase } from '@/modules/task-execution/infrastructure/workspacePreparationGc'
import { composeWorkspacePreparationMaintenance } from '@/modules/task-execution/composition/workspacePreparationMaintenance'
import { countCanonicalFilesChanged } from '@/modules/task-execution/infrastructure/local/canonicalDelta'
import { localActionWorkspaceEntries } from '@/modules/task-execution/infrastructure/local/localActionWorkspaceEntries'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const COMPOSITION = resolve(import.meta.dir, '../src/modules/task-execution/composition')
const source = (file: string) => readFileSync(resolve(COMPOSITION, file), 'utf8')

describeEachProvider('RFC-414 task-execution infrastructure reads', (harness) => {
  async function seedTask(taskId: string, extra: Record<string, unknown> = {}) {
    await workflowFixture(
      harness.db,
      {
        id: `wf-${taskId}`,
        name: `wf-${taskId}`,
        definition: '{}',
        version: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      { onConflict: 'ignore' },
    )
    await taskFixture(harness.db, {
      id: taskId,
      name: taskId,
      workflowId: `wf-${taskId}`,
      workflowSnapshot: '{}',
      repoPath: '/tmp/rfc414',
      worktreePath: `/tmp/rfc414/${taskId}`,
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      baseCommit: null,
      status: 'running',
      inputs: '{}',
      startedAt: 1,
      executionLineageId: taskId,
      lineageSlotPathJson: JSON.stringify([
        { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
      ]),
      ...extra,
    })
  }

  test('the status and workspace reads return the row values and an absent row as null / undefined', async () => {
    await seedTask('rfc414-a')
    expect(await readTaskStatus(harness.db, 'rfc414-a')).toBe('running')
    expect(await readTaskWorkspaceRef(harness.db, 'rfc414-a')).toBe('/tmp/rfc414/rfc414-a')
    expect(await readTaskStatus(harness.db, 'rfc414-missing')).toBeNull()
    expect(await readTaskWorkspaceRef(harness.db, 'rfc414-missing')).toBeUndefined()
  })

  test('the digital-employee execution metadata reads the round and the auto-recovery flag', async () => {
    await seedTask('rfc414-de', { digitalEmployeeRoundId: 'round-1', autoRecoverySuspended: true })
    await seedTask('rfc414-plain')
    expect(await readDigitalEmployeeExecutionMetadata(harness.db, 'rfc414-de')).toEqual({
      roundRef: 'round-1',
      autoRecoverySuspended: true,
    })
    expect(await readDigitalEmployeeExecutionMetadata(harness.db, 'rfc414-plain')).toEqual({
      roundRef: null,
      autoRecoverySuspended: false,
    })
    expect(await readDigitalEmployeeExecutionMetadata(harness.db, 'rfc414-missing')).toBeNull()
  })

  test('an orphan phase with no pending preparation passes the request through and adds nothing', async () => {
    const calls: unknown[] = []
    const maintenance = {
      async runGcPhase(request: unknown) {
        calls.push(request)
        return { scanned: 3, removed: 1, skipped: 2 }
      },
      async recover() {
        throw new Error('not used')
      },
    }
    const appHome = mkdtempSync(join(tmpdir(), 'aw-rfc414-'))
    directories.push(appHome)
    const receipt = await runWorkspacePreparationGcPhase(
      {
        db: harness.db,
        appHome,
        repositoryPreparation: {} as never,
        maintenance: maintenance as never,
      },
      { phase: 'orphan', activeTaskIds: ['t1'], now: 10 } as never,
    )
    expect(receipt).toEqual({ scanned: 3, removed: 1, skipped: 2 })
    expect(calls).toEqual([{ phase: 'orphan', activeTaskIds: ['t1'], now: 10 }])
  })
})

test('the composed maintenance hands other phases straight to source-control without touching the database', async () => {
  const calls: unknown[] = []
  const db = new Proxy(
    {},
    {
      get() {
        throw new Error('database must not be read for this phase')
      },
    },
  )
  const command = composeWorkspacePreparationMaintenance({
    db: db as never,
    appHome: '/unused',
    repositoryPreparation: {} as never,
    maintenance: {
      async runGcPhase(request: unknown) {
        calls.push(request)
        return { scanned: 0, removed: 0, skipped: 0 }
      },
      async recover() {
        return undefined as never
      },
    } as never,
  })
  await command.runGcPhase({ phase: 'worktree', activeTaskIds: [] } as never)
  expect(calls).toEqual([{ phase: 'worktree', activeTaskIds: [] }])
})

test('the canonical delta refuses without any base commit, with the original message', async () => {
  await expect(countCanonicalFilesChanged([])).rejects.toThrow(
    'no base commit on any repo — cannot compute canonical delta',
  )
  await expect(
    countCanonicalFilesChanged([{ worktreePath: '/nowhere', baseCommit: null }]),
  ).rejects.toThrow('no base commit on any repo — cannot compute canonical delta')
})

test('the local action workspace entries check the daemon filesystem below the workspace', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'aw-rfc414-entries-'))
  directories.push(workspace)
  mkdirSync(join(workspace, '.git'))
  writeFileSync(join(workspace, 'input.txt'), 'x')
  expect(await localActionWorkspaceEntries.exists(workspace, '.git')).toBe(true)
  expect(await localActionWorkspaceEntries.exists(workspace, 'input.txt')).toBe(true)
  expect(await localActionWorkspaceEntries.exists(workspace, 'absent')).toBe(false)
})

test('composition binds the moved I/O where the original code ran it', () => {
  expect(source('crewstationRecovery.ts')).toContain(
    'taskStatus: (taskId) => readTaskStatus(input.db, taskId),',
  )
  expect(source('crewstationExecution.ts')).toContain(
    'const workspaceRef = await readTaskWorkspaceRef(input.db, taskId)',
  )
  // RFC-415: the runners moved to application; the environment binding supplies both defaults.
  expect(source('actionExecutionEnvironment.ts')).toContain(
    'workspaceEntries: deps.workspaceEntries ?? localActionWorkspaceEntries,',
  )
  expect(source('actionExecutionEnvironment.ts')).toContain(
    'taskStatus: (executionRef: string) => readTaskStatus(deps.db, executionRef),',
  )
  expect(source('digitalEmployeeExecution.ts')).toContain(
    'load: (taskId: string) => readDigitalEmployeeExecutionMetadata(db, taskId),',
  )
  expect(source('digitalEmployeeExecution.ts')).toContain(
    'inspectDigitalEmployeeHumanReviewSnapshot(db, executionRef)',
  )
  expect(source('nodeExecution.ts')).toContain(
    'getCanonicalFilesChanged: () => countCanonicalFilesChanged(state.repos),',
  )
  expect(source('taskImageExecution.ts')).toContain(
    "from '../infrastructure/crewstation/taskImageExecution'",
  )
  expect(source('taskImageArchive.ts')).toContain(
    "from '../infrastructure/crewstation/taskImageArchive'",
  )
  expect(source('portOutputValidation.ts')).toContain(
    "export { resolveNativePortContentDetailed } from '../infrastructure/local/filePortOutputValidation'",
  )
})
