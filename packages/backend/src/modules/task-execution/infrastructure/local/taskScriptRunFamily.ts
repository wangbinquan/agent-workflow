import { mkdirSync } from 'node:fs'
import type {
  TaskScriptDependencyEnvironment,
  TaskScriptDependencyInterpreter,
  TaskScriptInterpreter,
  TaskScriptResult,
  TaskScriptRunContent,
  TaskScriptRunFamily,
  TaskScriptStartReceipt,
} from '../../application/ports/taskScriptRunFamily'
import { runRootFor } from '@/services/runtime'
import type { ManagedProcessResult } from '@/platform/execution/local/managedProcess'
import {
  describeInterpreterResolution,
  resolveScriptInterpreter,
  runScriptProcess,
  type ResolvedInterpreter,
  type ScriptRunRequest,
} from './scriptRun'
import { ensureScriptDepsEnv, type ScriptDepsEnv } from './scriptDepsEnv'
import {
  createLocalProcessEffectProjection,
  type LocalProcessSpawnReceipt,
} from './processEffectProjection'

/** Local contents are interpreted only by this selected owner. The common
 * script policy retains interpreter/attempt/install/receipt/settlement order. */
export function createLocalTaskScriptRunFamily(): TaskScriptRunFamily {
  const interpreters = new WeakMap<object, ResolvedInterpreter>()
  const dependencyInterpreters = new WeakMap<object, { path: string; version: string }>()
  const environments = new WeakMap<object, ScriptDepsEnv>()
  const runContents = new WeakMap<object, string>()
  const starts = new WeakMap<object, LocalProcessSpawnReceipt>()
  const results = new WeakMap<object, ManagedProcessResult>()

  const contents = <T>(map: WeakMap<object, T>, reference: object, purpose: string): T => {
    const result = map.get(reference)
    if (result === undefined) throw new Error(`task-script-${purpose}-reference-unavailable`)
    return result
  }
  const interpreter = (value: TaskScriptInterpreter) =>
    contents(interpreters, value.reference, 'interpreter')
  const dependencies = (value: TaskScriptDependencyEnvironment | null) =>
    value === null ? null : contents(environments, value.reference, 'dependencies')
  const start = (value: TaskScriptStartReceipt) => contents(starts, value.reference, 'start')
  const settlement = (value: TaskScriptResult) =>
    contents(results, value.settlement.reference, 'result')

  return {
    async resolveInterpreter(language, overrides) {
      const resolved = await resolveScriptInterpreter(language, overrides)
      if (resolved === null) return null
      const reference = {}
      interpreters.set(reference, resolved)
      return {
        kind: 'task-script-interpreter',
        reference,
        get label() {
          return resolved.path
        },
        get version() {
          return resolved.version
        },
      }
    },
    describeInterpreterResolution(language, overrides) {
      return describeInterpreterResolution(language, overrides)
    },
    prepareRunContent(taskId, nodeRunId): TaskScriptRunContent {
      const runDir = runRootFor(taskId, nodeRunId)
      mkdirSync(runDir, { recursive: true })
      const reference = {}
      runContents.set(reference, runDir)
      return { kind: 'task-script-run-content', reference }
    },
    dependencyInterpreter(value): TaskScriptDependencyInterpreter {
      const resolved = interpreter(value)
      // Read at the old consecutive path/version argument positions, before
      // the remaining dependency-install option values are evaluated.
      const path = resolved.path
      const version = resolved.version
      const reference = {}
      dependencyInterpreters.set(reference, { path, version })
      return { kind: 'task-script-dependency-interpreter', reference }
    },
    async ensureDependencies(input) {
      const target = contents(
        dependencyInterpreters,
        input.interpreter.reference,
        'dependency-interpreter',
      )
      const resolved = await ensureScriptDepsEnv({
        appHome: input.contentHomeRef,
        language: input.language,
        interpreterPath: target.path,
        interpreterVersion: target.version,
        specs: input.specs,
        timeoutMs: input.timeoutMs,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.onLine === undefined ? {} : { onLine: input.onLine }),
        ...(input.log === undefined ? {} : { log: input.log }),
      })
      if (resolved === null) return null
      const reference = {}
      environments.set(reference, resolved)
      return {
        kind: 'task-script-dependency-environment',
        reference,
        get hash() {
          return resolved.hash
        },
      }
    },
    async execute(input) {
      const outcome = await runScriptProcess({
        node: input.node,
        inputs: input.inputs,
        runDir: contents(runContents, input.runContent.reference, 'run-content'),
        worktreePath: input.workspaceRef,
        repos: input.repositories.map((r) => ({ name: r.name, path: r.reference })),
        taskId: input.taskId,
        nodeId: input.nodeId,
        nodeRunId: input.nodeRunId,
        iteration: input.iteration,
        retryIndex: input.retryIndex,
        shardKey: input.shardKey,
        envelopeNonce: input.envelopeNonce,
        interpreter: interpreter(input.interpreter),
        depsEnv: dependencies(input.dependencies),
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.killEscalationGraceMs === undefined
          ? {}
          : { killEscalationGraceMs: input.killEscalationGraceMs }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.beforeStart === undefined
          ? {}
          : {
              beforeSpawn: ({
                argv,
                cwd,
              }: Parameters<NonNullable<ScriptRunRequest['beforeSpawn']>>[0]) =>
                input.beforeStart?.({
                  project(persistence, resourceKeys) {
                    const projection = createLocalProcessEffectProjection({
                      persistence,
                      processKind: 'script',
                      argv,
                      cwd,
                      resourceKeys,
                    })
                    return {
                      describe: () => projection.describe(),
                      recordSpawnReceipt: ({ receipt, ...identity }) =>
                        projection.recordSpawnReceipt({ ...identity, receipt: start(receipt) }),
                      settlementReceipt: (result) =>
                        projection.settlementReceipt(settlement(result)),
                    }
                  },
                }),
            }),
        ...(input.onStarted === undefined
          ? {}
          : {
              onSpawned: async ({
                pid,
                spawnBinaryPath,
                launchNonce,
              }: Parameters<NonNullable<ScriptRunRequest['onSpawned']>>[0]) => {
                // The old callback destructured these three fields before reading
                // runtime parameters; keep that ordering at the native boundary.
                const reference = {}
                starts.set(reference, { pid, spawnBinaryPath, launchNonce })
                await input.onStarted?.({ kind: 'task-script-start', reference })
              },
            }),
        ...(input.requireStartReceipt === true ? { requireSpawnReceipt: true } : {}),
        ...(input.onStdoutLine === undefined ? {} : { onStdoutLine: input.onStdoutLine }),
        ...(input.onStderrLine === undefined ? {} : { onStderrLine: input.onStderrLine }),
        ...(input.gitUserName === undefined ? {} : { gitUserName: input.gitUserName }),
        ...(input.gitUserEmail === undefined ? {} : { gitUserEmail: input.gitUserEmail }),
        ...(input.log === undefined ? {} : { log: input.log }),
      })
      const result = outcome.result
      const reference = {}
      results.set(reference, result)
      return {
        result: {
          get outcome() {
            return result.outcome
          },
          get exitCode() {
            return result.exitCode
          },
          get rawStdout() {
            return result.rawStdout
          },
          get stderrTail() {
            return result.stderrTail
          },
          get truncated() {
            return result.truncated
          },
          get spawnError() {
            return result.spawnError
          },
          settlement: { kind: 'task-script-result', reference },
        },
        failureCode: outcome.failureCode,
      }
    },
    runtimeParameters(input) {
      const target = interpreter(input.interpreter)
      const depsEnv = dependencies(input.dependencies)
      return JSON.stringify({
        script: {
          interpreter: target.path,
          interpreterVersion: target.version,
          depsHash: depsEnv?.hash ?? null,
        },
      })
    },
    async recordUnownedStart(input) {
      const { pid, spawnBinaryPath, launchNonce } = start(input.receipt)
      await input.persistence.patch({
        nodeRunId: input.nodeRunId,
        values: {
          pid,
          spawnBinaryPath,
          spawnLaunchNonce: launchNonce ?? null,
          runtimeParamsJson: input.runtimeParamsJson,
        },
        ...input.executionContext(),
      })
    },
  }
}
