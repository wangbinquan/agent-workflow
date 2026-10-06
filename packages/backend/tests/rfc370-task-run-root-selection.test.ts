// RFC-370: the complete root selection must preserve content identity, receivers,
// per-drive binding and async acknowledgement before any Task effect.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import type {
  TaskDriveRequest,
  TaskExecutionContextRef,
} from '@/modules/task-execution/application/ports/taskExecutionTopology'
import type { TaskRunOwnerDependencies } from '@/modules/task-execution/application/ports/taskRunSelection'
import {
  bindTaskRunRootSelection,
  selectTaskRunRootSelection,
  taskRunBindingPending,
  type TaskRunRootSelection,
} from '@/modules/task-execution/composition/taskRunSelection'
import { composeLegacyTaskRunDriveBinding } from '@/modules/task-execution/composition/localTaskRunSelection'
import { held, callablePromise } from './helpers/portArtifactContent'
import {
  chosenTaskRuns,
  unusedAgentFamily,
  unusedScriptFamily,
  unusedTaskRunContents,
} from './helpers/taskRunSelection'

const owners = {
  nodeRunRuntime: Object.freeze({}),
  runtimeRegistry: Object.freeze({}),
} as unknown as TaskRunOwnerDependencies
function request(taskId: string): TaskDriveRequest {
  return {
    taskId,
    appHome: 'legacy:home',
    binaryOverride: ['legacy:binary'],
    configPath: 'legacy:config',
    signal: new AbortController().signal,
    executionContext: Object.freeze({}) as TaskExecutionContextRef,
  }
}

