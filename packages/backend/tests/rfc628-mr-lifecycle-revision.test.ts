// Regression guard (RFC-628): a digital employee preempted by an event before it posts "reply with
// repair result" still posts that reply afterwards.
//
// 2026-11-27, a real case on GitLab (recorded in design/RFC-616-process-metrics/plan.md §4.7): the
// employee pushed its review repair and its next step was "reply with repair result". Reading the
// merge request facts collided with the head moving and blocked the step; commit 033f5fafe fixed that
// first half (the read collects again). After the case was resumed, an event that declares preemption
// took the round instead and the prepared reply was never posted. RFC-628 fixes that second half in a
// new type revision: development@12 and graph-development@3; earlier revisions keep their frozen
// behaviour.
//
// This file locks the revision gates (design §3.1, §3.6, §6 A1 and J3): which type revisions get the
// preemption-safe replies, and that raising graph-development to 3 does not take merge-request
// delivery away from revision 2 (both thresholds compare against the first MR revision, not the
// current one).
import { describe, expect, test } from 'bun:test'
import { graphEmployeeRuntimeCodec } from '@/modules/development-automation/application/graph-development/employeeCodec'
import { composeGraphDeliveryLifecycleRuntimeCodec } from '@/modules/development-automation/composition/graphDeliveryLifecycle'
import {
  usesMinimalMergeRequestToolContracts,
  usesPreemptionSafeReviewReplies,
  usesTargetAwareMergeRequestPipeline,
} from '@/modules/development-automation/domain/mergeRequestLifecycle'

const graph = composeGraphDeliveryLifecycleRuntimeCodec(graphEmployeeRuntimeCodec)

describe('RFC-628 A1 preemption-safe review replies follow the frozen type revision', () => {
  test('development from 12, graph-development from 3, nothing else', () => {
    expect(usesPreemptionSafeReviewReplies({ typeId: 'development', revision: 10 })).toBe(false)
    expect(usesPreemptionSafeReviewReplies({ typeId: 'development', revision: 11 })).toBe(false)
    expect(usesPreemptionSafeReviewReplies({ typeId: 'development', revision: 12 })).toBe(true)
    expect(usesPreemptionSafeReviewReplies({ typeId: 'development', revision: 13 })).toBe(true)
    expect(usesPreemptionSafeReviewReplies({ typeId: 'graph-development', revision: 1 })).toBe(
      false,
    )
    expect(usesPreemptionSafeReviewReplies({ typeId: 'graph-development', revision: 2 })).toBe(
      false,
    )
    expect(usesPreemptionSafeReviewReplies({ typeId: 'graph-development', revision: 3 })).toBe(true)
    expect(usesPreemptionSafeReviewReplies({ typeId: 'another-type', revision: 99 })).toBe(false)
    expect(usesPreemptionSafeReviewReplies(null)).toBe(false)
    expect(usesPreemptionSafeReviewReplies(undefined)).toBe(false)
  })

  test('the earlier gates keep holding for graph-development@3 (they are "at least 2")', () => {
    const graphThree = { typeId: 'graph-development', revision: 3 }
    expect(usesTargetAwareMergeRequestPipeline(graphThree)).toBe(true)
    expect(usesMinimalMergeRequestToolContracts(graphThree)).toBe(true)
    expect(usesTargetAwareMergeRequestPipeline({ typeId: 'development', revision: 12 })).toBe(true)
    expect(usesMinimalMergeRequestToolContracts({ typeId: 'development', revision: 12 })).toBe(true)
  })
})

describe('RFC-628 J3 graph cases request MR delivery from revision 2 on', () => {
  const initialInput = {
    schemaVersion: 1,
    caseRef: 'graph-case',
    employeeRef: { id: 'graph-employee', revision: 1 },
    workScopeJson: JSON.stringify({ kind: 'repository', repositoryId: 'repo' }),
    receivedAt: 1,
    intake: {
      kind: 'body',
      target: { repositoryId: 'repo' },
      body: 'Avoid duplicate bookings',
      typeOptions: {},
      uploads: [],
    },
  }

  test('buildInitialCaseJson: revisions 2 and 3 enter merge-request delivery, revision 1 does not', () => {
    const legacy = JSON.stringify({
      ...initialInput,
      employeeTypeRef: { typeId: 'graph-development', revision: 1 },
    })
    expect(graph.buildInitialCaseJson(legacy)).toBe(
      graphEmployeeRuntimeCodec.buildInitialCaseJson(legacy),
    )
    expect(
      JSON.parse(JSON.parse(graph.buildInitialCaseJson(legacy)).primaryContextJson).request
        .deliveryMode,
    ).toBeUndefined()
    for (const revision of [2, 3]) {
      const launched = JSON.parse(
        graph.buildInitialCaseJson(
          JSON.stringify({
            ...initialInput,
            employeeTypeRef: { typeId: 'graph-development', revision },
          }),
        ),
      ) as { primaryContextTypeId: string; primaryContextJson: string }
      expect(launched.primaryContextTypeId).toBe('graph-development.design-context')
      expect(JSON.parse(launched.primaryContextJson).request.deliveryMode).toBe('merge-request')
    }
  })

  const parentIssue = {
    id: 'parent-issue',
    revision: 1,
    typeId: 'development.issue-handling',
    stateJson: JSON.stringify({
      status: 'active',
      subjectRef: 'case:parent-case',
      repositoryRef: 'repo',
      request: { kind: 'body', body: 'Parent request', externalId: null, uploads: [] },
      materialArtifactRefs: [],
      deliveryContent: null,
    }),
    artifactRefs: [],
  }
  const invokedRequest = (revision: number) =>
    JSON.stringify({
      schemaVersion: 1,
      caseRef: 'graph-child-case',
      employeeTypeRef: { typeId: 'graph-development', revision },
      invocationRef: 'invocation-1',
      parentCaseRef: { id: 'parent-case', revision: 3 },
      targetEmployeeRef: { id: 'graph-employee', revision: 1 },
      targetWorkScopeJson: JSON.stringify({ kind: 'repository', repositoryId: 'repo' }),
      inputEnvelopeJson: JSON.stringify({
        contextsJson: JSON.stringify([parentIssue]),
        contractInput: {},
      }),
      receivedAt: 1,
    })

  test('buildInvokedCaseJson: revisions 2 and 3 are delegated MR delivery, revision 1 declares none', () => {
    for (const revision of [2, 3]) {
      const invoked = JSON.parse(graph.buildInvokedCaseJson(invokedRequest(revision))) as {
        primaryContextTypeId: string
        primaryContextJson: string
      }
      expect(invoked.primaryContextTypeId).toBe('graph-development.design-context')
      expect(JSON.parse(invoked.primaryContextJson).request.deliveryMode).toBe('merge-request')
    }
    expect(() => graph.buildInvokedCaseJson(invokedRequest(1))).toThrow(
      'graph-development-does-not-declare-invocation-contracts',
    )
  })
})
