// RFC-396: graph development must retain the established MR care lifecycle.
// These regressions keep its real type identity, exact revision-bound evidence,
// reply-only feedback and publication-time graph verification together.
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { graphEmployeeRuntimeCodec } from '@/modules/development-automation/application/graph-development/employeeCodec'
import { graphEmployeeTypePackage } from '@/modules/development-automation/application/graph-development/employeeType'
import {
  composeGraphDeliveryLifecycleRuntimeCodec,
  composeGraphDeliveryLifecycleTypePackage,
  GRAPH_DELIVERY_EMPLOYEE_TYPE,
} from '@/modules/development-automation/composition/graphDeliveryLifecycle'
import {
  developmentEmployeeRuntimeCodec,
  developmentEmployeeTypePackage,
  mergeRequestLifecycleDescriptor,
} from '@/modules/development-automation/composition/employeeTypePackage'
import {
  composeDevelopmentEmployeePlatformWorkItemsFromPersistence,
  type DevelopmentEmployeePlatformWorkItemsCompositionInput,
} from '@/modules/development-automation/composition/digitalEmployeePlatformWorkItems'
import {
  MERGE_REQUEST_LIFECYCLE_WORK_ITEM_REFS,
  usesMinimalMergeRequestToolContracts,
  usesTargetAwareMergeRequestPipeline,
} from '@/modules/development-automation/domain/mergeRequestLifecycle'
import {
  businessTreeSnapshot,
  businessTreeSnapshotDigest,
} from '@/modules/development-automation/infrastructure/workspaceValidator'
import {
  employeeTypePackageDescriptorSchema,
  validateTypePackage,
} from '@/modules/digital-employee/domain/model'

const graph = composeGraphDeliveryLifecycleRuntimeCodec(graphEmployeeRuntimeCodec)
const graphPackage = composeGraphDeliveryLifecycleTypePackage(graphEmployeeTypePackage)
const descriptor = () =>
  employeeTypePackageDescriptorSchema.parse(JSON.parse(graphPackage.descriptorJson))
const headSha = 'a'.repeat(40),
  targetSha = 'b'.repeat(40),
  treeOid = 'c'.repeat(40)
const candidateRef = 'd'.repeat(64),
  nonce = 'e'.repeat(64)
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function context(typeId: string, state: unknown) {
  return {
    id: `${typeId}-context`,
    revision: 1,
    schemaVersion: 1,
    typeId,
    lifecycleState: 'active',
    stateJson: JSON.stringify(state),
    artifactRefs: [],
  }
}
type Context = ReturnType<typeof context>

const deliveryContent = {
  commitMessage: 'fix: keep the reviewed booking rule',
  mergeRequestTitle: 'Apply the reviewed booking design',
  mergeRequestDescription: 'Implements the approved design and preserves its verification.',
}
const issue = () =>
  context('development.issue-handling', {
    status: 'active',
    subjectRef: 'case:graph-case',
    repositoryRef: 'repo',
    request: { kind: 'body', body: 'Avoid duplicate bookings', externalId: null, uploads: [] },
    materialArtifactRefs: [],
    deliveryContent,
  })
const mergeRequest = (changes: Record<string, unknown> = {}) =>
  context('development.merge-request', {
    status: 'active',
    mergeRequestRef: 'repo!42',
    headSha,
    targetSha,
    issueHandlingContextRef: issue().id,
    readyToMerge: false,
    ...changes,
  })
const pipeline = (changes: Record<string, unknown> = {}) =>
  context('development.pipeline', {
    status: 'passed',
    mergeRequestRef: 'repo!42',
    headSha,
    targetSha,
    evidenceArtifactRef: '.agent-workflow/pipeline/graph-case/',
    failureTypes: [],
    checks: [],
    ...changes,
  })
