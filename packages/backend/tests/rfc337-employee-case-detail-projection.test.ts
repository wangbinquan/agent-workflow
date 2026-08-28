import { describe, expect, test } from 'bun:test'

import { projectDevelopmentEmployeeCaseDetail } from '@/modules/development-automation/composition/employeeCaseDetailProjection'
import { projectEmployeeCaseArtifacts } from '@/modules/digital-employee/application/runtimeService'
import type {
  EmployeeCaseDetailProjectionInputV1,
  EmployeeCaseDetailProjectionV1,
} from '@/modules/digital-employee/public/types'

const SHA = 'a'.repeat(40)
const TARGET_SHA = 'b'.repeat(40)
const TREE = 'c'.repeat(40)
const CANDIDATE = 'd'.repeat(64)

function snapshot(
  launchOrigin: EmployeeCaseDetailProjectionInputV1['case']['launchOrigin'],
  contexts: EmployeeCaseDetailProjectionInputV1['contexts'],
): EmployeeCaseDetailProjectionInputV1 {
  return {
    schemaVersion: 1,
    case: {
      id: 'case-rfc337',
      typeRef: { typeId: 'development', revision: 10 },
      launchOrigin,
      primaryContextId: 'context-issue',
    },
    contexts,
    rounds: [],
  }
}

function context(
  id: string,
  typeId: string,
  state: unknown,
  updatedAt: number,
  schemaVersion = 1,
): EmployeeCaseDetailProjectionInputV1['contexts'][number] {
  return {
    id,
    typeId,
    schemaVersion,
    stateJson: JSON.stringify(state),
    artifactRefs: [],
    updatedAt,
  }
}

function issueRequest(input: {
  kind: 'body' | 'files' | 'body-and-files' | 'external-id'
  body: string | null
  externalId: string | null
}) {
  return {
    status: 'active',
    subjectRef: 'repo-1:issue-42',
    repositoryRef: 'repo-1',
    request: {
      ...input,
      uploads: [
        {
          artifactRef: 'employee-input:requirements',
          placement: 'repository',
          targetPath: 'inputs/requirements/issue.md',
          originalName: 'issue.md',
        },
      ],
      executionOptions: { 'review-plan': true },
    },
    materialArtifactRefs: ['employee-input:requirements'],
    deliveryContent: null,
  }
}

