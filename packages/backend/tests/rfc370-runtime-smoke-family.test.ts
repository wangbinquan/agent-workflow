// RFC-370: the ordinary Runtime diagnostic root selects one complete material/execution family.
// Original prepared/native smoke suites remain intact; these cases cover the new real selection.
import { afterEach, describe, expect, test } from 'bun:test'
import { createRuntimeSmokeMaterialIntent } from '../src/modules/task-execution/composition/runtimeSmoke'
import { createAgentInvocationPreparation } from '../src/modules/task-execution/composition/agentInvocationPreparation'
import type { AgentInvocationBinding } from '../src/modules/task-execution/application/ports/agentInvocation'
import type { AgentExecutionBinding } from '../src/modules/task-execution/application/ports/agentExecutionBinding'
import type {
  ExecutionEffectRequest,
  ExecutionEffectResult,
} from '../src/modules/task-execution/application/ports/executionEffect'
import type {
  AgentMaterialCompiler,
  AgentMaterialIntent,
  AgentMaterialWorkspace,
  PreparedAgentMaterial,
} from '../src/modules/runtime-management/public/participants'
import type { NormalizedEvent } from '../src/services/runtime/types'
import { emptyDeclaredManifest } from '../src/services/execution/agentInjection'
import { createLogger } from '../src/util/log'

import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeRuntimeSmokeRunFamily } from '../src/modules/task-execution/composition/runtimeSmokeRunFamily'
import { composeLocalRuntimeSmokeRunFamily } from '../src/modules/task-execution/composition/localRuntimeSmokeRunFamily'
import { createLocalRuntimeDiagnosticTargets } from '../src/modules/runtime-management/composition/runtimeDiagnosticTargets'
import type {
  RuntimeSmokeInvocationFamily,
  RuntimeSmokeRunRequest,
} from '../src/modules/task-execution/application/ports/runtimeSmoke'

function unused(): never {
  throw new Error('unselected smoke capability was read')
}

function selectedInvocation(protocol: 'opencode' | 'claude-code' = 'opencode') {
  const calls: string[] = []
  const state = {
    prepareError: undefined as Error | undefined,
    compileError: undefined as Error | undefined,
    bindError: undefined as Error | undefined,
    discardError: undefined as Error | undefined,
    intent: undefined as AgentMaterialIntent | undefined,
    submitted: undefined as ExecutionEffectRequest | undefined,
    stderr: '',
    eventFactory: (intent: AgentMaterialIntent): string[] => [
      JSON.stringify({
        kind: 'text',
        text: intent.prompt.match(/awsmoke-[0-9a-f]{16}/)![0],
        sessionId: 'selected:session',
        rawLine: 'selected event',
      }),
    ],
    result: {
      executionRef: 'selected:execution',
      outcome: 'ok',
      exitCode: 0,
      rawStdout: '',
      stderrTail: '',
      durationMs: 1,
    } as ExecutionEffectResult,
  }
  const workspace: AgentMaterialWorkspace = {
    workspace: { owner: 'source-control', reference: 'selected:working', version: 7 },
    runContent: { owner: 'runtime-management', reference: 'selected:run', version: 4 },
    retainedRef: 'selected:retained',
    prepare() {
      expect(this).toBe(workspace)
      calls.push('prepare')
      if (state.prepareError) throw state.prepareError
    },
    discard() {
      expect(this).toBe(workspace)
      calls.push('discard')
      if (state.discardError) throw state.discardError
    },
  }
  const material: PreparedAgentMaterial = {
    materialRef: 'selected:material',
    declared: emptyDeclaredManifest(),
    evidenceCapabilities: {
      usageNormalizer: false,
      nativeUsageCapture: false,
      spanCapture: false,
      sessionCapture: false,
      inventory: false,
      finalEvents: false,
      liveCapture: false,
      sessionSinkCapture: false,
    },
  }
  const binding: AgentInvocationBinding = {
    materialRef: material.materialRef,
    declared: material.declared,
    workspace,
    protocol: {
      kind: protocol,
      get capabilities() {
        return unused()
      },
      parseEvent(line) {
        calls.push('parse')
        const value = JSON.parse(line) as NormalizedEvent
        return typeof value.kind === 'string' ? value : null
      },
    },
    evidence: { captureSessions: unused },
    lifecycle: {
      beforeStart: () => {
        calls.push('before-start')
      },
      cleanup: () => {
        calls.push('cleanup')
      },
    },
    bindExecution(participants) {
      expect(this).toBe(binding)
      expect(participants).toBeUndefined()
      calls.push('bind-execution')
      const execution: AgentExecutionBinding = {
        executionRef: 'selected:execution',
        materialRef: material.materialRef,
        workspaceRef: workspace.workspace.reference,
        effect: {
          async submit(request) {
            state.submitted = request
            calls.push('submit')
            await request.beforeStart?.()
            for (const line of state.eventFactory(state.intent!))
              await request.capture?.onStdoutLine?.(line)
            if (state.stderr) await request.capture?.onStderrLine?.(state.stderr)
            if (state.result.outcome !== 'unreaped' && !state.result.cleanupFailed)
              await request.cleanup?.()
            return state.result
          },
        },
        acknowledgeOwner: unused,
        recordTaskReceipt: unused,
        reportUnreaped: unused,
        unreapedMessage: unused,
      }
      return execution
    },
  }
  const compiler: AgentMaterialCompiler = {
    async compile(actual) {
      expect(this).toBe(compiler)
      calls.push('compile')
      state.intent = actual
      if (state.compileError) throw state.compileError
      return material
    },
  }
  const preparation = createAgentInvocationPreparation({
    compiler,
    workspace,
    bind(actual) {
      expect(actual).toBe(material)
      calls.push('bind')
      if (state.bindError) throw state.bindError
      return binding
    },
  })
  const runtimeBinding = {
    owner: 'runtime-management' as const,
    reference: 'selected:runtime',
    version: 11,
  }
  const options = {
    protocol,
    preparation,
    runtimeBinding,
    timeoutMs: 42,
    log: createLogger('selected-smoke-test'),
  }
  return { calls, state, workspace, runtimeBinding, options, preparation }
}