const reviewThread = {
  threadRef: 'review-1',
  revision: '1:4',
  authorClass: 'human',
  resolved: false,
  body: 'Does an occupied time slot reject a duplicate booking?',
  path: 'src/book.ts',
  messages: [
    {
      messageRef: 'note-4',
      parentMessageRef: null,
      authorClass: 'human',
      body: 'Does an occupied time slot reject a duplicate booking?',
      path: 'src/book.ts',
      createdAt: null,
    },
  ],
}
const reviewProblem = () =>
  context('development.problem-set', {
    status: 'active',
    source: 'review',
    headSha,
    remainingTypes: ['review'],
    problems: [
      {
        problemId: 'review-1',
        type: 'review',
        summary: reviewThread.body,
        evidenceArtifactRefs: [],
        reviewThread,
      },
    ],
  })
const reviewResolution = (status = 'acknowledged') =>
  context('development.review-resolution', {
    status,
    mergeRequestRef: 'repo!42',
    sourceHeadSha: headSha,
    publishedHeadSha: null,
    commitSha: null,
    threads: [
      {
        threadRef: 'review-1',
        revision: '1:4',
        acknowledgement: { marker: 'received-1', noteRef: 'note-5' },
        disposition: status === 'prepared' ? 'addressed' : null,
        replyBody: status === 'prepared' ? 'The existing rule covers it.' : null,
        finalReply: null,
      },
    ],
  })
const output = (changes: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  roundRef: 'round-1',
  executionNonce: nonce,
  status: 'ok',
  summary: 'Work completed',
  contextPatches: [],
  effectSuggestions: [],
  artifactRefs: [],
  ...changes,
})
function settlement(
  workItemRef: string,
  contexts: Context[],
  changes: Record<string, unknown> = {},
  eventTypeId?: string,
) {
  return JSON.parse(
    graph.resolveReactionSettlementJson(
      JSON.stringify({
        schemaVersion: 1,
        employeeTypeRef: GRAPH_DELIVERY_EMPLOYEE_TYPE,
        workItemRef,
        toolSlotRef: 'test-failure',
        contextsJson: JSON.stringify(contexts),
        outputJson: JSON.stringify(output(changes)),
        inputEnvelopeJson: JSON.stringify({
          contextsJson: JSON.stringify(contexts),
          contractInput: {},
          eventJson: JSON.stringify({ eventTypeRef: { id: eventTypeId ?? 'manual' } }),
        }),
        enabledWorkItemRefsJson: JSON.stringify(MERGE_REQUEST_LIFECYCLE_WORK_ITEM_REFS),
        allowedNextWorkItemRefs: descriptor().authoringManifest.workItems.find(
          (item) => item.workItemRef === workItemRef,
        )!.nextWorkItemRefs,
      }),
    ),
  ) as {
    caseState: string
    nextWorkItemRef: string | null
    terminalKind: string | null
    contextPatches: Array<{ contextTypeId: string; stateJson: string }>
  }
}

