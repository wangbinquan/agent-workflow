import { describe, expect, test } from 'bun:test'

import { developmentEmployeeRuntimeCodec } from '../src/modules/development-automation/composition/employeeTypePackage'

const headSha = 'a'.repeat(40)
const targetSha = 'b'.repeat(40)

function context(typeId: string, state: unknown) {
  return {
    id: `${typeId}-context`,
    revision: 1,
    typeId,
    stateJson: JSON.stringify(state),
    artifactRefs: [],
  }
}

function continuation(
  pipeline: {
    readonly status: 'pending' | 'passed' | 'failed'
    readonly headSha: string
    readonly targetSha: string | null
  },
  options: { readonly pipelineEnabled?: boolean } = {},
) {
  const mergeRequest = context('development.merge-request', {
    status: 'active',
    mergeRequestRef: 'repo!42',
    headSha,
    targetSha,
    issueHandlingContextRef: 'issue-context',
    readyToMerge: false,
    approvalHold: true,
  })
  const pipelineContext = context('development.pipeline', {
    ...pipeline,
    mergeRequestRef: 'repo!42',
    evidenceArtifactRef: '.agent-workflow/pipeline/case-1/',
    failureTypes: pipeline.status === 'failed' ? ['test-failure'] : [],
    checks: [],
  })
  return JSON.parse(
    developmentEmployeeRuntimeCodec.resolveReactionSettlementJson(
      JSON.stringify({
        schemaVersion: 1,
        employeeTypeRef: { typeId: 'development', revision: 10 },
        workItemRef: 'observe-mr',
        toolSlotRef: 'system',
        outputJson: JSON.stringify({
          schemaVersion: 1,
          roundRef: 'round-observe',
          executionNonce: 'c'.repeat(64),
          status: 'ok',
          summary: 'MR facts refreshed',
          contextPatches: [],
          effectSuggestions: [],
          artifactRefs: [],
        }),
        contextsJson: JSON.stringify([mergeRequest, pipelineContext]),
        enabledWorkItemRefsJson: JSON.stringify([
          'observe-mr',
          ...(options.pipelineEnabled === false ? [] : ['collect-pipeline']),
          'prepare-approval',
          'evaluate-ready',
        ]),
        allowedNextWorkItemRefs: ['prepare-approval', 'evaluate-ready'],
      }),
    ),
  ) as { readonly caseState: string; readonly nextWorkItemRef: string | null }
}

describe('RFC-310 approval and pipeline ordering', () => {
  test('does not draft approval while the current pipeline is pending', () => {
    expect(continuation({ status: 'pending', headSha, targetSha })).toMatchObject({
      caseState: 'active',
      nextWorkItemRef: 'evaluate-ready',
    })
  })

  test('does not reuse a terminal pipeline from another source or target revision', () => {
    expect(continuation({ status: 'passed', headSha: 'd'.repeat(40), targetSha })).toMatchObject({
      nextWorkItemRef: 'evaluate-ready',
    })
    expect(continuation({ status: 'passed', headSha, targetSha: 'e'.repeat(40) })).toMatchObject({
      nextWorkItemRef: 'evaluate-ready',
    })
  })

  test('drafts approval after a terminal pipeline is bound to the current revision', () => {
    expect(continuation({ status: 'passed', headSha, targetSha })).toMatchObject({
      caseState: 'active',
      nextWorkItemRef: 'prepare-approval',
    })
  })

  test('does not wait for pipeline evidence when that optional lane is disabled', () => {
    expect(
      continuation({ status: 'pending', headSha, targetSha }, { pipelineEnabled: false }),
    ).toMatchObject({
      caseState: 'active',
      nextWorkItemRef: 'prepare-approval',
    })
  })
})