const homes = new Set<string>()
afterEach(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true })
  homes.clear()
})

function selectedFamily(protocol: 'opencode' | 'claude-code') {
  const selected = selectedInvocation(protocol)
  const target = Object.freeze({
    protocol,
    label: 'display value which is not a command',
    receiptKey: 'revision:19',
    runtimeBinding: selected.runtimeBinding,
  })
  const request: RuntimeSmokeRunRequest = {
    protocol,
    target,
    model: 'selected-model',
    extraArgs: ['selected-flag', ''],
    isSandbox: true,
    timeoutMs: selected.options.timeoutMs,
    log: selected.options.log,
  }
  class Invocations implements RuntimeSmokeInvocationFamily {
    open(actual: RuntimeSmokeRunRequest, log: typeof selected.options.log) {
      expect<Invocations>(this).toBe(invocations)
      expect(actual).toBe(request)
      expect(actual.target).toBe(target)
      selected.calls.push('open')
      const opened = {
        materialize() {
          expect(this).toBe(opened)
          selected.calls.push('materialize')
          return {
            workspace: selected.workspace,
            prepareWorkspace: () => selected.workspace.prepare(),
            compile: (prompt: string) =>
              selected.preparation.compile(
                createRuntimeSmokeMaterialIntent(
                  {
                    get protocol() {
                      return actual.protocol
                    },
                    get model() {
                      return actual.model
                    },
                    get isSandbox() {
                      return actual.isSandbox
                    },
                    get extraArgs() {
                      return actual.extraArgs
                    },
                    get runtimeBinding() {
                      return actual.target.runtimeBinding
                    },
                  },
                  selected.preparation,
                  prompt,
                  log,
                ),
              ),
          }
        },
      }
      return opened
    }
  }
  const invocations = new Invocations()
  return { ...selected, request, target, family: composeRuntimeSmokeRunFamily({ invocations }) }
}

