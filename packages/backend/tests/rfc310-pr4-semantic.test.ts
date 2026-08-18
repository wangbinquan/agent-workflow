// RFC-310 PR-4 T46 —— capability semantic validator 锁（§7.5 步骤 4 + 语义示例）。

import { describe, expect, test } from 'bun:test'

import type { AgentOutcomeEnvelope } from '../src/modules/development-automation/domain/agentEnvelope'
import { runCapabilitySemanticValidator } from '../src/modules/development-automation/engine/envelope/semanticValidators'
import { makeManifest, TEST_NONCE } from './helpers/rfc310Pr4Manifest'

function envelope(partial: Partial<AgentOutcomeEnvelope>): AgentOutcomeEnvelope {
  return {
    protocolVersion: 1,
    nonce: TEST_NONCE,
    port: 'agent-result',
    actionRunRef: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    inputDigest: 'd'.repeat(64),
    capabilityId: 'change.implement',
    outcome: 'changed',
    result: {
      capabilityId: 'change.implement',
      summary: 's',
      requirementCoverage: [{ itemRef: 'item-1', disposition: 'implemented' }],
    },
    ...partial,
  } as AgentOutcomeEnvelope
}

const codeOf = (v: ReturnType<typeof runCapabilitySemanticValidator>): string =>
  v.ok ? 'ok' : v.rejection.code

