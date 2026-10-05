// RFC-370 A-T5: the actual shared System core consumes the selected material,
// receipt and evidence family. Its original result and cleanup policies also
// serve the native compatibility entry; these cases lock the neutral branch.
import { describe, expect, test } from 'bun:test'
import { runPreparedSystemAgent } from '../src/modules/task-execution/composition/systemAgentRun'
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
  SystemAgentEventSinkV1,
} from '../src/modules/runtime-management/public/participants'
import { emptyDeclaredManifest } from '../src/services/execution/agentInjection'
import { createLogger } from '../src/util/log'

function unused(): never {
  throw new Error('unselected System capability was read')
}

function selectedRun() {
  const calls: string[] = []
  const state = {
    prepareError: undefined as Error | undefined,
    compileError: undefined as Error | undefined,
    bindError: undefined as Error | undefined,
    acknowledgeError: undefined as Error | undefined,
    cleanupError: undefined as Error | undefined,
    discardError: undefined as Error | undefined,
    result: {
      executionRef: 'selected:execution',
      outcome: 'ok',
      exitCode: 0,
      rawStdout: '',
      stderrTail: '',
      durationMs: 1,
    } as ExecutionEffectResult,
    preparedSeeds: undefined as Parameters<AgentMaterialWorkspace['prepare']>[0],
    submitted: undefined as ExecutionEffectRequest | undefined,
    warnings: [] as { message: string; fields: unknown }[],
  }
  const workspace: AgentMaterialWorkspace = {
    workspace: { owner: 'source-control', reference: 'selected:working', version: 7 },
    runContent: { owner: 'runtime-management', reference: 'selected:run', version: 2 },
    retainedRef: 'selected:retained-content',
    prepare(seeds) {
      expect(this).toBe(workspace)
      calls.push('prepare')
      state.preparedSeeds = seeds
      if (state.prepareError !== undefined) throw state.prepareError
    },
    discard() {
      expect(this).toBe(workspace)
      calls.push('discard')
      if (state.discardError !== undefined) throw state.discardError
    },
  }
  const log = {
    ...createLogger('selected-system-test'),
    warn(message: string, fields?: Record<string, unknown>) {
      state.warnings.push({ message, fields })
    },
  }
  const intent: AgentMaterialIntent = {
    protocol: 'opencode',
    injection: { mcps: [] },
    prompt: '原最终 prompt\0',
    agentName: 'selected-persona',
    systemPrompt: 'original persona',
    resolvedProfiles: [],
    workspace: workspace.workspace,
    runContent: workspace.runContent,
    freshAgentRun: false,
    nodeRunId: 'selected-system-node',
    log,
  }
  const material: PreparedAgentMaterial = {
    materialRef: 'selected:material',
    declared: emptyDeclaredManifest(),
    evidenceCapabilities: {
      usageNormalizer: false,
      nativeUsageCapture: false,
      spanCapture: false,
      sessionCapture: true,
      inventory: false,
      finalEvents: false,
      liveCapture: false,
      sessionSinkCapture: true,
    },
  }
  const binding: AgentInvocationBinding = {
    materialRef: material.materialRef,
    declared: material.declared,
    workspace,
    protocol: {
      kind: 'opencode',
      get capabilities() {
        return unused()
      },
      parseEvent(line) {
        calls.push('parse')
        return {
          kind: 'text',
          text: '已选中的回答',
          rawLine: line,
          sessionId: 'selected:native-session',
        }
      },
    },
    evidence: {
      captureSessions: unused,
      async captureSessionsToSink(input) {
        expect(input.rootSessionId).toBe('selected:native-session')
        calls.push('child-capture')
        return { failed: false }
      },
    },
    lifecycle: {
      beforeStart() {
        calls.push('before-start')
      },
      cleanup() {
        expect(this).toBe(binding.lifecycle)
        calls.push('cleanup')
        if (state.cleanupError !== undefined) throw state.cleanupError
      },
    },
    bindExecution() {
      expect(this).toBe(binding)
      calls.push('bind-execution')
      const execution: AgentExecutionBinding = {
        executionRef: 'selected:execution',
        materialRef: material.materialRef,
        workspaceRef: workspace.workspace.reference,
        effect: {
          async submit(request: ExecutionEffectRequest) {
            calls.push('submit')
            state.submitted = request
            await request.beforeStart?.()
            try {
              await request.onStarted?.({
                executionRef: execution.executionRef,
                startedAt: 17,
              })
            } catch {
              return { ...state.result, outcome: 'spawn-failed' as const }
            }
            try {
              await request.capture?.onStdoutLine?.('original streamed event')
            } catch (error) {
              return { ...state.result, pumpError: (error as Error).message }
            }
            return state.result
          },
        },
        acknowledgeOwner() {
          expect(this).toBe(execution)
          calls.push('acknowledge')
          if (state.acknowledgeError !== undefined) throw state.acknowledgeError
        },
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
      expect(actual).toBe(intent)
      calls.push('compile')
      if (state.compileError !== undefined) throw state.compileError
      return material
    },
  }
  const preparation = createAgentInvocationPreparation({
    compiler,
    workspace,
    bind(actual) {
      expect(actual).toBe(material)
      calls.push('bind')
      if (state.bindError !== undefined) throw state.bindError
      return binding
    },
    cleanupMaterial(actual) {
      expect(actual).toBe(material)
      calls.push('unbound-cleanup')
    },
  })
  const sink: SystemAgentEventSinkV1 = {
    async append() {
      calls.push('append')
    },
    async setRootSessionId() {
      calls.push('set-root')
    },
    async markTerminal(state, reason) {
      calls.push(`terminal:${state}:${reason ?? ''}`)
    },
  }
  return {
    calls,
    state,
    workspace,
    intent,
    material,
    sink,
    options: { feature: 'selected-system', preparation, intent, log },
  }
}

describe('RFC-370 selected System common core', () => {
  test('one selected material runs with an opaque retained reference and capture precedes cleanup', async () => {
    const run = selectedRun()
    const seeds = [{ path: 'PERSONA.md', content: '原始 seed\0' }]
    const result = await runPreparedSystemAgent({
      ...run.options,
      seedFiles: seeds,
      eventSink: run.sink,
      timeoutMs: 319,
      maxEventTextBytes: 4096,
    })
    expect(run.state.preparedSeeds).toBe(seeds)
    expect(result.status).toBe('ok')
    expect(result.eventText).toBe('已选中的回答')
    expect(result.capturedSessionId).toBe('selected:native-session')
    expect(result.retainedRef).toBe(run.workspace.retainedRef)
    expect(result.scratchRetained).toBe(false)
    expect(result.declared).toBe(run.material.declared)
    expect(result).not.toHaveProperty('scratchDir')
    expect(run.state.submitted).toMatchObject({
      executionRef: 'selected:execution',
      materialRef: 'selected:material',
      workspaceRef: 'selected:working',
      timeoutMs: 319,
      termGraceMs: 2000,
    })
    expect(run.state.submitted).not.toHaveProperty('cmd')
    expect(run.state.submitted).not.toHaveProperty('cwd')
    expect(run.calls).toEqual([
      'prepare',
      'compile',
      'bind',
      'bind-execution',
      'submit',
      'before-start',
      'acknowledge',
      'parse',
      'set-root',
      'append',
      'child-capture',
      'terminal:complete:',
      'cleanup',
      'discard',
    ])
  })

  test('workspace failure discards before any compilation and keeps the original early result', async () => {
    const run = selectedRun()
    run.state.prepareError = new Error('selected preparation failed')
    const result = await runPreparedSystemAgent({ ...run.options, eventSink: run.sink })
    expect(result.status).toBe('spawn-failed')
    expect(result.stderrTail).toBe('scratch setup failed: selected preparation failed')
    expect(result.retainedRef).toBe(run.workspace.retainedRef)
    expect(result.scratchRetained).toBe(false)
    expect(result).not.toHaveProperty('declared')
    expect(run.calls).toEqual(['prepare', 'discard'])
  })

  test('compile failure uses the original prepare classification without fallback or target cleanup', async () => {
    const run = selectedRun()
    run.state.compileError = new Error('selected material rejected')
    const result = await runPreparedSystemAgent({ ...run.options, eventSink: run.sink })
    expect(result.status).toBe('spawn-failed')
    expect(result.stderrTail).toBe('failed to prepare spawn: selected material rejected')
    expect(result.scratchRetained).toBe(true)
    expect(result).not.toHaveProperty('declared')
    expect(run.calls).toEqual(['prepare', 'compile', 'terminal:complete:'])
  })

  test('late bind errors propagate after the original terminal barrier and exact material cleanup', async () => {
    const run = selectedRun()
    const original = new Error('selected binding rejected')
    run.state.bindError = original
    await expect(runPreparedSystemAgent({ ...run.options, eventSink: run.sink })).rejects.toBe(
      original,
    )
    expect(run.calls).toEqual([
      'prepare',
      'compile',
      'bind',
      'terminal:complete:',
      'unbound-cleanup',
    ])
  })

  test('receipt rejection retains the original spawn failure and admits no output', async () => {
    const run = selectedRun()
    run.state.acknowledgeError = new Error('selected owner receipt rejected')
    const result = await runPreparedSystemAgent({ ...run.options, eventSink: run.sink })
    expect(result.status).toBe('spawn-failed')
    expect(result.stderrTail).toBe('binary failed to start: selected owner receipt rejected')
    expect(result.eventText).toBe('')
    expect(result.scratchRetained).toBe(true)
    expect(run.calls).toEqual([
      'prepare',
      'compile',
      'bind',
      'bind-execution',
      'submit',
      'before-start',
      'acknowledge',
      'terminal:complete:',
      'cleanup',
    ])
  })

  test('auxiliary sink rejection preserves business output and closes incomplete before cleanup', async () => {
    const run = selectedRun()
    run.sink.append = async () => {
      run.calls.push('append-failed')
      throw new Error('selected observation store unavailable')
    }
    const result = await runPreparedSystemAgent({ ...run.options, eventSink: run.sink })
    expect(result.status).toBe('ok')
    expect(result.eventText).toBe('已选中的回答')
    expect(result.scratchRetained).toBe(false)
    expect(run.calls.slice(-4)).toEqual([
      'append-failed',
      'terminal:incomplete:stream-persist-failed',
      'cleanup',
      'discard',
    ])
    expect(run.calls).not.toContain('child-capture')
  })

  test('authoritative root rejection remains a failed run and retains its diagnostic content', async () => {
    const run = selectedRun()
    run.sink.setRootSessionId = async () => {
      run.calls.push('root-rejected')
      throw new Error('selected root claim rejected')
    }
    const result = await runPreparedSystemAgent({
      ...run.options,
      eventSink: run.sink,
      nativeIdentityAuthoritative: true,
    })
    expect(result.status).toBe('exit-nonzero')
    expect(result.nativeSessionIntegrityFailed).toBe(true)
    expect(result.stderrTail).toBe('runtime native session claim failed')
    expect(result.scratchRetained).toBe(true)
    expect(run.calls.slice(-3)).toEqual([
      'root-rejected',
      'terminal:incomplete:stream-persist-failed',
      'cleanup',
    ])
    expect(run.calls).not.toContain('child-capture')
    expect(run.calls).not.toContain('discard')
  })

  test('terminal persistence is retried before the single cleanup and workspace disposal', async () => {
    const run = selectedRun()
    let attempts = 0
    run.sink.markTerminal = async () => {
      attempts++
      run.calls.push(`terminal-attempt:${attempts}`)
      if (attempts === 1) throw new Error('first terminal persistence rejected')
    }
    const result = await runPreparedSystemAgent({ ...run.options, eventSink: run.sink })
    expect(result.status).toBe('ok')
    expect(run.calls.slice(-4)).toEqual([
      'terminal-attempt:1',
      'terminal-attempt:2',
      'cleanup',
      'discard',
    ])
    expect(attempts).toBe(2)
  })

  test('unreaped execution never disposes selected material or its workspace', async () => {
    const run = selectedRun()
    run.state.result = { ...run.state.result, outcome: 'unreaped', exitCode: null }
    const result = await runPreparedSystemAgent({ ...run.options, eventSink: run.sink })
    expect(result.status).toBe('unreaped')
    expect(result.scratchRetained).toBe(true)
    expect(run.calls.at(-1)).toBe('terminal:incomplete:post-exit-flush-timeout')
    expect(run.calls).not.toContain('child-capture')
    expect(run.calls).not.toContain('cleanup')
    expect(run.calls).not.toContain('unbound-cleanup')
    expect(run.calls).not.toContain('discard')
  })

  test('cleanup failure keeps the original failed result and skips workspace disposal', async () => {
    const run = selectedRun()
    run.state.cleanupError = new Error('selected cleanup rejected')
    const result = await runPreparedSystemAgent(run.options)
    expect(result.status).toBe('spawn-failed')
    expect(result.stderrTail).toBe('runtime cleanup failed')
    expect(result.scratchRetained).toBe(true)
    expect(run.calls.at(-1)).toBe('cleanup')
    expect(run.calls).not.toContain('unbound-cleanup')
    expect(run.calls).not.toContain('discard')
  })

  test('success with failed disposal reports only the owner retained reference', async () => {
    const run = selectedRun()
    run.state.discardError = new Error('selected workspace disposal rejected')
    const result = await runPreparedSystemAgent(run.options)
    expect(result.status).toBe('ok')
    expect(result.scratchRetained).toBe(true)
    expect(run.state.warnings).toEqual([
      {
        message: 'system-agent-scratch-retained',
        fields: { feature: 'selected-system', retainedRef: run.workspace.retainedRef },
      },
    ])
  })

  test.each([
    ['aborted', 'aborted', 0],
    ['timeout', 'timeout', 0],
    ['nonzero-exit', 'exit-nonzero', 7],
  ] as const)(
    '%s retains its original result classification and content',
    async (outcome, status, exitCode) => {
      const run = selectedRun()
      run.state.result = { ...run.state.result, outcome, exitCode }
      const result = await runPreparedSystemAgent(run.options)
      expect(result.status).toBe(status)
      expect(result.exitCode).toBe(exitCode)
      expect(result.eventText).toBe('已选中的回答')
      expect(result.scratchRetained).toBe(true)
      expect(run.calls.at(-1)).toBe('cleanup')
      expect(run.calls).not.toContain('discard')
    },
  )
})