describe('RFC-370 complete Runtime smoke family', () => {
  for (const protocol of ['opencode', 'claude-code'] as const) {
    test(`${protocol}: prototype selection reaches the actual core and preserves the complete material`, async () => {
      const selected = selectedFamily(protocol)
      const result = await selected.family.run(selected.request)
      expect(result).toMatchObject({
        outcome: 'conforms',
        sawNonce: true,
        capturedSessionId: 'selected:session',
      })
      expect(selected.state.intent).toMatchObject({
        protocol,
        injection: { mcps: [] },
        agentName: 'aw-smoke',
        systemPrompt: 'You are a runtime smoke-test agent. Follow the user prompt exactly.',
        resolvedProfiles: [
          [
            'aw-smoke',
            {
              model: 'selected-model',
              variant: null,
              temperature: null,
              steps: null,
              maxSteps: null,
              isSandbox: true,
            },
          ],
        ],
        freshAgentRun: false,
        nodeRunId: 'runtime-smoke',
      })
      expect(selected.state.intent?.workspace).toBe(selected.workspace.workspace)
      expect(selected.state.intent?.runContent).toBe(selected.workspace.runContent)
      expect(selected.state.intent?.runtimeBinding).toBe(selected.target.runtimeBinding)
      expect(selected.state.intent?.extraArgs).toBe(selected.request.extraArgs)
      expect(selected.state.intent?.prompt).toMatch(/awsmoke-[0-9a-f]{16}/)
      expect(selected.state.submitted?.timeoutMs).toBe(42)
      expect(selected.calls).toEqual([
        'open',
        'materialize',
        'prepare',
        'compile',
        'bind',
        'bind-execution',
        'submit',
        'before-start',
        'parse',
        'cleanup',
        'discard',
      ])
      for (const field of ['cmd', 'env', 'runtimeBinary', 'configDir'])
        expect(selected.state.intent).not.toHaveProperty(field)
    })

    test(`${protocol}: native material and execution report a missing executable and release the real scratch`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'aw-runtime-family-'))
      homes.add(home)
      const targets = createLocalRuntimeDiagnosticTargets()
      let homeReads = 0
      const family = composeLocalRuntimeSmokeRunFamily({
        targets,
        appHome() {
          homeReads++
          return home
        },
      })
      const target = targets.capture({
        protocol: () => protocol,
        binaryPath: join(home, 'missing-runtime'),
      })
      expect(homeReads).toBe(0)
      const result = await family.run({ protocol, target, model: 'unused-model', timeoutMs: 1000 })
      expect(result).toMatchObject({ outcome: 'spawn-failed', conforms: false, exitCode: null })
      expect(result.detail).toContain('binary failed to start:')
      expect(homeReads).toBe(1)
      expect(readdirSync(join(home, 'scratch'))).toEqual([])
    })
  }

  test('logger and timeout read before prototype open; an open error allocates no workspace', async () => {
    const calls: string[] = [],
      failure = new Error('selected-open-failed')
    const selected = selectedFamily('opencode')
    class Invocations implements RuntimeSmokeInvocationFamily {
      open(): never {
        expect<Invocations>(this).toBe(invocations)
        calls.push('open')
        throw failure
      }
    }
    const invocations = new Invocations()
    const family = composeRuntimeSmokeRunFamily({ invocations })
    await expect(
      family.run({
        protocol: 'opencode',
        target: selected.target,
        get log() {
          calls.push('log')
          return selected.options.log
        },
        get timeoutMs() {
          calls.push('timeout')
          return 31
        },
      }),
    ).rejects.toBe(failure)
    expect(calls).toEqual(['log', 'timeout', 'open'])
    expect(selected.calls).toEqual([])
  })

  test('compile rejection and unreaped results retain the original core release boundaries', async () => {
    const failed = selectedFamily('opencode')
    failed.state.compileError = new Error('selected-material-failed')
    expect(await failed.family.run(failed.request)).toMatchObject({
      outcome: 'spawn-failed',
      detail: 'failed to prepare spawn: selected-material-failed',
    })
    expect(failed.calls).toEqual(['open', 'materialize', 'prepare', 'compile', 'discard'])
    const unreaped = selectedFamily('claude-code')
    unreaped.state.result = { ...unreaped.state.result, outcome: 'unreaped', exitCode: null }
    expect(await unreaped.family.run(unreaped.request)).toMatchObject({
      outcome: 'spawn-failed',
      detail: 'runtime process could not be reaped after termination',
    })
    expect(unreaped.calls).not.toContain('cleanup')
    expect(unreaped.calls).not.toContain('discard')
  })

  test('target capture keeps the protocol lazy and paired private bindings reject foreign references', () => {
    const owner = createLocalRuntimeDiagnosticTargets(),
      other = createLocalRuntimeDiagnosticTargets()
    let reads = 0
    const target = owner.capture({
      protocol: () => {
        reads++
        return 'opencode'
      },
      binaryPath: 'original-binary',
    })
    expect(reads).toBe(0)
    expect(target.label).toBe('original-binary')
    expect(target.receiptKey).toBe('original-binary')
    expect(owner.binary(target)).toBe('original-binary')
    expect(owner.runtimeBinding(target)).toBe(target.runtimeBinding)
    expect(owner.contents.runtimeBinary(target.runtimeBinding)).toBe('original-binary')
    expect(reads).toBe(0)
    expect(target.protocol).toBe('opencode')
    expect(reads).toBe(1)
    expect(() => other.binary(target)).toThrow('runtime-diagnostic-target-unavailable')
    expect(() => other.runtimeBinding(target)).toThrow('runtime-diagnostic-target-unavailable')
    expect(() => other.contents.runtimeBinary(target.runtimeBinding)).toThrow(
      'runtime-diagnostic-binding-unavailable',
    )
  })
})
