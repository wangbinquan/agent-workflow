// RFC-370 A-T5: exercise the actual shared smoke behavior with a selected
// opaque material/execution family, retaining the original result policies.
import { describe, expect, test } from 'bun:test'
import { runPreparedRuntimeSmoke } from '../src/modules/task-execution/composition/runtimeSmoke'
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

function unused(): never {
  throw new Error('unselected smoke capability was read')
}

function selectedSmoke(protocol: 'opencode' | 'claude-code' = 'opencode') {
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
  return { calls, state, workspace, runtimeBinding, options }
}

describe('RFC-370 selected runtime smoke', () => {
  for (const protocol of ['opencode', 'claude-code'] as const) {
    test(`${protocol}: one complete selected compilation and opaque ownerless execution retain nonce conformance`, async () => {
      const selected = selectedSmoke(protocol)
      const extraArgs = ['original-fork-arg', '']
      const result = await runPreparedRuntimeSmoke({
        ...selected.options,
        model: 'selected-model',
        extraArgs,
        isSandbox: true,
      })
      expect(result).toMatchObject({
        outcome: 'conforms',
        conforms: true,
        capturedSessionId: 'selected:session',
        sawNonce: true,
        sawEnvelope: false,
        exitCode: 0,
      })
      expect(selected.state.intent).toMatchObject({
        protocol,
        agentName: 'aw-smoke',
        systemPrompt: 'You are a runtime smoke-test agent. Follow the user prompt exactly.',
        injection: { mcps: [] },
        freshAgentRun: false,
        nodeRunId: 'runtime-smoke',
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
      })
      expect(selected.state.intent?.workspace).toBe(selected.workspace.workspace)
      expect(selected.state.intent?.runContent).toBe(selected.workspace.runContent)
      expect(selected.state.intent?.runtimeBinding).toBe(selected.runtimeBinding)
      expect(selected.state.intent?.extraArgs).toBe(extraArgs)
      expect(selected.state.intent).not.toHaveProperty('configDir')
      expect(selected.state.intent).not.toHaveProperty('runtimeBinary')
      expect(selected.state.submitted).toMatchObject({
        executionRef: 'selected:execution',
        materialRef: 'selected:material',
        workspaceRef: 'selected:working',
        timeoutMs: 42,
        termGraceMs: 2000,
      })
      expect(selected.state.submitted).not.toHaveProperty('onStarted')
      expect(selected.calls).toEqual([
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
    })
  }

  test('workspace preparation rejects at the original outside-catch boundary', async () => {
    const selected = selectedSmoke(),
      marker = new Error('selected workspace preparation failed')
    selected.state.prepareError = marker
    await expect(runPreparedRuntimeSmoke(selected.options)).rejects.toBe(marker)
    expect(selected.calls).toEqual(['prepare'])
  })

  test('compiler failure discards the same workspace without late binding or fallback', async () => {
    const selected = selectedSmoke()
    selected.state.compileError = new Error('selected material failed')
    expect(await runPreparedRuntimeSmoke(selected.options)).toEqual({
      outcome: 'spawn-failed',
      conforms: false,
      detail: 'failed to prepare spawn: selected material failed',
      sawNonce: false,
      sawEnvelope: false,
      exitCode: null,
    })
    expect(selected.calls).toEqual(['prepare', 'compile', 'discard'])
  })

  test('late binding failure keeps the original error without being recast as compilation failure', async () => {
    const selected = selectedSmoke(),
      marker = new Error('selected binding failed')
    selected.state.bindError = marker
    await expect(runPreparedRuntimeSmoke(selected.options)).rejects.toBe(marker)
    expect(selected.calls).toEqual(['prepare', 'compile', 'bind'])
  })

  for (const outcome of ['unreaped', 'cleanup-failed'] as const) {
    test(`${outcome}: the selected content is retained and not discarded`, async () => {
      const selected = selectedSmoke()
      selected.state.result =
        outcome === 'unreaped'
          ? { ...selected.state.result, outcome: 'unreaped', exitCode: null }
          : { ...selected.state.result, cleanupFailed: true }
      expect(await runPreparedRuntimeSmoke(selected.options)).toMatchObject({
        outcome: 'spawn-failed',
        conforms: false,
        sawNonce: false,
        sawEnvelope: false,
        exitCode: null,
      })
      expect(selected.calls).not.toContain('discard')
      expect(selected.calls).not.toContain('cleanup')
    })
  }

  test('spawn failure uses the selected discard and preserves its own failure identity', async () => {
    const selected = selectedSmoke(),
      marker = new Error('selected discard failed')
    selected.state.result = {
      ...selected.state.result,
      outcome: 'spawn-failed',
      spawnError: 'selected start failed',
      exitCode: null,
    }
    selected.state.discardError = marker
    await expect(runPreparedRuntimeSmoke(selected.options)).rejects.toBe(marker)
    expect(selected.calls.at(-1)).toBe('discard')
  })

  test('default profiles and empty extra args keep their original omission semantics', async () => {
    const selected = selectedSmoke()
    await runPreparedRuntimeSmoke({ ...selected.options, extraArgs: [] })
    expect(selected.state.intent?.resolvedProfiles).toEqual([
      [
        'aw-smoke',
        {
          model: null,
          variant: null,
          temperature: null,
          steps: null,
          maxSteps: null,
          isSandbox: false,
        },
      ],
    ])
    expect(selected.state.intent).not.toHaveProperty('extraArgs')
  })

  test('an event and session without the actual prompt nonce remain nonconforming', async () => {
    const selected = selectedSmoke()
    selected.state.eventFactory = () => [
      JSON.stringify({
        kind: 'text',
        text: '<workflow-output>wrong nonce</workflow-output>',
        sessionId: 'selected:session',
        rawLine: 'selected event',
      }),
    ]
    expect(await runPreparedRuntimeSmoke(selected.options)).toMatchObject({
      outcome: 'stream-nonconforming',
      conforms: false,
      sawNonce: false,
      sawEnvelope: true,
    })
    expect(selected.calls.at(-1)).toBe('discard')
  })

  test('network classification still precedes the overlapping stdout authentication wording', async () => {
    const selected = selectedSmoke()
    selected.state.eventFactory = () => [
      JSON.stringify({
        type: 'result',
        is_error: true,
        result: 'Failed to authenticate. API Error: 403 Request not allowed',
      }),
    ]
    selected.state.result = { ...selected.state.result, outcome: 'nonzero-exit', exitCode: 1 }
    expect(await runPreparedRuntimeSmoke(selected.options)).toMatchObject({
      outcome: 'network-blocked',
      conforms: false,
    })
  })

  test('a pending conversation reset never reports a completed protocol turn', async () => {
    const selected = selectedSmoke()
    selected.state.eventFactory = (intent) => [
      JSON.stringify({
        kind: 'text',
        text: intent.prompt.match(/awsmoke-[0-9a-f]{16}/)![0],
        sessionId: 'selected:session',
        conversationReset: {
          outgoingSessionId: 'selected:session',
          newConversationId: 'selected:next',
        },
        rawLine: 'selected event',
      }),
    ]
    expect(await runPreparedRuntimeSmoke(selected.options)).toMatchObject({
      outcome: 'stream-nonconforming',
      conforms: false,
      sawNonce: true,
    })
  })
})

// The whole original core appends this operator hint only when model was omitted.
describe('RFC-370 selected smoke model diagnostic', () => {
  for (const model of [undefined, 'provider/configured-model'] as const) {
    test(`${model ?? 'omitted model'}: preserve the original default-model failure hint`, async () => {
      const selected = selectedSmoke()
      selected.state.eventFactory = () => []
      selected.state.stderr = 'model selected not found'
      const result = await runPreparedRuntimeSmoke({ ...selected.options, model })
      expect(result.outcome).toBe('model-call-failed')
      expect(result.conforms).toBe(false)
      if (model === undefined) {
        expect(result.detail).toContain('no --model was passed (runtime model field is empty)')
      } else {
        expect(result.detail).not.toContain('no --model was passed')
      }
      expect(selected.calls).toEqual([
        'prepare',
        'compile',
        'bind',
        'bind-execution',
        'submit',
        'before-start',
        'cleanup',
        'discard',
      ])
    })
  }
})
