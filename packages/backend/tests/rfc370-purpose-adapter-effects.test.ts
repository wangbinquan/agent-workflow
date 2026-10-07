import { describe, expect, test } from 'bun:test'
import * as runner from '@/modules/integration/application/developmentAdapterRunner'
import * as legacy from '@/modules/integration/infrastructure/developmentAdapterRunner'
import type { DevelopmentAdapterOperation } from '@/modules/integration/application/developmentAdapterOperation'
import type {
  AdapterConfigurationReference,
  AdapterProgramFactory,
  AdapterProgramReference,
} from '@/modules/integration/public/participants'
import { held, MemoryPurposeContent, PurposeEffects } from './helpers/developmentPurpose'

const head = 'a'.repeat(40),
  target = 'b'.repeat(40),
  intent = 'd'.repeat(64)
const receipt = {
  intentDigest: intent,
  correlationRef: 'correlation',
  externalRequestRef: 'request',
  submittedRevision: 'r1',
  submittedAt: '2026-10-07T00:00:00+00:00',
}
const samples: readonly {
  readonly operation: DevelopmentAdapterOperation
  readonly envelope: object
}[] = [
  {
    operation: { kind: 'acquire', externalId: 'ext' },
    envelope: {
      protocol: 'aw-adapter@1',
      operation: 'acquire',
      sourceRevision: 'r1',
      title: 'Requirement',
      files: [],
    },
  },
  {
    operation: {
      kind: 'questions.writeback',
      externalId: 'ext',
      questionsJson: '{"questions":[]}',
    },
    envelope: {
      protocol: 'aw-adapter@1',
      operation: 'questions.writeback',
      correlationRef: 'questions',
    },
  },
  {
    operation: { kind: 'answers.collect', externalId: 'ext', correlationRef: 'questions' },
    envelope: {
      protocol: 'aw-adapter@1',
      operation: 'answers.collect',
      complete: true,
      answerRevision: 'r2',
      answers: [{ questionId: 'q1', answer: 'yes' }],
    },
  },
  {
    operation: {
      kind: 'pipeline.collect',
      headSha: head,
      targetSha: target,
      gateKeysCsv: 'unit,integration',
    },
    envelope: {
      protocol: 'aw-adapter@1',
      operation: 'pipeline.collect',
      providerKey: 'provider',
      providerHeadSha: head,
      targetSha: target,
      completeness: 'complete',
      gates: [],
      redaction: 'complete',
    },
  },
  {
    operation: {
      kind: 'pipeline.trigger',
      headSha: head,
      gateKeysCsv: 'unit',
      idempotencyKey: 'trigger',
    },
    envelope: {
      protocol: 'aw-adapter@1',
      operation: 'pipeline.trigger',
      providerReceiptRef: 'provider-trigger',
      runRef: 'run1',
      headSha: head,
      adopted: true,
    },
  },
  {
    operation: {
      kind: 'pipeline.rerun',
      runRef: 'run1',
      gateKey: 'unit',
      headSha: head,
      idempotencyKey: 'rerun',
    },
    envelope: {
      protocol: 'aw-adapter@1',
      operation: 'pipeline.rerun',
      providerReceiptRef: 'provider-rerun',
      runRef: 'run1',
      attempt: 2,
      headSha: head,
    },
  },
  {
    operation: {
      kind: 'approval.submit',
      stepRunRef: 'step',
      draftRef: 'draft',
      deadlineAt: '2026-10-08T00:00:00+00:00',
      idempotencyKey: 'submit',
      intentDigest: intent,
    },
    envelope: { protocol: 'aw-adapter@1', operation: 'approval.submit', ...receipt },
  },
  {
    operation: { kind: 'approval.lookup', idempotencyKey: 'submit' },
    envelope: { protocol: 'aw-adapter@1', operation: 'approval.lookup', found: true, ...receipt },
  },
  {
    operation: { kind: 'approval.observe', correlationRef: 'correlation' },
    envelope: {
      protocol: 'aw-adapter@1',
      operation: 'approval.observe',
      correlationRef: 'correlation',
      observedRevision: 'r2',
      status: 'approved',
      evidenceRef: 'evidence:r2',
      observedAt: '2026-10-07T01:00:00+00:00',
    },
  },
]

function invoke(input: runner.AdapterRunInput) {
  const operation = input.operation
  switch (operation.kind) {
    case 'acquire':
      return runner.runRequirementAcquire({ ...input, operation })
    case 'questions.writeback':
      return runner.runQuestionsWriteback({ ...input, operation })
    case 'answers.collect':
      return runner.runAnswersCollect({ ...input, operation })
    case 'pipeline.collect':
      return runner.runPipelineCollect({ ...input, operation })
    case 'pipeline.trigger':
      return runner.runPipelineTrigger({ ...input, operation })
    case 'pipeline.rerun':
      return runner.runPipelineRerun({ ...input, operation })
    case 'approval.submit':
      return runner.runApprovalSubmit({ ...input, operation })
    case 'approval.lookup':
      return runner.runApprovalLookup({ ...input, operation })
    case 'approval.observe':
      return runner.runApprovalObserve({ ...input, operation })
  }
}

