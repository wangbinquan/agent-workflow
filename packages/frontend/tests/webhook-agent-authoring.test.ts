import { describe, expect, test } from 'vitest'
import type { Agent } from '@agent-workflow/shared'
import {
  repairWebhookAgentPayload,
  resolveWebhookAgentShape,
  webhookAgentShapeError,
  type AgentTargetPayloadDraft,
} from '../src/components/webhooks/webhookAgentAuthoring'

const empty: AgentTargetPayloadDraft = {
  description: '',
  descriptionPresent: false,
  inputs: {},
  inputsPresent: false,
}

function agent(inputs: Agent['inputs']): Pick<Agent, 'inputs'> {
  return { inputs }
}

describe('RFC-295 Webhook Agent target ownership', () => {
  test('zero-port uses description and detects an opaque inputs XOR conflict', () => {
    const shape = resolveWebhookAgentShape(agent([]), {
      ...empty,
      inputs: { old: 'value' },
      inputsPresent: true,
    })
    expect(shape).toMatchObject({ kind: 'zero', repairs: [{ kind: 'inputs-on-zero' }] })
    const cleanShape = resolveWebhookAgentShape(agent([]), empty)
    expect(webhookAgentShapeError(cleanShape, empty)).toBe('description-required')
    expect(
      webhookAgentShapeError(cleanShape, {
        ...empty,
        description: 'Run it',
        descriptionPresent: true,
      }),
    ).toBeNull()
  })

  test('ported uses declared text inputs and detects description + orphan repairs', () => {
    const draft = {
      description: 'legacy',
      descriptionPresent: true,
      inputs: { topic: 'T', old: 'O' },
      inputsPresent: true,
    }
    const shape = resolveWebhookAgentShape(
      agent([{ name: 'topic', kind: 'string', required: true }]),
      draft,
    )
    expect(shape.kind).toBe('ported')
    expect(shape.repairs).toEqual([
      { kind: 'description-on-ported' },
      { kind: 'orphan-input', key: 'old', value: 'O' },
    ])
    expect(repairWebhookAgentPayload(shape, draft)).toEqual({
      description: '',
      descriptionPresent: false,
      inputs: { topic: 'T' },
      inputsPresent: true,
    })
  })

  test('upload and signal are blockers while stale values remain orthogonal repairs', () => {
    const draft = {
      ...empty,
      inputs: { file: 'old/path', wake: 'go' },
      inputsPresent: true,
    }
    const shape = resolveWebhookAgentShape(
      agent([
        { name: 'file', kind: 'path<md>' },
        { name: 'wake', kind: 'signal' },
      ]),
      draft,
    )
    expect(shape.blockers.map((blocker) => blocker.kind)).toEqual(['signal', 'upload'])
    expect(shape.repairs.map((repair) => repair.kind)).toEqual([
      'incompatible-input',
      'incompatible-input',
    ])
    expect(webhookAgentShapeError(shape, draft)).toBe('blockers')
  })

  test('list<string> remains a text target with newline presentation', () => {
    const shape = resolveWebhookAgentShape(
      agent([{ name: 'items', kind: 'list<string>', required: false }]),
      empty,
    )
    expect(shape).toMatchObject({
      kind: 'ported',
      inputs: [{ key: 'items', kind: 'text', presentation: 'chips' }],
      blockers: [],
      repairs: [],
    })
  })

  test('required text inputs gate save after repairs are clear', () => {
    const shape = resolveWebhookAgentShape(
      agent([{ name: 'topic', kind: 'markdown', required: true }]),
      empty,
    )
    expect(webhookAgentShapeError(shape, empty)).toBe('required-inputs')
    expect(
      webhookAgentShapeError(shape, {
        ...empty,
        inputs: { topic: 'Explain this' },
        inputsPresent: true,
      }),
    ).toBeNull()
  })
})