describe('RFC-370 complete Task run selection', () => {
  test('an absent whole choice leaves native bootstrap construction to its original boundary', () => {
    expect(selectTaskRunRootSelection()).toBeUndefined()
  })

  test('every incomplete explicit choice fails before binding any family', () => {
    const chosen = chosenTaskRuns(unusedTaskRunContents())
    const runs = chosen.selection.runs
    const invalid = [
      null,
      {},
      { runs },
      { ...chosen.selection, runs: null },
      {
        ...chosen.selection,
        runs: { ...runs, contentNamespace: { kind: 'wrong', reference: {} } },
      },
      {
        ...chosen.selection,
        runs: {
          ...runs,
          contentNamespace: { kind: 'task-run-content-namespace', reference: null },
        },
      },
      { ...chosen.selection, runs: { ...runs, nodeRunPrompts: { read() {} } } },
      { ...chosen.selection, runs: { ...runs, portArtifacts: { read() {} } } },
      { ...chosen.selection, runs: { ...runs, taskAgentRunsFor: undefined } },
      { ...chosen.selection, runs: { ...runs, taskScriptRunsFor: undefined } },
    ]
    for (const value of invalid) {
      expect(() => selectTaskRunRootSelection(value as TaskRunRootSelection)).toThrow(TypeError)
    }
    expect(chosen.agents).toEqual([])
    expect(chosen.scripts).toEqual([])
    const badConfiguration = bindTaskRunRootSelection({
      ...chosen.selection,
      configurationFor: () => ({ kind: 'task-run-configuration', reference: null }) as never,
    })
    expect(() => badConfiguration.drive.bind(request('invalid'), owners)).toThrow(TypeError)
    expect(chosen.agents).toEqual([])
  })

  test('selected receivers, opaque references and owner inputs survive fresh root and child bindings', () => {
    const contents = unusedTaskRunContents()
    const configurations: object[] = []
    const families: object[] = []
    const chosen = chosenTaskRuns(contents)
    const selection: TaskRunRootSelection = {
      ...chosen.selection,
      runs: {
        ...chosen.selection.runs,
        taskAgentRunsFor(binding) {
          expect(this).toBe(selection.runs)
          chosen.agents.push(binding)
          const family = unusedAgentFamily()
          families.push(family)
          return family
        },
        taskScriptRunsFor(binding) {
          expect(this).toBe(selection.runs)
          chosen.scripts.push(binding)
          const family = unusedScriptFamily()
          families.push(family)
          return family
        },
      },
      configurationFor(received) {
        expect(this).toBe(selection)
        expect(received.appHome).toBe('legacy:home')
        const reference = Object.freeze({})
        configurations.push(reference)
        return { kind: 'task-run-configuration', reference }
      },
    }
    const root = bindTaskRunRootSelection(selection)
    for (const taskId of ['root', 'child', 'root']) {
      const drive = request(taskId)
      const bound = root.drive.bind(drive, owners)
      expect(taskRunBindingPending(bound)).toBe(false)
      if (taskRunBindingPending(bound)) throw new Error('sync selection unexpectedly yielded')
      expect(bound.nodeRunPrompts).toBe(contents.nodeRunPrompts)
      expect(bound.portArtifacts).toBe(contents.portArtifacts)
      const binding = chosen.agents.at(-1)!
      expect(chosen.scripts.at(-1)).toBe(binding)
      expect(binding.taskId).toBe(taskId)
      expect(binding.executionContext).toBe(drive.executionContext)
      expect(binding.signal).toBe(drive.signal)
      expect(binding.nodeRunRuntime).toBe(owners.nodeRunRuntime)
      expect(binding.runtimeRegistry).toBe(owners.runtimeRegistry)
      expect(binding.contentNamespace).toBe(selection.runs.contentNamespace)
      expect(binding).not.toHaveProperty('appHome')
      expect(binding).not.toHaveProperty('binaryOverride')
      expect(binding).not.toHaveProperty('configPath')
    }
    expect(new Set(configurations).size).toBe(3)
    expect(new Set(families).size).toBe(6)
    expect(root.nodeRunPrompts).toBe(contents.nodeRunPrompts)
    expect(root.portArtifacts).toBe(contents.portArtifacts)
  })

  test('Agent acknowledgement precedes script binding, and script acknowledgement precedes delivery', async () => {
    const agent = held<ReturnType<typeof unusedAgentFamily>>()
    const script = held<ReturnType<typeof unusedScriptFamily>>()
    const enteredScript = held<void>()
    const events: string[] = []
    const chosen = chosenTaskRuns(unusedTaskRunContents(), {
      agent() {
        events.push('agent')
        return callablePromise(agent.promise)
      },
      script() {
        events.push('script')
        enteredScript.resolve()
        return script.promise
      },
    })
    const pending = bindTaskRunRootSelection(chosen.selection).drive.bind(request('ack'), owners)
    expect(taskRunBindingPending(pending)).toBe(true)
    expect(events).toEqual(['agent'])
    const agentFamily = unusedAgentFamily(),
      scriptFamily = unusedScriptFamily()
    agent.resolve(agentFamily)
    await enteredScript.promise
    expect(events).toEqual(['agent', 'script'])
    let delivered = false
    const completion = Promise.resolve(pending).then((bound) => {
      delivered = true
      return bound
    })
    await Promise.resolve()
    expect(delivered).toBe(false)
    script.resolve(scriptFamily)
    expect(await completion).toMatchObject({
      taskAgentRuns: agentFamily,
      taskScriptRuns: scriptFamily,
    })
  })

  test('sync and async binding failures retain the original error and do not choose native members', async () => {
    const reason = new Error('chosen bind unavailable')
    const sync = chosenTaskRuns(unusedTaskRunContents(), {
      agent() {
        throw reason
      },
    })
    let caught: unknown
    try {
      bindTaskRunRootSelection(sync.selection).drive.bind(request('sync'), owners)
    } catch (error) {
      caught = error
    }
    expect(caught).toBe(reason)
    expect(sync.scripts).toEqual([])
    const async = chosenTaskRuns(unusedTaskRunContents(), { agent: () => Promise.reject(reason) })
    await expect(
      bindTaskRunRootSelection(async.selection).drive.bind(request('async'), owners),
    ).rejects.toBe(reason)
    expect(async.scripts).toEqual([])
    const script = chosenTaskRuns(unusedTaskRunContents(), { script: () => Promise.reject(reason) })
    await expect(
      bindTaskRunRootSelection(script.selection).drive.bind(request('script'), owners),
    ).rejects.toBe(reason)
  })

  test('the native compatibility bridge keeps four-factory order and lazy legacy inputs on every drive', () => {
    const contents = unusedTaskRunContents(),
      calls: string[] = []
    let current: TaskDriveRequest
    const binding = composeLegacyTaskRunDriveBinding({
      nodeRunPromptsFor(home) {
        expect(home).toBe('legacy:home')
        calls.push('prompt')
        return contents.nodeRunPrompts
      },
      portArtifactsFor(home) {
        expect(home).toBe('legacy:home')
        calls.push('archive')
        return contents.portArtifacts
      },
      taskAgentRunsFor(received) {
        expect(received.request).toBe(current)
        calls.push('agent')
        return unusedAgentFamily()
      },
      taskScriptRunsFor(received) {
        expect(received).toBe(current)
        calls.push('script')
        return unusedScriptFamily()
      },
    })
    for (const taskId of ['root', 'child']) {
      current = request(taskId)
      Object.defineProperties(current, {
        binaryOverride: {
          get() {
            throw new Error('binary must remain lazy')
          },
        },
        configPath: {
          get() {
            throw new Error('configuration must remain lazy')
          },
        },
      })
      expect(taskRunBindingPending(binding.bind(current, owners))).toBe(false)
    }
    expect(calls).toEqual([
      'prompt',
      'archive',
      'agent',
      'script',
      'prompt',
      'archive',
      'agent',
      'script',
    ])
  })

  test('all actual roots pass the same whole selection while common runtime no longer names a local binding', () => {
    const read = (path: string) => readFileSync(resolve(import.meta.dir, '../src', path), 'utf8')
    for (const path of ['cli/start.ts', 'cli/postgresqlDaemonApplication.ts', 'server.ts']) {
      const source = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true)
      const calls: string[] = []
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'selectTaskRunRootSelection'
        ) {
          calls.push(node.arguments[0]!.getText(source))
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
      expect(calls).toHaveLength(1)
      expect(calls[0]).toMatch(/^(input|deps)\.taskRunSelection$/)
    }
    const start = read('cli/start.ts')
    expect(start).toContain('taskRunSelection: opts.taskRunSelection')
    expect(start).toContain('taskRunSelection: input.taskRunSelection')
    const runtime = read(
      'modules/task-execution/infrastructure/taskExecutionRuntimeParticipants.ts',
    )
    expect(runtime).not.toContain('LocalTaskAgentRunFamilyBinding')
    expect(runtime).toContain('input.taskRunBinding.bind(request')
  })
})