describe('RFC-396 graph MR type composition', () => {
  test('composes every care duty without replacing the graph intake or the frozen v1 package', () => {
    const value = descriptor()
    expect(validateTypePackage(value)).toEqual([])
    expect(value.typeRef).toEqual(GRAPH_DELIVERY_EMPLOYEE_TYPE)
    expect(value.workStartWorkItemRef).toBe('understand-request')
    expect(value.authoringManifest.workItems.map((item) => item.workItemRef)).toEqual(
      expect.arrayContaining([...MERGE_REQUEST_LIFECYCLE_WORK_ITEM_REFS]),
    )
    expect(
      value.authoringManifest.workItems.find((item) => item.workItemRef === 'deliver-result')
        ?.nextWorkItemRefs,
    ).toEqual(['publish-mr'])
    expect(
      value.authoringManifest.workItems.some((item) => item.workItemRef === 'analyze-implement'),
    ).toBe(false)
    expect(JSON.parse(graphEmployeeTypePackage.descriptorJson).typeRef.revision).toBe(1)
    expect(JSON.parse(developmentEmployeeTypePackage.descriptorJson).typeRef).toEqual({
      typeId: 'development',
      revision: 11,
    })
    expect(
      mergeRequestLifecycleDescriptor.eventTypes.every(
        (event) => event.ownerTypeId === 'development',
      ),
    ).toBe(true)
  })

  test('selects modern capabilities using the true graph revision while retaining legacy thresholds', () => {
    expect(usesTargetAwareMergeRequestPipeline(GRAPH_DELIVERY_EMPLOYEE_TYPE)).toBe(true)
    expect(usesMinimalMergeRequestToolContracts(GRAPH_DELIVERY_EMPLOYEE_TYPE)).toBe(true)
    expect(usesMinimalMergeRequestToolContracts({ typeId: 'graph-development', revision: 1 })).toBe(
      false,
    )
    expect(usesTargetAwareMergeRequestPipeline({ typeId: 'development', revision: 7 })).toBe(false)
    expect(usesTargetAwareMergeRequestPipeline({ typeId: 'development', revision: 8 })).toBe(true)
    expect(usesMinimalMergeRequestToolContracts({ typeId: 'development', revision: 8 })).toBe(false)
    expect(usesMinimalMergeRequestToolContracts({ typeId: 'development', revision: 9 })).toBe(true)
    expect(usesMinimalMergeRequestToolContracts({ typeId: 'another-type', revision: 99 })).toBe(
      false,
    )
  })

  test('new graph cases request MR delivery; historical type requests keep the original result', () => {
    const input = {
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
    for (const employeeTypeRef of [undefined, { typeId: 'graph-development', revision: 1 }]) {
      const json = JSON.stringify({ ...input, employeeTypeRef })
      expect(graph.buildInitialCaseJson(json)).toBe(
        graphEmployeeRuntimeCodec.buildInitialCaseJson(json),
      )
    }
    const launched = JSON.parse(
      graph.buildInitialCaseJson(
        JSON.stringify({
          ...input,
          employeeTypeRef: GRAPH_DELIVERY_EMPLOYEE_TYPE,
        }),
      ),
    )
    expect(launched.primaryContextTypeId).toBe('graph-development.design-context')
    expect(JSON.parse(launched.primaryContextJson).request.deliveryMode).toBe('merge-request')
  })

  test('retains exact MR external correlation and cancels care subscriptions at observed terminal state', () => {
    const active = mergeRequest()
    expect(
      JSON.parse(graph.resolveExternalSubjectBindingsJson!(active.typeId, active.stateJson)),
    ).toEqual([
      {
        eventTypeRef: { id: 'development.lifecycle-updated', revision: 2 },
        subject: { typeId: 'merge-request', subjectRef: 'repo!42' },
      },
    ])
    expect(
      JSON.parse(graph.resolveAttentionSubjectsJson(active.typeId, active.stateJson)),
    ).toHaveLength(3)
    for (const status of ['merged', 'closed']) {
      const terminal = mergeRequest({ status })
      expect(graph.resolveAttentionSubjectsJson(terminal.typeId, terminal.stateJson)).toBe('[]')
      expect(graph.resolveExternalSubjectBindingsJson!(terminal.typeId, terminal.stateJson)).toBe(
        '[]',
      )
      expect(settlement('observe-mr', [terminal])).toMatchObject({
        caseState: 'terminal',
        terminalKind: status,
        nextWorkItemRef: null,
      })
    }
    expect(settlement('wait-merge', [active])).toMatchObject({
      caseState: 'waiting',
      terminalKind: null,
      nextWorkItemRef: null,
    })
  })

  test('approval waits for pipeline evidence belonging to both the current source and target', () => {
    const mr = mergeRequest({ approvalHold: true })
    for (const changes of [
      { status: 'pending' },
      { headSha: 'f'.repeat(40) },
      { targetSha: 'f'.repeat(40) },
      { targetSha: null },
    ]) {
      expect(settlement('observe-mr', [mr, pipeline(changes)]).nextWorkItemRef).toBe(
        'evaluate-ready',
      )
    }
    expect(settlement('observe-mr', [mr, pipeline()]).nextWorkItemRef).toBe('prepare-approval')
    expect(settlement('collect-pipeline', [pipeline({ status: 'pending' })])).toMatchObject({
      caseState: 'waiting',
      nextWorkItemRef: null,
    })
  })

  test('routes changed human feedback and conflicts through the shared acknowledgement and repair duties', () => {
    expect(
      settlement(
        'observe-mr',
        [
          mergeRequest({
            unresolvedReviewCount: 1,
            reviewThreads: [reviewThread],
          }),
        ],
        {},
        'development.review-updated',
      ).nextWorkItemRef,
    ).toBe('classify-feedback')
    expect(settlement('classify-feedback', [reviewProblem()]).nextWorkItemRef).toBe(
      'acknowledge-feedback',
    )
    expect(settlement('acknowledge-feedback', [reviewProblem()]).nextWorkItemRef).toBe(
      'repair-feedback',
    )
    expect(
      settlement(
        'observe-mr',
        [mergeRequest({ mergeableState: 'conflict' })],
        {},
        'development.conflict-updated',
      ).nextWorkItemRef,
    ).toBe('repair-conflict')
    expect(settlement('repair-conflict', [mergeRequest()]).nextWorkItemRef).toBe('publish-conflict')
  })

  test('reply-only review output stays a real minimal result and skips candidate publication', () => {
    const contexts = [issue(), mergeRequest(), reviewProblem(), reviewResolution()]
    const envelope = JSON.stringify({
      contextsJson: JSON.stringify(contexts),
      contractInput: {},
      platformPaths: {
        requirementDirectory: '.agent-workflow/inputs/requirements/graph-case',
        externalMaterialDirectory: '.agent-workflow/inputs/requirements/graph-case/external',
        pipelineDirectory: '.agent-workflow/pipeline/graph-case',
        implementationPlanPath: '.agent-workflow/inputs/requirements/graph-case/plan.md',
      },
    })
    const validated = JSON.parse(
      graph.validateReactionOutputJson(
        JSON.stringify({
          schemaVersion: 1,
          employeeTypeRef: GRAPH_DELIVERY_EMPLOYEE_TYPE,
          workItemRef: 'repair-feedback',
          toolSlotRef: 'default',
          inputEnvelopeJson: envelope,
          outputJson: JSON.stringify({
            schemaVersion: 1,
            roundRef: 'round-1',
            executionNonce: nonce,
            directResult: {
              outcome: 'completed',
              replies: [
                {
                  threadRef: 'review-1',
                  reply: 'The existing approved booking check already rejects occupied slots.',
                },
              ],
            },
          }),
        }),
      ),
    )
    expect(validated.deliveryContent ?? null).toBeNull()
    expect(validated.reviewReplies).toHaveLength(1)
    expect(settlement('repair-feedback', contexts, validated).nextWorkItemRef).toBe(
      'reply-feedback',
    )
    expect(settlement('repair-feedback', contexts, { deliveryContent }).nextWorkItemRef).toBe(
      'prepare-change',
    )
    expect(settlement('publish-mr', [reviewResolution('prepared')]).nextWorkItemRef).toBe(
      'reply-feedback',
    )
    expect(settlement('publish-mr', []).nextWorkItemRef).toBe('observe-mr')
  })

  test('care assembly and settlement do not impersonate a legacy employee revision', () => {
    const request = {
      schemaVersion: 1,
      employeeTypeRef: GRAPH_DELIVERY_EMPLOYEE_TYPE,
      caseRef: 'graph-case',
      roundRef: 'round-1',
      executionNonce: nonce,
      workItemRef: 'collect-pipeline',
      toolSlotRef: 'system',
      inputSchemaId: 'development.pipeline-collection.input.v3',
      outputSchemaId: 'development.pipeline-collection.output.v3',
      eventJson: '{}',
      contextsJson: JSON.stringify([issue(), mergeRequest()]),
    }
    const json = JSON.stringify(request)
    expect(graph.assembleReactionInputJson(json)).toBe(
      developmentEmployeeRuntimeCodec.assembleReactionInputJson(json),
    )
    expect(graph.assembleReactionInputJson(json)).toContain('both the frozen head and target')
  })
})

function platformFixture(
  options: {
    gate?: 'pass' | 'block' | 'missing'
    conflictPath?: string
    conflictDigest?: string
  } = {},
) {
  const calls: string[] = []
  let row = {
    caseId: 'graph-case',
    repositoryId: 'repo',
    cachedRepoId: 'cached',
    baselineSha: headSha,
    targetBranch: 'main',
    sourceBranch: 'graph/booking',
    remoteHeadSha: null as string | null,
    state: 'active' as 'active' | 'published',
    createdAt: 1,
    updatedAt: 1,
  }
  let candidate = {
    candidateRef,
    baselineSha: headSha,
    treeOid,
    receiptJson: JSON.stringify({ treeOid, uploadPlan: null, uploadLineage: null }),
    summarySource: deliveryContent.commitMessage,
    state: 'prepared' as 'prepared' | 'committed' | 'published',
    commitSha: null as string | null,
  }
  let ensureCount = 0
  const unexpected = async (): Promise<never> => {
    throw new Error('unexpected fixture effect')
  }
  const input: DevelopmentEmployeePlatformWorkItemsCompositionInput = {
    appHome: '/tmp/rfc396-lifecycle-port-fixture',
    directPublicationSubject: { kind: 'system' },
    persistence: {
      currentWorkspace: async () => ({ row, repositoryLocalPath: '/repo-baseline' }),
      prepareApprovalSaga: unexpected,
      approvalSaga: unexpected,
      recordApprovalSubmission: unexpected,
      recordApprovalObservation: unexpected,
      insertCandidate: async () => {
        calls.push('candidate.persist')
      },
      candidate: async () => candidate,
      recordCandidateCommit: async ({ commitSha }) => {
        candidate = { ...candidate, commitSha, state: 'committed' }
      },
      publishCandidateAndWorkspace: async ({ commitSha }) => {
        calls.push('publication.persist')
        candidate = { ...candidate, state: 'published' }
        row = { ...row, state: 'published', baselineSha: commitSha, remoteHeadSha: commitSha }
      },
      updateWorkspaceHead: async () => {
        calls.push('workspace.update')
      },
      latestRoundValidation: async () =>
        JSON.stringify({
          ok: true,
          changedPaths: ['book.ts'],
          postBusinessDigest: options.conflictDigest,
          conflict: {
            workspacePath: options.conflictPath,
            sourceSha: headSha,
            targetSha,
            conflictPaths: ['book.ts'],
          },
          inspection: { ok: true },
        }),
    },
    reactionRounds: {
      frozenPlan: () => null,
      lastSettledRound: () => ({ roundRef: 'repair-round' }),
    },
    repoRemote: {
      resolve: async () => ({
        remoteUrl: 'https://example.invalid/repo.git',
        defaultBranch: 'main',
      }),
    },
    mrEffects: {
      reply: unexpected,
      observe: unexpected,
      ensure: async (_repositoryId, request) => {
        calls.push(`mr.ensure:${request.sourceBranch}->${request.targetBranch}`)
        return {
          ok: true,
          mr: {
            mrRef: '42',
            webUrl: 'https://example.invalid/repo/merge_requests/42',
            state: 'opened',
            sourceSha: headSha,
            created: ensureCount++ === 0,
          },
        }
      },
    },
    sourceControl: {
      derive: async () => {
        calls.push('candidate.derive')
        return {
          ok: true,
          receipt: {
            candidateRef,
            treeOid,
            changed: { added: ['book.ts'], modified: [], deleted: [] },
          },
        }
      },
      commit: async () => {
        calls.push('commit')
        return { ok: true, commitSha: targetSha, localRef: 'local:commit', reused: false }
      },
      push: async (request) => {
        calls.push(`push:${request.expectedTreeOid}`)
        return {
          ok: true,
          receipt: {
            remoteRef: `refs/heads/${request.branch}`,
            oldSha: request.expectedRemoteSha,
            newSha: request.commitSha,
            reused: false,
          },
        }
      },
      checkpoint: async () => ({ checkpointDigest: nonce }),
      restore: async () => ({ workspacePath: '/scene/workspace' }),
      materialize: unexpected,
      rematerialize: async () => ({ workspacePath: '/scene/workspace' }),
      fetchRemoteHead: unexpected,
      importCommit: async () => {
        calls.push('commit.import')
      },
    },
    conflictMerge: {
      finish: async () => {
        calls.push('conflict.finish')
        return { ok: true, mergeCommitSha: targetSha, treeOid }
      },
    },
    ...(options.gate === 'missing'
      ? {}
      : {
          graphDelivery: {
            beforePublish: async (request) => {
              calls.push(`graph.verify:${request.workItemRef}:${request.expectedTreeOid}`)
              return options.gate === 'block'
                ? {
                    ok: false as const,
                    code: 'graph-mr-design-review-required',
                    detail: 'The approved design changed.',
                  }
                : { ok: true as const }
            },
          },
        }),
  }
  const runner = composeDevelopmentEmployeePlatformWorkItemsFromPersistence(input)
  const candidateContext = () =>
    context('development.change-candidate', {
      status: candidate.state,
      candidateRef,
      baselineSha: candidate.baselineSha,
      treeOid,
      summarySource: candidate.summarySource,
      changedPaths: ['book.ts'],
      commitSha: candidate.commitSha,
    })
  return {
    calls,
    async execute(workItemRef: string) {
      if (workItemRef === 'publish-conflict') row = { ...row, remoteHeadSha: headSha }
      return JSON.parse(
        await runner.execute({
          roundRef: `round-${workItemRef}`,
          executionNonce: nonce,
          caseRef: { id: 'graph-case' },
          employeeTypeRef: GRAPH_DELIVERY_EMPLOYEE_TYPE,
          triggeringEventRef: 'event-1',
          workItemRef,
          externalWaitDeadlineMs: 60_000,
          inputEnvelopeJson: JSON.stringify({
            contextsJson: JSON.stringify([issue(), candidateContext(), mergeRequest()]),
          }),
        }),
      ) as {
        status: string
        summary: string
        contextPatches: Array<{ contextTypeId: string; stateJson: string }>
      }
    },
  }
}

describe('RFC-396 shared platform MR effects retain graph verification', () => {
  test('blocks candidate persistence and publication when the repaired tree no longer satisfies the design', async () => {
    for (const workItemRef of ['prepare-change', 'publish-mr']) {
      const fixture = platformFixture({ gate: 'block' })
      expect(await fixture.execute(workItemRef)).toMatchObject({ status: 'blocked' })
      expect(fixture.calls).toContain(`graph.verify:${workItemRef}:${treeOid}`)
      expect(fixture.calls).not.toContain('candidate.persist')
      expect(fixture.calls).not.toContain('commit')
      expect(
        fixture.calls.some((call) => call.startsWith('push:') || call.startsWith('mr.ensure:')),
      ).toBe(false)
    }
  })

  test('a missing graph verification binding is a visible blocked result for every publication path', async () => {
    for (const workItemRef of ['prepare-change', 'publish-mr', 'publish-conflict']) {
      const fixture = platformFixture({ gate: 'missing' })
      expect(await fixture.execute(workItemRef)).toMatchObject({ status: 'blocked' })
      expect(fixture.calls).toEqual([])
    }
  })

  test('creates and later updates the same MR only after exact candidate verification', async () => {
    const fixture = platformFixture()
    expect(await fixture.execute('prepare-change')).toMatchObject({ status: 'ok' })
    expect(await fixture.execute('publish-mr')).toMatchObject({
      status: 'ok',
      summary: '已提交并创建 MR',
    })
    expect(await fixture.execute('publish-mr')).toMatchObject({
      status: 'ok',
      summary: '已提交并更新 MR',
    })
    expect(fixture.calls.filter((call) => call.startsWith('mr.ensure:'))).toEqual([
      'mr.ensure:graph/booking->main',
      'mr.ensure:graph/booking->main',
    ])
    expect(fixture.calls.indexOf(`graph.verify:publish-mr:${treeOid}`)).toBeLessThan(
      fixture.calls.indexOf('commit'),
    )
    expect(fixture.calls.filter((call) => call === 'commit')).toHaveLength(1)
  })

  test('conflict merge remains local until its exact merged tree passes graph verification', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc396-mr-conflict-'))
    roots.push(root)
    writeFileSync(join(root, 'book.ts'), 'export const duplicateBooking = false\n')
    const conflictDigest = businessTreeSnapshotDigest(await businessTreeSnapshot(root))
    const fixture = platformFixture({ gate: 'block', conflictPath: root, conflictDigest })
    expect(await fixture.execute('publish-conflict')).toMatchObject({ status: 'blocked' })
    expect(fixture.calls).toEqual(['conflict.finish', `graph.verify:publish-conflict:${treeOid}`])
  })
})