describe('rfc310 pr4 — capability semantic validator', () => {
  test('coverage must be a bijection over the requirement index', () => {
    const manifest = makeManifest()
    const closedRefs = { requirementItemRefs: ['item-1', 'item-2'] }
    const missing = envelope({})
    expect(
      codeOf(runCapabilitySemanticValidator({ manifest, envelope: missing, closedRefs })),
    ).toBe('coverage-missing-item')

    const complete = envelope({
      result: {
        capabilityId: 'change.implement',
        summary: 's',
        requirementCoverage: [
          { itemRef: 'item-1', disposition: 'implemented' },
          { itemRef: 'item-2', disposition: 'not-applicable' },
        ],
      },
    })
    expect(
      codeOf(runCapabilitySemanticValidator({ manifest, envelope: complete, closedRefs })),
    ).toBe('ok')

    const unknown = envelope({
      result: {
        capabilityId: 'change.implement',
        summary: 's',
        requirementCoverage: [{ itemRef: 'item-999', disposition: 'implemented' }],
      },
    })
    expect(
      codeOf(runCapabilitySemanticValidator({ manifest, envelope: unknown, closedRefs })),
    ).toBe('coverage-unknown-item')

    const duplicate = envelope({
      result: {
        capabilityId: 'change.implement',
        summary: 's',
        requirementCoverage: [
          { itemRef: 'item-1', disposition: 'implemented' },
          { itemRef: 'item-1', disposition: 'not-applicable' },
        ],
      },
    })
    expect(
      codeOf(runCapabilitySemanticValidator({ manifest, envelope: duplicate, closedRefs })),
    ).toBe('coverage-duplicate-item')
  })

  test('feedback: each input (threadRef, revision) gets exactly one disposition; stale revision refused', () => {
    const manifest = makeManifest({
      capabilityId: 'mr.feedback.apply',
      feedbackSnapshot: {
        snapshotRef: 'snap-1',
        items: [
          { threadRef: 't-1', revision: 'r-2' },
          { threadRef: 't-2', revision: 'r-1' },
        ],
      },
      protocol: {
        nonce: TEST_NONCE,
        port: 'agent-result',
        outcomeSchemaId: 'mr.feedback.apply#output@1',
      },
    })
    const make = (
      feedback: { threadRef: string; revision: string; disposition: 'addressed' | 'needs-human' }[],
    ) =>
      envelope({
        capabilityId: 'mr.feedback.apply',
        result: { capabilityId: 'mr.feedback.apply', summary: 's', feedback },
      })

    expect(
      codeOf(
        runCapabilitySemanticValidator({
          manifest,
          envelope: make([
            { threadRef: 't-1', revision: 'r-2', disposition: 'addressed' },
            { threadRef: 't-2', revision: 'r-1', disposition: 'needs-human' },
          ]),
        }),
      ),
    ).toBe('ok')

    // 旧 revision = 未输入的 (thread, revision) 组合。
    expect(
      codeOf(
        runCapabilitySemanticValidator({
          manifest,
          envelope: make([{ threadRef: 't-1', revision: 'r-1', disposition: 'addressed' }]),
        }),
      ),
    ).toBe('feedback-unknown-thread')

    expect(
      codeOf(
        runCapabilitySemanticValidator({
          manifest,
          envelope: make([{ threadRef: 't-1', revision: 'r-2', disposition: 'addressed' }]),
        }),
      ),
    ).toBe('feedback-missing-disposition')

    expect(
      codeOf(
        runCapabilitySemanticValidator({
          manifest,
          envelope: make([
            { threadRef: 't-1', revision: 'r-2', disposition: 'addressed' },
            { threadRef: 't-1', revision: 'r-2', disposition: 'needs-human' },
            { threadRef: 't-2', revision: 'r-1', disposition: 'addressed' },
          ]),
        }),
      ),
    ).toBe('feedback-duplicate-thread')
  })

  test('repair refs must stay inside their closed bundles', () => {
    const pipelineManifest = makeManifest({
      capabilityId: 'pipeline.repair',
      protocol: {
        nonce: TEST_NONCE,
        port: 'agent-result',
        outcomeSchemaId: 'pipeline.repair#output@1',
      },
    })
    const pipelineEnvelope = envelope({
      capabilityId: 'pipeline.repair',
      result: { capabilityId: 'pipeline.repair', summary: 's', issueRefs: ['i-9'] },
    })
    expect(
      codeOf(
        runCapabilitySemanticValidator({
          manifest: pipelineManifest,
          envelope: pipelineEnvelope,
          closedRefs: { pipelineIssueRefs: ['i-1', 'i-2'] },
        }),
      ),
    ).toBe('issue-ref-outside-bundle')

    const verificationManifest = makeManifest({
      capabilityId: 'verification.repair',
      verificationEvidence: {
        bundleRef: 'vb-1',
        manifestDigest: 'a'.repeat(64),
        failureRefs: ['f-1'],
      },
      protocol: {
        nonce: TEST_NONCE,
        port: 'agent-result',
        outcomeSchemaId: 'verification.repair#output@1',
      },
    })
    const verificationEnvelope = envelope({
      capabilityId: 'verification.repair',
      result: { capabilityId: 'verification.repair', summary: 's', failureRefs: ['f-2'] },
    })
    expect(
      codeOf(
        runCapabilitySemanticValidator({
          manifest: verificationManifest,
          envelope: verificationEnvelope,
        }),
      ),
    ).toBe('failure-ref-outside-bundle')

    const conflictManifest = makeManifest({
      capabilityId: 'conflict.repair',
      protocol: {
        nonce: TEST_NONCE,
        port: 'agent-result',
        outcomeSchemaId: 'conflict.repair#output@1',
      },
    })
    const conflictEnvelope = envelope({
      capabilityId: 'conflict.repair',
      result: { capabilityId: 'conflict.repair', summary: 's', conflictRefs: ['src/other.ts'] },
    })
    expect(
      codeOf(
        runCapabilitySemanticValidator({
          manifest: conflictManifest,
          envelope: conflictEnvelope,
          closedRefs: { conflictPaths: ['src/main.ts'] },
        }),
      ),
    ).toBe('conflict-path-outside-markers')
  })

  test('read-only capability cannot claim changed', () => {
    const manifest = makeManifest({
      capabilityId: 'change.review',
      protocol: {
        nonce: TEST_NONCE,
        port: 'agent-result',
        outcomeSchemaId: 'change.review#output@1',
      },
    })
    const claimed = envelope({ capabilityId: 'change.review' })
    expect(codeOf(runCapabilitySemanticValidator({ manifest, envelope: claimed }))).toBe(
      'read-only-cannot-change',
    )
  })

  test('duplicate questionIds in needs-information are refused', () => {
    const manifest = makeManifest()
    const dup = envelope({
      outcome: 'needs-information',
      result: {
        questions: [
          { questionId: 'q1', text: 'a?', rationale: 'r' },
          { questionId: 'q1', text: 'b?', rationale: 'r' },
        ],
      },
    })
    expect(codeOf(runCapabilitySemanticValidator({ manifest, envelope: dup }))).toBe(
      'question-duplicate-id',
    )
  })

  test('missing platform closed sets are validator-input-missing (configuration, not agent fault)', () => {
    const manifest = makeManifest()
    expect(codeOf(runCapabilitySemanticValidator({ manifest, envelope: envelope({}) }))).toBe(
      'validator-input-missing',
    )
  })
})
