import type {
  EmployeeCaseDetailProjectionInputV1,
  EmployeeCaseDetailProjectionParticipant,
  EmployeeCaseDetailInputProjection,
} from '@/modules/digital-employee/public/types'

import type {
  DevelopmentEmployeeCaseWorkspaceDetailReader,
  DevelopmentEmployeeCaseWorkspaceDetailRow,
} from './digitalEmployeeWorkspace'
import {
  changeCandidateContextSchema,
  issueHandlingContextSchema,
  mergeRequestContextSchema,
} from './employeeTypePackage'

type DetailContext = EmployeeCaseDetailProjectionInputV1['contexts'][number]

function latestContext(
  contexts: readonly DetailContext[],
  typeId: string,
): DetailContext | undefined {
  return contexts
    .filter((context) => context.typeId === typeId)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0]
}

function parseVersionOneContext<T>(
  context: DetailContext | undefined,
  parse: (value: unknown) => T,
): T | null {
  if (context === undefined || context.schemaVersion !== 1) return null
  try {
    return parse(JSON.parse(context.stateJson) as unknown)
  } catch {
    // Historical or partially migrated Contexts remain inspectable through the
    // generic Context list. The normalized detail surface stays partial instead
    // of inventing values or making the whole Case unreadable.
    return null
  }
}

function unknownInput(
  input: EmployeeCaseDetailProjectionInputV1,
): EmployeeCaseDetailInputProjection {
  return {
    source: input.case.launchOrigin,
    ingressRef: null,
    kind: 'unknown',
    subjectRef: null,
    repositoryRef: null,
    body: null,
    externalId: null,
    uploads: [],
    executionOptions: {},
    advancedOptions: {},
  }
}

export function projectDevelopmentEmployeeCaseDetail(input: {
  readonly snapshot: EmployeeCaseDetailProjectionInputV1
  readonly workspace: DevelopmentEmployeeCaseWorkspaceDetailRow | null
}) {
  const issueContext = latestContext(input.snapshot.contexts, 'development.issue-handling')
  const issue = parseVersionOneContext(issueContext, (value) =>
    issueHandlingContextSchema.parse(value),
  )
  const candidate = parseVersionOneContext(
    latestContext(input.snapshot.contexts, 'development.change-candidate'),
    (value) => changeCandidateContextSchema.parse(value),
  )
  const mergeRequest = parseVersionOneContext(
    latestContext(input.snapshot.contexts, 'development.merge-request'),
    (value) => mergeRequestContextSchema.parse(value),
  )

  const eventDriven =
    input.snapshot.case.launchOrigin === 'event' || input.snapshot.case.launchOrigin === 'webhook'
  const detailInput: EmployeeCaseDetailInputProjection =
    issue === null
      ? unknownInput(input.snapshot)
      : {
          source: input.snapshot.case.launchOrigin,
          ingressRef: eventDriven
            ? 'issue'
            : issue.request.kind === 'external-id'
              ? 'ui-input:external-id'
              : 'ui-input:direct',
          kind: eventDriven ? 'event' : issue.request.kind,
          subjectRef: issue.subjectRef,
          repositoryRef: issue.repositoryRef,
          body: issue.request.body,
          externalId: issue.request.externalId,
          uploads: issue.request.uploads,
          executionOptions: issue.request.executionOptions,
          advancedOptions:
            issue.request.workingBranch === null
              ? {}
              : { 'working-branch': issue.request.workingBranch },
        }

  return {
    schemaVersion: 1 as const,
    input: detailInput,
    workspace:
      input.workspace === null
        ? null
        : {
            repositoryRef: input.workspace.repositoryId,
            cachedRepositoryRef: input.workspace.cachedRepoId,
            baselineSha: input.workspace.baselineSha,
            targetBranch: input.workspace.targetBranch,
            sourceBranch: input.workspace.sourceBranch,
            remoteHeadSha: input.workspace.remoteHeadSha,
            state: input.workspace.state,
          },
    changeCandidate:
      candidate === null
        ? null
        : {
            status: candidate.status,
            candidateRef: candidate.candidateRef,
            baselineSha: candidate.baselineSha,
            treeOid: candidate.treeOid,
            summary: candidate.summarySource,
            changedPaths: candidate.changedPaths,
            commitSha: candidate.commitSha,
          },
    delivery:
      mergeRequest === null
        ? null
        : {
            kind: 'merge-request',
            status: mergeRequest.status,
            ref: mergeRequest.mergeRequestRef,
            providerRef: mergeRequest.providerMrRef,
            webUrl: mergeRequest.webUrl,
            repositoryRef: mergeRequest.repositoryRef,
            sourceBranch: mergeRequest.sourceBranch,
            targetBranch: mergeRequest.targetBranch,
            headSha: mergeRequest.headSha,
            targetSha: mergeRequest.targetSha,
            mergedCommitSha: mergeRequest.mergedCommitSha,
            draft: mergeRequest.draft,
            mergeableState: mergeRequest.mergeableState,
            readyToMerge: mergeRequest.readyToMerge,
            approvalHold: mergeRequest.approvalHold,
            unresolvedReviewCount: mergeRequest.unresolvedReviewCount,
            relatedRegionRefs: ['care'],
            relatedWorkItemRefs: ['publish-mr', 'observe-mr', 'evaluate-ready'],
          },
  }
}

export function composeDevelopmentEmployeeCaseDetailProjection(
  workspaces: DevelopmentEmployeeCaseWorkspaceDetailReader,
): EmployeeCaseDetailProjectionParticipant {
  return {
    typeId: 'development',
    projectJson(inputJson) {
      const snapshot = JSON.parse(inputJson) as EmployeeCaseDetailProjectionInputV1
      return JSON.stringify(
        projectDevelopmentEmployeeCaseDetail({
          snapshot,
          workspace: workspaces.getByCaseId(snapshot.case.id),
        }),
      )
    },
  }
}