describe('RFC-337 digital employee Case detail projection', () => {
  test('projects the one frozen input for direct, external-id, API, and event launches', () => {
    const directIssue = context(
      'context-issue',
      'development.issue-handling',
      issueRequest({
        kind: 'body-and-files',
        body: 'Implement the exact request',
        externalId: null,
      }),
      1,
    )
    const direct = projectDevelopmentEmployeeCaseDetail({
      snapshot: snapshot('api', [directIssue]),
      workspace: null,
    })
    expect(direct.input).toEqual({
      source: 'api',
      ingressRef: 'ui-input:direct',
      kind: 'body-and-files',
      subjectRef: 'repo-1:issue-42',
      repositoryRef: 'repo-1',
      body: 'Implement the exact request',
      externalId: null,
      uploads: [
        {
          artifactRef: 'employee-input:requirements',
          placement: 'repository',
          targetPath: 'inputs/requirements/issue.md',
          originalName: 'issue.md',
        },
      ],
      executionOptions: { 'review-plan': true },
      advancedOptions: {},
    })

    const external = projectDevelopmentEmployeeCaseDetail({
      snapshot: snapshot('manual', [
        context(
          'context-issue',
          'development.issue-handling',
          issueRequest({ kind: 'external-id', body: null, externalId: 'ISSUE-42' }),
          1,
        ),
      ]),
      workspace: null,
    })
    expect(external.input.kind).toBe('external-id')
    expect(external.input.ingressRef).toBe('ui-input:external-id')
    expect(external.input.externalId).toBe('ISSUE-42')

    const event = projectDevelopmentEmployeeCaseDetail({
      snapshot: snapshot('event', [directIssue]),
      workspace: null,
    })
    expect(event.input.kind).toBe('event')
    expect(event.input.ingressRef).toBe('issue')
    expect(event.input.body).toBe('Implement the exact request')
  })

  test('projects exact workspace, change candidate, and MR facts with related UI refs', () => {
    const projection = projectDevelopmentEmployeeCaseDetail({
      snapshot: snapshot('manual', [
        context(
          'context-issue',
          'development.issue-handling',
          issueRequest({ kind: 'body', body: 'Fix it', externalId: null }),
          1,
        ),
        context(
          'context-candidate',
          'development.change-candidate',
          {
            status: 'published',
            candidateRef: CANDIDATE,
            baselineSha: SHA,
            treeOid: TREE,
            summarySource: 'Fix the broken detail view',
            changedPaths: ['packages/frontend/src/routes/detail.tsx'],
            commitSha: TARGET_SHA,
          },
          2,
        ),
        context(
          'context-mr',
          'development.merge-request',
          {
            status: 'active',
            mergeRequestRef: 'github:owner/repo#42',
            headSha: TARGET_SHA,
            issueHandlingContextRef: 'context-issue',
            readyToMerge: true,
            factsHeadSha: TARGET_SHA,
            targetSha: SHA,
            mergedCommitSha: null,
            draft: false,
            mergeableState: 'mergeable',
            approvalHold: false,
            unresolvedReviewCount: 0,
            reviewThreads: [],
            repositoryRef: 'repo-1',
            providerMrRef: '42',
            sourceBranch: 'agent/case-rfc337',
            targetBranch: 'main',
            webUrl: 'https://github.example/owner/repo/pull/42',
          },
          3,
        ),
      ]),
      workspace: {
        repositoryId: 'repo-1',
        cachedRepoId: 'cached-repo-1',
        baselineSha: SHA,
        targetBranch: 'main',
        sourceBranch: 'agent/case-rfc337',
        remoteHeadSha: TARGET_SHA,
        state: 'published',
      },
    })

    expect(projection.workspace).toEqual({
      repositoryRef: 'repo-1',
      cachedRepositoryRef: 'cached-repo-1',
      baselineSha: SHA,
      targetBranch: 'main',
      sourceBranch: 'agent/case-rfc337',
      remoteHeadSha: TARGET_SHA,
      state: 'published',
    })
    expect(projection.changeCandidate).toMatchObject({
      status: 'published',
      summary: 'Fix the broken detail view',
      changedPaths: ['packages/frontend/src/routes/detail.tsx'],
      commitSha: TARGET_SHA,
    })
    expect(projection.delivery).toMatchObject({
      ref: 'github:owner/repo#42',
      webUrl: 'https://github.example/owner/repo/pull/42',
      sourceBranch: 'agent/case-rfc337',
      targetBranch: 'main',
      readyToMerge: true,
      relatedRegionRefs: ['care'],
      relatedWorkItemRefs: ['publish-mr', 'observe-mr', 'evaluate-ready'],
    })
  })

  test('degrades an unsupported historical Context to an explicit unknown input', () => {
    const projection = projectDevelopmentEmployeeCaseDetail({
      snapshot: snapshot('scheduled', [
        context(
          'context-issue',
          'development.issue-handling',
          issueRequest({ kind: 'body', body: 'old', externalId: null }),
          1,
          2,
        ),
      ]),
      workspace: null,
    })
    expect(projection.input).toMatchObject({
      source: 'scheduled',
      ingressRef: null,
      kind: 'unknown',
      body: null,
    })
  })

  test('deduplicates artifact refs while preserving every context, round, and Session source', () => {
    const detailInput: EmployeeCaseDetailProjectionV1['input'] = {
      source: 'manual',
      ingressRef: 'ui-input:direct',
      kind: 'files',
      subjectRef: 'case-rfc337',
      repositoryRef: 'repo-1',
      body: null,
      externalId: null,
      uploads: [
        {
          artifactRef: 'artifact:shared',
          originalName: 'request.md',
          placement: 'repository',
          targetPath: 'inputs/request.md',
        },
      ],
      executionOptions: {},
      advancedOptions: {},
    }
    expect(
      projectEmployeeCaseArtifacts({
        detailInput,
        contexts: [
          { id: 'context-1', artifactRefs: ['artifact:shared', 'artifact:context-only'] },
          { id: 'context-2', artifactRefs: ['artifact:shared'] },
        ],
        rounds: [
          {
            id: 'round-1',
            executionRef: 'session-1',
            outputJson: JSON.stringify({
              artifactRefs: ['artifact:shared', 'artifact:round-only'],
            }),
          },
        ],
      }),
    ).toEqual([
      {
        ref: 'artifact:shared',
        sources: [
          { kind: 'input' },
          { kind: 'context', contextId: 'context-1' },
          { kind: 'context', contextId: 'context-2' },
          { kind: 'round', roundId: 'round-1', executionRef: 'session-1' },
        ],
      },
      {
        ref: 'artifact:context-only',
        sources: [{ kind: 'context', contextId: 'context-1' }],
      },
      {
        ref: 'artifact:round-only',
        sources: [{ kind: 'round', roundId: 'round-1', executionRef: 'session-1' }],
      },
    ])
  })
})