describe('RFC-370 selected nine operation effects', () => {
  for (const sample of samples) {
    for (const binding of ['sync', 'async'] as const) {
      test(`${sample.operation.kind} keeps program/effect receivers and waits for ${binding} binding and execution ACK`, async () => {
        const content = new MemoryPurposeContent()
        const allocation = content.staging.create()
        const stage = 'then' in allocation ? await allocation : allocation
        const configuration: AdapterConfigurationReference = {
          kind: 'development-adapter-configuration',
          reference: {},
        }
        const program: AdapterProgramReference = {
          kind: 'development-adapter-program',
          reference: {},
        }
        const bindEntered = held<void>(),
          bindAck = held<void>(),
          executeEntered = held<void>(),
          executeAck = held<void>()
        const programs: AdapterProgramFactory = {
          bind(received) {
            expect(this).toBe(programs)
            expect(received).toBe(configuration)
            bindEntered.resolve()
            const result = { ok: true as const, program }
            return binding === 'sync' ? result : bindAck.promise.then(() => result)
          },
        }
        const effects = new PurposeEffects(content.namespace, programs)
        effects.observeOperation = async (_kind, input) => {
          expect(input.program).toBe(program)
          expect(input.staging).toBe(stage.reference)
          executeEntered.resolve()
          await executeAck.promise
          return {
            kind: 'completed',
            stdout: 'provider diagnostic\n' + JSON.stringify(sample.envelope) + '\n',
            exitCode: 0,
          }
        }
        let settled = false
        const pending = invoke({
          configuration,
          staging: stage.reference,
          effects,
          operation: sample.operation,
        }).finally(() => {
          settled = true
        })
        try {
          await bindEntered.promise
          expect(settled).toBe(false)
          if (binding === 'async') expect(effects.calls).toHaveLength(0)
          bindAck.resolve()
          await executeEntered.promise
          expect(settled).toBe(false)
          expect(effects.calls).toHaveLength(1)
          const { kind: _kind, ...business } = sample.operation
          expect(effects.calls[0]).toEqual({
            kind: sample.operation.kind,
            input: { ...business, program, staging: stage.reference },
          })
        } finally {
          bindAck.resolve()
          executeAck.resolve()
        }
        expect(await pending).toEqual({ ok: true, envelope: sample.envelope })
      })
    }
  }

  test('raw preparation and execution errors propagate unchanged; incomplete family and foreign stage do not bind', async () => {
    const content = new MemoryPurposeContent()
    const allocation = content.staging.create(),
      stage = 'then' in allocation ? await allocation : allocation
    const configuration: AdapterConfigurationReference = {
      kind: 'development-adapter-configuration',
      reference: {},
    }
    const failure = new Error('selected program transport failed')
    let bound = 0
    const effects = new PurposeEffects(content.namespace, {
      bind() {
        bound++
        throw failure
      },
    })
    const input = {
      configuration,
      staging: stage.reference,
      effects,
      operation: samples[0]!.operation,
    }
    await expect(invoke(input)).rejects.toBe(failure)
    expect(bound).toBe(1)
    const incomplete = Object.create(effects) as PurposeEffects
    Object.defineProperty(incomplete, 'answersCollect', { value: undefined })
    await expect(invoke({ ...input, effects: incomplete })).rejects.toThrow(
      'development-adapter-purpose-incomplete:answersCollect',
    )
    await expect(
      invoke({
        ...input,
        staging: {
          ...stage.reference,
          namespace: { kind: 'evidence-staging-namespace', reference: {} },
        },
      }),
    ).rejects.toThrow('development-adapter-staging-namespace-mismatch')
    expect(bound).toBe(1)
    const program: AdapterProgramReference = { kind: 'development-adapter-program', reference: {} }
    effects.programs.bind = async () => {
      throw failure
    }
    await expect(invoke(input)).rejects.toBe(failure)
    effects.programs.bind = () => ({ ok: true, program })
    effects.observeOperation = async () => {
      throw failure
    }
    await expect(invoke(input)).rejects.toBe(failure)
  })

  test('selected terminal observations retain the original closed result vocabulary and last-line policy', async () => {
    const content = new MemoryPurposeContent()
    const allocation = content.staging.create(),
      stage = 'then' in allocation ? await allocation : allocation
    const effects = new PurposeEffects(content.namespace, {
      bind: () => ({ ok: true, program: { kind: 'development-adapter-program', reference: {} } }),
    })
    const input = {
      configuration: { kind: 'development-adapter-configuration' as const, reference: {} },
      staging: stage.reference,
      effects,
      operation: samples[0]!.operation,
    }
    for (const [observation, code, category, retryability] of [
      [{ kind: 'expired' }, 'adapter-timeout', 'transient', 'same-input'],
      [
        { kind: 'unavailable' },
        'adapter-executable-unavailable',
        'configuration',
        'after-configuration',
      ],
      [{ kind: 'completed', stdout: '', exitCode: 5 }, 'adapter-exit-5', 'transient', 'same-input'],
      [
        { kind: 'completed', stdout: '', exitCode: 6 },
        'adapter-exit-6',
        'stale-input',
        'after-refresh',
      ],
      [
        { kind: 'completed', stdout: '', exitCode: 2 },
        'adapter-exit-2',
        'configuration',
        'after-configuration',
      ],
      [
        { kind: 'completed', stdout: '', exitCode: 4 },
        'adapter-exit-4',
        'business-failure',
        'never',
      ],
      [
        { kind: 'completed', stdout: '', exitCode: 0 },
        'adapter-envelope-missing',
        'contract-violation',
        'never',
      ],
      [
        { kind: 'completed', stdout: 'provider log\nno json', exitCode: 0 },
        'adapter-envelope-not-json',
        'contract-violation',
        'never',
      ],
    ] as const) {
      effects.observeOperation = async () => observation
      expect(await invoke(input)).toMatchObject({
        ok: false,
        failure: { code, category, retryability, attemptOrdinal: 0, evidenceRef: null },
      })
    }
  })
})

