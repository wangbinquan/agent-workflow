// RFC-370: remote staging completion must preserve each original cleanup boundary.
import { describe, expect, test } from 'bun:test'
import { composeSelectedDevelopmentPipelineEvidence } from '@/modules/development-automation/composition/pipelineEvidence'
import { createSelectedApprovalExecutionAdapter } from '@/modules/integration/application/developmentApprovalAdapter'
import type { DevelopmentAdapterContent } from '@/modules/integration/domain/developmentAdapterDefinition'
import type {
  AdapterConfigurationReference,
  SelectedPipelineEvidenceExecution,
} from '@/modules/integration/public/participants'
import {
  held,
  MemoryPurposeContent,
  PurposeEffects,
  unusedPurposeEffect,
} from './helpers/developmentPurpose'

const headSha = 'a'.repeat(40),
  targetSha = 'b'.repeat(40)
const failure = {
  category: 'transient' as const,
  code: 'provider-unavailable',
  retryability: 'same-input' as const,
  attemptOrdinal: 0,
  remediation: 'retry',
  evidenceRef: null,
}
const pipelineInput = {
  adapterBindingRef: 'pipeline@1',
  headSha,
  targetSha,
  gateKeys: ['unit'],
  idempotencyKey: 'request',
}

describe('RFC-370 selected staging lifecycle', () => {
  for (const kind of ['trigger', 'rerun'] as const) {
    for (const outcome of ['success', 'closed-failure', 'raw-error'] as const) {
      test(`${kind} waits for allocation and original finally close before ${outcome}`, async () => {
        const content = new MemoryPurposeContent(),
          rawError = new Error('original selected effect')
        const createEntered = held<void>(),
          createAck = held<void>(),
          closeEntered = held<void>(),
          closeAck = held<void>()
        content.before = (operation) => {
          if (operation === 'create') {
            createEntered.resolve()
            return createAck.promise
          }
          if (operation === 'close') {
            closeEntered.resolve()
            return closeAck.promise
          }
        }
        let called = 0
        const execute = (input: { readonly staging: Parameters<typeof content.stage>[0] }) => {
          called++
          expect(content.stage(input.staging).closed).toBe(false)
          if (outcome === 'raw-error') throw rawError
          return outcome === 'closed-failure' ? { ok: false as const, failure } : null
        }
        const runner: SelectedPipelineEvidenceExecution = {
          collect: unusedPurposeEffect,
          async trigger(input) {
            const result = execute(input)
            return (
              result ?? {
                ok: true,
                envelope: {
                  protocol: 'aw-adapter@1',
                  operation: 'pipeline.trigger',
                  providerReceiptRef: 'trigger',
                  runRef: 'run1',
                  headSha,
                  adopted: true,
                },
              }
            )
          },
          async rerun(input) {
            const result = execute(input)
            return (
              result ?? {
                ok: true,
                envelope: {
                  protocol: 'aw-adapter@1',
                  operation: 'pipeline.rerun',
                  providerReceiptRef: 'rerun',
                  runRef: 'run1',
                  headSha,
                  attempt: 2,
                },
              }
            )
          },
        }
        const port = composeSelectedDevelopmentPipelineEvidence(runner, {
          collect: content.staging,
          trigger: content.staging,
          rerun: content.staging,
        }).pipelineEvidence
        let settled = false
        const pending = (
          kind === 'trigger'
            ? port.trigger(pipelineInput)
            : port.rerun({ ...pipelineInput, runRef: 'run1', gateKey: 'unit' })
        )
          .then(
            (value) => ({ ok: true as const, value }),
            (error) => ({ ok: false as const, error }),
          )
          .finally(() => {
            settled = true
          })
        try {
          await createEntered.promise
          expect(called).toBe(0)
          expect(settled).toBe(false)
          createAck.resolve()
          await Promise.race([
            closeEntered.promise,
            pending.then(() => {
              throw new Error('operation ended before close')
            }),
          ])
          expect(called).toBe(1)
          expect(settled).toBe(false)
          expect([...content.stages.values()][0]!.closed).toBe(false)
        } finally {
          createAck.resolve()
          closeAck.resolve()
        }
        const result = await pending
        expect([...content.stages.values()][0]!.closed).toBe(true)
        if (outcome === 'raw-error') expect(result).toEqual({ ok: false, error: rawError })
        else if (outcome === 'closed-failure')
          expect(result).toEqual({ ok: true, value: { ok: false, failure } })
        else
          expect(result).toMatchObject({
            ok: true,
            value: { ok: true, runRef: 'run1', providerReceiptRef: kind },
          })
      })
    }
  }

  test('collect preserves its original raw throw boundary and waits for closed failure cleanup', async () => {
    const content = new MemoryPurposeContent(),
      rawError = new Error('collect raw failure')
    const runner: SelectedPipelineEvidenceExecution = {
      collect: async () => {
        throw rawError
      },
      trigger: unusedPurposeEffect,
      rerun: unusedPurposeEffect,
    }
    const port = composeSelectedDevelopmentPipelineEvidence(runner, {
      collect: content.staging,
      trigger: content.staging,
      rerun: content.staging,
    }).pipelineEvidence
    await expect(port.collect(pipelineInput)).rejects.toBe(rawError)
    expect(content.calls).toEqual(['create'])
    expect([...content.stages.values()][0]!.closed).toBe(false)
    const entered = held<void>(),
      ack = held<void>()
    runner.collect = async () => ({ ok: false, failure })
    content.before = (operation) => {
      if (operation === 'close') {
        entered.resolve()
        return ack.promise
      }
    }
    let settled = false
    const pending = port.collect(pipelineInput).finally(() => {
      settled = true
    })
    try {
      await entered.promise
      expect(settled).toBe(false)
      expect([...content.stages.values()][1]!.closed).toBe(false)
    } finally {
      ack.resolve()
    }
    expect(await pending).toEqual({ ok: false, failure })
    expect([...content.stages.values()][1]!.closed).toBe(true)
  })

  test('approval resolves before staging, retains raw configuration error identity and waits for finally close', async () => {
    const content = new MemoryPurposeContent(),
      rawError = new Error('configuration binding failed')
    const effects = new PurposeEffects(content.namespace, { bind: unusedPurposeEffect })
    const definition: DevelopmentAdapterContent = {
      schemaVersion: 1,
      purpose: 'approval-gateway',
      operations: ['submit', 'lookup-by-idempotency-key', 'observe'],
      contractVersion: 1,
      executableRef: 'object:program',
      parameterSchemaRef: null,
      connectionRef: null,
      secretProjection: [],
      outputBudget: { maxFiles: 1, maxFileBytes: 1024, maxTotalBytes: 1024 },
      timeoutMs: 1000,
    }
    let resolved: DevelopmentAdapterContent | null = null
    const binding = {
      effects,
      staging: content.staging,
      configurationFor(): AdapterConfigurationReference {
        throw rawError
      },
    }
    const adapter = createSelectedApprovalExecutionAdapter({
      resolveBinding: () => resolved,
      binding,
    })
    const input = { adapterBindingRef: 'approval@1', idempotencyKey: 'request' }
    expect(await adapter.lookup(input)).toMatchObject({
      ok: false,
      failure: { code: 'approval-adapter-lookup-unavailable' },
    })
    expect(content.calls).toEqual([])
    resolved = definition
    const entered = held<void>(),
      ack = held<void>()
    content.before = (operation) => {
      if (operation === 'close') {
        entered.resolve()
        return ack.promise
      }
    }
    let settled = false
    const pending = adapter
      .lookup(input)
      .then(
        () => null,
        (error) => error,
      )
      .finally(() => {
        settled = true
      })
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error('approval ended before close')
        }),
      ])
      expect(settled).toBe(false)
      expect([...content.stages.values()][0]!.closed).toBe(false)
    } finally {
      ack.resolve()
    }
    expect(await pending).toBe(rawError)
    expect([...content.stages.values()][0]!.closed).toBe(true)
  })
})
