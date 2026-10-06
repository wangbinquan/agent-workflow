// RFC-370: exercise the selected script family through complete real provider
// Task drives. These owner-issued references are fixtures, not CS acceptance.
import { expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from 'ulid'
import {
  WORKFLOW_SCHEMA_VERSION,
  type ScriptLanguage,
  type WorkflowDefinition,
} from '@agent-workflow/shared'
import { nodeRuns, taskExecutionEffectAttempts, tasks, users, workflows } from '../src/db/schema'
import {
  ScriptDepsInstallError,
  type TaskScriptDependencyEnvironment,
  type TaskScriptDependencyInterpreter,
  type TaskScriptInterpreter,
  type TaskScriptOutcome,
  type TaskScriptResult,
  type TaskScriptRunContent,
  type TaskScriptRunFamily,
  type TaskScriptRunRequest,
  type TaskScriptStartReceipt,
} from '../src/modules/task-execution/application/ports/taskScriptRunFamily'
import { createTaskExecutionContext } from '../src/modules/task-execution/application/taskExecutionContext'
import { createWorkerIdentity } from '../src/modules/task-execution/domain/ownership'
import { requestHash } from '../src/modules/task-execution/domain/executionEffect'
import { ScriptDepsInstallError as CompatibilityScriptDepsInstallError } from '../src/services/scriptDepsEnv'
import { ScriptDepsInstallError as NativeScriptDepsInstallError } from '../src/modules/task-execution/infrastructure/local/scriptDepsEnv'
import { describeEachProvider } from './helpers/eachProvider'
import { createEachProviderTaskExecution } from './helpers/eachProviderTaskExecution'
import { MemoryIsolationFactory, MemoryIsolationStore } from './helpers/isolationWorkspace'
import { seedBuiltinRuntimes } from './helpers/runtimeRegistryApplication'
import { runtimeRegistryPersistence } from './helpers/runtimeRegistryPersistence'

type Scenario =
  | 'success'
  | 'ownerless'
  | 'retry'
  | 'writable'
  | 'deps-failed'
  | 'interpreter-missing'
  | 'aborted'
  | 'timeout'
  | 'nonzero'
  | 'truncated'
  | 'envelope-missing'
  | 'missing-resolver'
  | 'missing-executor'
type ReadRun = (id: string) => Promise<{ readonly runtimeParamsJson: string | null } | null>

test('native and compatibility dependency failures retain the same error constructor', () => {
  expect(CompatibilityScriptDepsInstallError).toBe(ScriptDepsInstallError)
  expect(NativeScriptDepsInstallError).toBe(ScriptDepsInstallError)
  expect(new CompatibilityScriptDepsInstallError('failed', 'original detail')).toBeInstanceOf(
    ScriptDepsInstallError,
  )
})

class OpaqueInterpreter implements TaskScriptInterpreter {
  readonly kind = 'task-script-interpreter' as const
  readonly reference = Object.freeze({})
  readonly label = 'selected interpreter'
  readonly version = 'selected version'
  get path(): never {
    throw new Error('ordinary script policy interpreted a native binary')
  }
}

class OpaqueStart implements TaskScriptStartReceipt {
  readonly kind = 'task-script-start' as const
  readonly reference = Object.freeze({})
  get pid(): never {
    throw new Error('ordinary script policy interpreted a native PID')
  }
  get spawnBinaryPath(): never {
    throw new Error('ordinary script policy interpreted a native binary')
  }
  get launchNonce(): never {
    throw new Error('ordinary script policy interpreted a native launch nonce')
  }
}

class SelectedScriptFamily implements TaskScriptRunFamily {
  #scenario: Scenario
  #language: ScriptLanguage
  #events: string[]
  #readRun: ReadRun
  readonly interpreter = Object.freeze(new OpaqueInterpreter())
  readonly dependencyInterpreterRef: TaskScriptDependencyInterpreter = Object.freeze({
    kind: 'task-script-dependency-interpreter',
    reference: Object.freeze({}),
  })
  readonly dependencyEnvironment: TaskScriptDependencyEnvironment = Object.freeze({
    kind: 'task-script-dependency-environment',
    reference: Object.freeze({}),
    hash: 'selected-deps',
  })
  readonly runContent: TaskScriptRunContent = Object.freeze({
    kind: 'task-script-run-content',
    reference: Object.freeze({}),
  })
  readonly startReceipt = Object.freeze(new OpaqueStart())
  readonly requests: TaskScriptRunRequest[] = []
  readonly trace = 'selected script resolution trace'
  readonly runtimeParamsJson = JSON.stringify({
    selectedScript: true,
    identity: 'opaque-interpreter-and-deps',
  })
  constructor(scenario: Scenario, events: string[], readRun: ReadRun, language: ScriptLanguage) {
    this.#scenario = scenario
    this.#language = language
    this.#events = events
    this.#readRun = readRun
  }
  #enter(name: string) {
    this.#events.push(name)
  }
  async resolveInterpreter(
    language: ScriptLanguage,
    overrides: Partial<Record<ScriptLanguage, string>>,
  ) {
    this.#enter('resolve')
    expect(language).toBe(this.#language)
    expect(overrides[language]).toBe('selected:override')
    return this.#scenario === 'interpreter-missing' ? null : this.interpreter
  }
  describeInterpreterResolution() {
    this.#enter('describe-missing')
    expect(this.#scenario).toBe('interpreter-missing')
    return this.trace
  }
  prepareRunContent(taskId: string, nodeRunId: string) {
    this.#enter('run-content')
    expect(taskId.length).toBeGreaterThan(0)
    expect(nodeRunId.length).toBeGreaterThan(0)
    return this.runContent
  }
  dependencyInterpreter(interpreter: TaskScriptInterpreter) {
    this.#enter('dependency-target')
    expect(interpreter).toBe(this.interpreter)
    return this.dependencyInterpreterRef
  }
  async ensureDependencies(input: Parameters<TaskScriptRunFamily['ensureDependencies']>[0]) {
    this.#enter('dependencies')
    expect(input.interpreter).toBe(this.dependencyInterpreterRef)
    expect(input.language).toBe(this.#language)
    expect(input.specs).toEqual([
      this.#language === 'python' ? 'selected-package==1.0.0' : 'selected-package@1.0.0',
    ])
    expect(input.timeoutMs).toBe(1234)
    await input.onLine?.('stdout', 'selected installation line')
    if (this.#scenario === 'deps-failed')
      throw new ScriptDepsInstallError('selected install failed', 'selected install detail')
    return this.dependencyEnvironment
  }
  runtimeParameters(input: Parameters<TaskScriptRunFamily['runtimeParameters']>[0]) {
    this.#enter('runtime-parameters')
    expect(input.interpreter).toBe(this.interpreter)
    expect(input.dependencies).toBe(this.#language === 'bash' ? null : this.dependencyEnvironment)
    return this.runtimeParamsJson
  }
  async recordUnownedStart(input: Parameters<TaskScriptRunFamily['recordUnownedStart']>[0]) {
    this.#enter('ownerless-start')
    expect(input.receipt).toBe(this.startReceipt)
    await input.persistence.patch({
      nodeRunId: input.nodeRunId,
      values: { runtimeParamsJson: input.runtimeParamsJson },
      ...input.executionContext(),
    })
  }
  async execute(input: TaskScriptRunRequest): Promise<TaskScriptOutcome> {
    this.#enter('execute')
    this.requests.push(input)
    expect(input.runContent).toBe(this.runContent)
    expect(input.interpreter).toBe(this.interpreter)
    expect(input.dependencies).toBe(this.#language === 'bash' ? null : this.dependencyEnvironment)
    expect(input.node.language).toBe(this.#language)
    expect(input.node.script).toBe('throw new Error("native-script-fallback-must-not-run")')
    expect(input.node.env).toEqual({ SCRIPT_MARKER: 'selected:script-marker' })
    expect(input.gitUserName).toBe('Selected Script')
    expect(input.gitUserEmail).toBe('selected-script@example.test')
    expect(input.workspaceRef.startsWith('memory:workspace:')).toBe(true)
    expect(input.repositories).toEqual([{ name: '', reference: input.workspaceRef }])
    expect(input.inputs).toEqual({})
    expect(input.iteration).toBe(0)
    expect(input.retryIndex).toBe(this.#scenario === 'retry' ? this.requests.length - 1 : 0)
    expect(input.shardKey).toBeNull()
    expect(input.envelopeNonce.length).toBeGreaterThan(0)
    expect(input.timeoutMs).toBe(4321)
    expect(input.requireStartReceipt).toBe(true)
    const nonzero =
      this.#scenario === 'nonzero' || (this.#scenario === 'retry' && input.retryIndex === 0)
    const result: TaskScriptResult = {
      outcome:
        this.#scenario === 'aborted'
          ? 'aborted'
          : this.#scenario === 'timeout'
            ? 'timeout'
            : 'exited',
      exitCode: nonzero
        ? 3
        : this.#scenario === 'aborted' || this.#scenario === 'timeout'
          ? null
          : 0,
      rawStdout:
        this.#scenario === 'envelope-missing'
          ? '<workflow-output nonce="wrong"><port name="summary">wrong</port></workflow-output>\n'
          : 'first\n\nlast\n',
      stderrTail: 'selected diagnostic',
      truncated: { stdout: this.#scenario === 'truncated', stderr: false },
      settlement: { kind: 'task-script-result', reference: Object.freeze({}) },
    }
    await input.beforeStart?.({
      project: (persistence, resources) => ({
        describe: () => ({
          requestHash: requestHash({ v: 1, nodeRunId: input.nodeRunId, family: 'selected-script' }),
          resourceKeys: Array.isArray(resources)
            ? resources
            : [`selected-workspace:${(resources as { writerWorkspace: string }).writerWorkspace}`],
          recoveryClass: 'managed-process-preactivation',
          classifierVersion: 'selected-script-v1',
          transportPolicyVersion: 'selected-script-v1',
        }),
        recordSpawnReceipt: async ({ receipt, ...identity }) => {
          this.#enter('owned-start')
          expect(receipt).toBe(this.startReceipt)
          // This fixture owner uses the existing native journal dialect. It
          // never launches a process and makes no remote durability claim.
          await persistence.recordProcessSpawn({
            ...identity,
            pid: 137,
            spawnBinaryPath: process.execPath,
            launchNonce: 'selected-fixture-' + input.nodeRunId,
          })
        },
        settlementReceipt: (received) => {
          this.#enter('effect-settlement')
          expect(received).toBe(result)
          return JSON.stringify({ selectedScript: true, outcome: received.outcome })
        },
      }),
    })
    this.#enter('start-ack')
    await input.onStarted?.(this.startReceipt)
    expect((await this.#readRun(input.nodeRunId))?.runtimeParamsJson).toBe(this.runtimeParamsJson)
    this.#enter('stdout-after-ack')
    await input.onStdoutLine?.('first')
    await input.onStdoutLine?.('')
    await input.onStdoutLine?.('last')
    await input.onStderrLine?.('selected diagnostic')
    return {
      result,
      failureCode:
        this.#scenario === 'timeout' ? 'script-timeout' : nonzero ? 'script-nonzero-exit' : null,
    }
  }
}

const failures = {
  'deps-failed': 'script-deps-install-failed',
  'interpreter-missing': 'script-interpreter-missing',
  timeout: 'script-timeout',
  nonzero: 'script-nonzero-exit',
  truncated: 'script-output-truncated',
  'envelope-missing': 'script-envelope-missing',
} as const

describeEachProvider(
  'RFC-370 complete Task script family through actual provider drives',
  (harness) => {
    const cases: ReadonlyArray<{ scenario: Scenario; language: ScriptLanguage }> = [
      ...(
        [
          'success',
          'ownerless',
          'retry',
          'writable',
          'deps-failed',
          'interpreter-missing',
          'aborted',
          'timeout',
          'nonzero',
          'truncated',
          'envelope-missing',
          'missing-resolver',
          'missing-executor',
        ] as const
      ).map((scenario) => ({ scenario, language: 'node' as const })),
      { scenario: 'success', language: 'bash' },
      { scenario: 'success', language: 'python' },
    ]
    for (const { scenario, language } of cases) {
      test(`${scenario} (${language}): selected opaque contents, real persistence and original Task policy`, async () => {
        const db = harness.db,
          appHome = mkdtempSync(join(tmpdir(), 'aw-script-family-'))
        const userId = ulid(),
          workflowId = ulid(),
          taskId = ulid(),
          events: string[] = []
        const isolation = new MemoryIsolationStore()
        let execution: Awaited<ReturnType<typeof createEachProviderTaskExecution>> | undefined
        let family: SelectedScriptFamily | undefined,
          selections = 0
        try {
          await db.insert(users).values({
            id: userId,
            username: userId,
            displayName: userId,
            role: 'admin',
            status: 'active',
            createdAt: 1,
            updatedAt: 1,
          })
          await seedBuiltinRuntimes(runtimeRegistryPersistence(db))
          const definition: WorkflowDefinition = {
            $schema_version: WORKFLOW_SCHEMA_VERSION,
            inputs: [],
            nodes: [
              {
                id: 'script',
                kind: 'script',
                language,
                script: 'throw new Error("native-script-fallback-must-not-run")',
                env: { SCRIPT_MARKER: 'selected:script-marker' },
                readonly: scenario !== 'writable',
                dependencies:
                  language === 'bash'
                    ? []
                    : [
                        language === 'python'
                          ? 'selected-package==1.0.0'
                          : 'selected-package@1.0.0',
                      ],
                ...(scenario === 'envelope-missing'
                  ? { outputs: [{ name: 'summary' }, { name: 'detail' }] }
                  : {}),
              },
            ],
            edges: [],
          }
          await db
            .insert(workflows)
            .values({ id: workflowId, name: workflowId, definition: JSON.stringify(definition) })
          await db.insert(tasks).values({
            id: taskId,
            executionLineageId: taskId,
            lineageSlotPathJson: JSON.stringify([
              { stableNodeKey: 'task-root', frozenOccurrenceKey: taskId, workflowRevision: null },
            ]),
            name: taskId,
            ownerUserId: userId,
            workflowId,
            workflowSnapshot: JSON.stringify(definition),
            repoPath: `memory:repository:${taskId}`,
            worktreePath: `memory:canonical:${taskId}`,
            baseBranch: 'main',
            branch: 'agent-workflow/' + taskId,
            status: 'pending',
            startedAt: 1,
            inputs: '{}',
            autoCommitPush: false,
            gitUserName: 'Selected Script',
            gitUserEmail: 'selected-script@example.test',
          })
          execution = await createEachProviderTaskExecution(
            harness,
            { appHome, defaultNodeRetries: 0 },
            userId,
            {
              workspacePresence: { exists: () => true },
              isolationWorkspaces: new MemoryIsolationFactory(isolation),
              taskScriptRunsFor(request) {
                selections++
                expect(request.taskId).toBe(taskId)
                expect(request.appHome).toBe(appHome)
                family = new SelectedScriptFamily(
                  scenario,
                  events,
                  (id) => execution!.persistence.nodeExecution.read(id),
                  language,
                )
                if (scenario === 'missing-resolver')
                  Object.defineProperty(family, 'resolveInterpreter', { value: undefined })
                if (scenario === 'missing-executor')
                  Object.defineProperty(family, 'execute', { value: undefined })
                return family
              },
            },
          )
          const intentId = ulid(),
            now = Date.now()
          let executionContext: ReturnType<typeof createTaskExecutionContext> | undefined
          if (scenario !== 'ownerless') {
            await execution.persistence.intents.submitContinuation({
              taskId,
              intentId,
              kind: 'launch',
              source: 'rest',
              actorUserId: userId,
              payload: { v: 1 },
              now,
              advanceOperationGeneration: false,
            })
            const token = await execution.persistence.ownership.claimPendingIntent({
              intentId,
              identity: createWorkerIdentity({
                ownerId: ulid(),
                daemonGeneration: 'script-family-' + ulid(),
              }),
              now,
              leaseMs: 30_000,
            })
            executionContext = createTaskExecutionContext({
              intentId,
              token,
              persistence: execution.persistence,
            })
          }
          await execution.provider.runtime.schedulerDriver.drive({
            taskId,
            appHome,
            defaultNodeRetries: scenario === 'retry' ? 1 : 0,
            defaultPerNodeTimeoutMs: 4321,
            scriptDepsInstallTimeoutMs: 1234,
            scriptInterpreters: { [language]: 'selected:override' },
            ...(executionContext === undefined ? {} : { executionContext }),
            signal: new AbortController().signal,
          })
          expect(selections).toBe(1)
          const rows = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).sort(
            (a, b) => (a.retryIndex ?? 0) - (b.retryIndex ?? 0),
          )
          expect(rows).toHaveLength(scenario === 'retry' ? 2 : 1)
          const row = rows[rows.length - 1]!
          const succeeds =
            scenario === 'success' ||
            scenario === 'ownerless' ||
            scenario === 'retry' ||
            scenario === 'writable'
          if (succeeds) {
            expect(row.status).toBe('done')
            expect(
              (await execution.persistence.nodeExecution.listOutputs(row.id)).map((output) => ({
                port: output.portName,
                value: output.content,
              })),
            ).toEqual([{ port: 'stdout', value: 'first\n\nlast\n' }])
            expect(events.indexOf('stdout-after-ack')).toBeGreaterThan(
              events.indexOf('runtime-parameters'),
            )
            expect(events).toContain(scenario === 'ownerless' ? 'ownerless-start' : 'owned-start')
            if (scenario !== 'ownerless') expect(events).toContain('effect-settlement')
            expect(isolation.merged).toHaveLength(scenario === 'writable' ? 1 : 0)
            if (scenario === 'retry') {
              expect(
                rows.map((run) => ({
                  status: run.status,
                  retry: run.retryIndex,
                  failure: run.failureCode,
                })),
              ).toEqual([
                { status: 'failed', retry: 0, failure: 'script-nonzero-exit' },
                { status: 'done', retry: 1, failure: null },
              ])
              expect(family!.requests.map((request) => request.retryIndex)).toEqual([0, 1])
              expect(isolation.discarded).toHaveLength(2)
            }
          } else if (scenario === 'aborted') {
            expect(row.status).toBe('canceled')
            expect(events).toContain('effect-settlement')
          } else if (scenario === 'missing-resolver' || scenario === 'missing-executor') {
            expect(row.status).not.toBe('done')
            expect(events).not.toContain('stdout-after-ack')
            expect(family!.requests).toHaveLength(0)
          } else {
            expect(row.status).toBe('failed')
            expect(row.failureCode).toBe(failures[scenario])
            if (scenario === 'deps-failed') {
              expect(row.errorMessage).toBe('selected install failed\nselected install detail')
              expect(events).not.toContain('execute')
            }
            if (scenario === 'interpreter-missing') {
              expect(row.errorMessage).toContain(family!.trace)
              expect(events).toEqual(['resolve', 'describe-missing'])
            }
          }
          if (scenario !== 'interpreter-missing') expect(events).not.toContain('describe-missing')
          const task = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!
          expect(task.status).toBe(
            succeeds ? 'done' : scenario === 'aborted' ? 'canceled' : 'failed',
          )
          if (scenario === 'missing-resolver' || scenario === 'missing-executor')
            expect(task.errorMessage).toContain(
              scenario === 'missing-resolver' ? 'resolveInterpreter' : 'execute',
            )
          if (family!.requests.length > 0 && scenario !== 'ownerless') {
            const attempts = await db
              .select()
              .from(taskExecutionEffectAttempts)
              .where(eq(taskExecutionEffectAttempts.intentId, intentId))
            const script = attempts.filter((attempt) => attempt.candidateId === 'script:' + row.id)
            expect(script).toHaveLength(1)
            expect(script[0]!.state).toBe('succeeded')
            expect(JSON.parse(script[0]!.receiptJson!)).toEqual({
              selectedScript: true,
              outcome:
                scenario === 'aborted' ? 'aborted' : scenario === 'timeout' ? 'timeout' : 'exited',
            })
          }
        } finally {
          await execution?.shutdown()
          rmSync(appHome, { recursive: true, force: true })
        }
      }, 30_000)
    }
  },
)