// SOURCE60-R1 found legacy Promise rejection and native getter timing regressions.
// All these inputs stop before native spawn; the original result policy is the oracle.
describe('RFC-370 legacy native adapter input behavior', () => {
  const adapterContent = {
    executableRef: 'unused-native-adapter',
    timeoutMs: 100,
    connectionRef: null,
    secretProjection: [],
  }

  test('all nine existing APIs return a rejected Promise when reading operation fails', async () => {
    for (const run of [
      legacy.runRequirementAcquire,
      legacy.runQuestionsWriteback,
      legacy.runAnswersCollect,
      legacy.runPipelineCollect,
      legacy.runPipelineTrigger,
      legacy.runPipelineRerun,
      legacy.runApprovalSubmit,
      legacy.runApprovalLookup,
      legacy.runApprovalObserve,
    ]) {
      const failure = new Error('legacy-operation-getter')
      const input = {
        adapterContent,
        stagedRoot: 'unused-native-stage',
        get operation(): never {
          expect(this).toBe(input)
          throw failure
        },
      }
      let result: Promise<unknown> | undefined
      expect(() => {
        result = run(input)
      }).not.toThrow()
      expect(result).toBeInstanceOf(Promise)
      await expect(result!).rejects.toBe(failure)
    }
  })

  test('executable input is read before staging and preserves its original Error', async () => {
    const executableFailure = new Error('legacy-executable-getter')
    const stagingFailure = new Error('legacy-stage-getter')
    let stagingReads = 0
    const input = {
      adapterContent: {
        ...adapterContent,
        get executableRef(): string {
          throw executableFailure
        },
      },
      operation: { kind: 'acquire' as const, externalId: 'ext' },
      get stagedRoot(): string {
        expect(this).toBe(input)
        stagingReads += 1
        throw stagingFailure
      },
    }
    await expect(legacy.runRequirementAcquire(input)).rejects.toBe(executableFailure)
    expect(stagingReads).toBe(0)
  })

  test('the first staging read still propagates its original raw Error', async () => {
    const failure = new Error('legacy-first-stage-getter')
    let stagingReads = 0
    const input = {
      adapterContent,
      operation: { kind: 'acquire' as const, externalId: 'ext' },
      get stagedRoot(): string {
        expect(this).toBe(input)
        stagingReads += 1
        throw failure
      },
    }
    await expect(legacy.runRequirementAcquire(input)).rejects.toBe(failure)
    expect(stagingReads).toBe(1)
  })

  test('the second staging read remains inside the original native launch catch', async () => {
    const failure = new Error('legacy-second-stage-getter')
    let stagingReads = 0
    const input = {
      adapterContent,
      operation: { kind: 'acquire' as const, externalId: 'ext' },
      get stagedRoot(): string {
        expect(this).toBe(input)
        stagingReads += 1
        if (stagingReads === 2) throw failure
        return 'unused-native-stage'
      },
    }
    await expect(legacy.runRequirementAcquire(input)).resolves.toEqual({
      ok: false,
      failure: {
        category: 'configuration',
        code: 'adapter-executable-unavailable',
        retryability: 'after-configuration',
        attemptOrdinal: 0,
        remediation: 'fix the adapter executableRef',
        evidenceRef: null,
      },
    })
    expect(stagingReads).toBe(2)
  })
})
