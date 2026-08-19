// RFC-310 PR-4 T46 —— capability semantic validator（design.md §7.5 步骤 4）。
//
// 纯数据校验：envelope 声称的语义必须与 input manifest / 平台闭集对拍——
//   - feedback：输入的每个 (threadRef, revision) 恰好一个 disposition；
//     未输入或旧 revision 一律拒（closed set 双射）；
//   - pipeline/verification repair：issue/failure ref 必须落在当前 bundle 闭集；
//   - conflict repair：只能声称平台标记的 conflict path；
//   - requirement coverage：与 requirement index 恰好一一对应；
//   - read-only capability 不得使用 `changed`（文件层的兜底在 workspace
//     validator；这里先在语义层拒 envelope 本身）。
// 文件系统层面的 overlay 一致性（§7.5 步骤 5-7）不在本文件——见
// infrastructure/workspaceValidator.ts。

import { capabilityDefinition, type CapabilityId } from '../../domain/capabilityDefinition'
import type { AgentInputManifestV1 } from '../../domain/agentInputManifest'
import type { AgentOutcomeEnvelope } from '../../domain/agentEnvelope'

export interface SemanticRejection {
  readonly code:
    | 'read-only-cannot-change'
    | 'validator-input-missing'
    | 'feedback-unknown-thread'
    | 'feedback-missing-disposition'
    | 'feedback-duplicate-thread'
    | 'coverage-unknown-item'
    | 'coverage-missing-item'
    | 'coverage-duplicate-item'
    | 'issue-ref-outside-bundle'
    | 'failure-ref-outside-bundle'
    | 'conflict-path-outside-markers'
    | 'question-duplicate-id'
    | 'write-capability-cannot-use-completed'
    | 'read-only-must-use-completed'
    | 'module-ref-outside-catalog'
    | 'analysis-empty-modules'
    | 'review-candidate-mismatch'
    | 'review-finding-duplicate'
    | 'problem-producer-mismatch'
    | 'problem-evidence-mismatch'
    | 'problem-type-outside-catalog'
    | 'problem-subject-outside-evidence'
    | 'problem-subject-missing'
    | 'problem-ref-duplicate'
    | 'approval-step-mismatch'
    | 'approval-type-mismatch'
    | 'approval-evidence-outside-input'
    | 'approval-scope-outside-input'
  readonly jsonPointer: string | null
  readonly expected: string | null
  readonly observedSummary: string
}

export type SemanticVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly rejection: SemanticRejection }

/** 平台闭集（bundle manifest / inspector 侧解析后注入；不进 prompt）。 */
export interface SemanticClosedRefs {
  readonly requirementItemRefs?: readonly string[]
  readonly pipelineIssueRefs?: readonly string[]
  readonly conflictPaths?: readonly string[]
  /** PR-5 T54：repository module catalog（analyze 的 affectedModuleRefs 闭集）。 */
  readonly repositoryModuleIds?: readonly string[]
  /** PR-5 T58：当前 candidate 的 receipt digest（review 对拍锚）。 */
  readonly candidateRef?: string
}

function fail(
  code: SemanticRejection['code'],
  observedSummary: string,
  extras: { readonly jsonPointer?: string | null; readonly expected?: string | null } = {},
): SemanticVerdict {
  return {
    ok: false,
    rejection: {
      code,
      jsonPointer: extras.jsonPointer ?? null,
      expected: extras.expected ?? null,
      observedSummary: observedSummary.slice(0, 500),
    },
  }
}

export function runCapabilitySemanticValidator(input: {
  readonly manifest: AgentInputManifestV1
  readonly envelope: AgentOutcomeEnvelope
  readonly closedRefs?: SemanticClosedRefs
}): SemanticVerdict {
  const { manifest, envelope } = input
  const closed = input.closedRefs ?? {}
  const definition = capabilityDefinition(manifest.capabilityId as CapabilityId)

  if (envelope.outcome === 'needs-information') {
    const seen = new Set<string>()
    for (const [index, q] of envelope.result.questions.entries()) {
      if (seen.has(q.questionId)) {
        return fail('question-duplicate-id', `questionId '${q.questionId}' appears twice`, {
          jsonPointer: `/result/questions/${index}/questionId`,
        })
      }
      seen.add(q.questionId)
    }
    return { ok: true }
  }

  // PR-5 T54 —— read-only 完成 outcome：write 能力不许用（双向：read-only 用
  // changed 在下方拒），analyze 的认知结论逐项对拍平台闭集。
  if (envelope.outcome === 'completed') {
    if (definition.workspaceMode !== 'read-only') {
      return fail(
        'write-capability-cannot-use-completed',
        `capability '${manifest.capabilityId}' is ${definition.workspaceMode}; 'completed' is reserved for read-only capabilities`,
        { jsonPointer: '/outcome', expected: 'changed | no-change | needs-information | blocked' },
      )
    }
    const result = envelope.result
    if (result.capabilityId === 'requirement.analyze') {
      const closedItems = closed.requirementItemRefs
      if (closedItems === undefined) {
        return fail('validator-input-missing', 'requirement item index was not provided')
      }
      const expectedSet = new Set(closedItems)
      const seen = new Set<string>()
      for (const [index, row] of result.requirementCoverage.entries()) {
        if (!expectedSet.has(row.itemRef)) {
          return fail('coverage-unknown-item', `itemRef '${row.itemRef}' is not in the index`, {
            jsonPointer: `/result/requirementCoverage/${index}/itemRef`,
          })
        }
        if (seen.has(row.itemRef)) {
          return fail('coverage-duplicate-item', `itemRef '${row.itemRef}' covered twice`, {
            jsonPointer: `/result/requirementCoverage/${index}/itemRef`,
          })
        }
        seen.add(row.itemRef)
      }
      for (const itemRef of closedItems) {
        if (!seen.has(itemRef)) {
          return fail('coverage-missing-item', `itemRef '${itemRef}' has no disposition`, {
            jsonPointer: '/result/requirementCoverage',
          })
        }
      }
      const moduleCatalog = closed.repositoryModuleIds
      if (moduleCatalog === undefined) {
        return fail('validator-input-missing', 'repository module catalog was not provided')
      }
      const catalogSet = new Set(moduleCatalog)
      for (const [index, moduleRef] of result.affectedModuleRefs.entries()) {
        if (!catalogSet.has(moduleRef)) {
          return fail(
            'module-ref-outside-catalog',
            `module '${moduleRef}' is not in the repository module catalog`,
            { jsonPointer: `/result/affectedModuleRefs/${index}` },
          )
        }
      }
      if (result.scopeDisposition === 'ready' && result.affectedModuleRefs.length === 0) {
        return fail(
          'analysis-empty-modules',
          "scopeDisposition 'ready' with no affected modules is not an analysis",
          { jsonPointer: '/result/affectedModuleRefs' },
        )
      }
    }
    if (result.capabilityId === 'change.review') {
      // T58：审阅锚必须是当前 candidate——陈旧树的 findings 整体无效。
      const anchor = closed.candidateRef
      if (anchor === undefined) {
        return fail('validator-input-missing', 'current candidate ref was not provided')
      }
      if (result.reviewedCandidateRef !== anchor) {
        return fail(
          'review-candidate-mismatch',
          `review anchored to '${result.reviewedCandidateRef}'`,
          { jsonPointer: '/result/reviewedCandidateRef', expected: anchor },
        )
      }
      const seenFindings = new Set<string>()
      for (const [index, finding] of result.findings.entries()) {
        if (seenFindings.has(finding.findingId)) {
          return fail('review-finding-duplicate', `findingId '${finding.findingId}' repeated`, {
            jsonPointer: `/result/findings/${index}/findingId`,
          })
        }
        seenFindings.add(finding.findingId)
      }
    }
    if (result.capabilityId === 'problem.classify') {
      const evidence = manifest.problemEvidence
      if (evidence === undefined) {
        return fail('validator-input-missing', 'problem evidence descriptor was not provided')
      }
      if (result.producerId !== evidence.producerId) {
        return fail('problem-producer-mismatch', `producer '${result.producerId}'`, {
          expected: evidence.producerId,
          jsonPointer: '/result/producerId',
        })
      }
      if (
        result.evidenceDigest !== evidence.evidenceDigest ||
        result.headSha !== evidence.headSha
      ) {
        return fail(
          'problem-evidence-mismatch',
          'problem result is not bound to the exact evidence/head',
        )
      }
      const allowedTypes = new Set(evidence.allowedTypeIds)
      const allowedSubjects = new Set(evidence.subjectRefs)
      const covered = new Set<string>()
      const problemRefs = new Set<string>()
      for (const [index, problem] of result.problems.entries()) {
        if (problemRefs.has(problem.problemRef)) {
          return fail('problem-ref-duplicate', `problemRef '${problem.problemRef}' repeated`, {
            jsonPointer: `/result/problems/${index}/problemRef`,
          })
        }
        problemRefs.add(problem.problemRef)
        if (!allowedTypes.has(problem.typeId)) {
          return fail('problem-type-outside-catalog', `typeId '${problem.typeId}' is not allowed`, {
            jsonPointer: `/result/problems/${index}/typeId`,
          })
        }
        for (const subject of problem.subjectRefs) {
          if (!allowedSubjects.has(subject)) {
            return fail(
              'problem-subject-outside-evidence',
              `subject '${subject}' is not an input`,
              {
                jsonPointer: `/result/problems/${index}/subjectRefs`,
              },
            )
          }
          covered.add(subject)
        }
      }
      if (result.complete) {
        const missing = evidence.requiredSubjectRefs.find((subject) => !covered.has(subject))
        if (missing !== undefined) {
          return fail(
            'problem-subject-missing',
            `required subject '${missing}' is not classified`,
            {
              jsonPointer: '/result/problems',
            },
          )
        }
      }
    }
    if (result.capabilityId === 'approval.prepare') {
      const context = manifest.approvalContext
      if (context === undefined) {
        return fail('validator-input-missing', 'approval context was not provided')
      }
      if (result.stepRunRef !== context.stepRunRef) {
        return fail('approval-step-mismatch', `step '${result.stepRunRef}'`, {
          expected: context.stepRunRef,
          jsonPointer: '/result/stepRunRef',
        })
      }
      if (result.approvalType !== context.approvalType) {
        return fail('approval-type-mismatch', `approval type '${result.approvalType}'`, {
          expected: context.approvalType,
          jsonPointer: '/result/approvalType',
        })
      }
      const evidence = new Set(context.evidenceRefs)
      const unknownEvidence = result.evidenceRefs.find((item) => !evidence.has(item))
      if (unknownEvidence !== undefined) {
        return fail(
          'approval-evidence-outside-input',
          `evidence '${unknownEvidence}' is not allowed`,
        )
      }
      const scopes = new Set(context.requestedScopes)
      const unknownScope = result.requestedScopes.find((item) => !scopes.has(item))
      if (unknownScope !== undefined) {
        return fail('approval-scope-outside-input', `scope '${unknownScope}' is not allowed`)
      }
    }
    return { ok: true }
  }

  if (envelope.outcome !== 'changed') return { ok: true }

  if (definition.workspaceMode === 'read-only' || definition.workspaceMode === 'none') {
    return fail(
      'read-only-cannot-change',
      `capability '${manifest.capabilityId}' is ${definition.workspaceMode}; it has no 'changed' outcome`,
      { jsonPointer: '/outcome', expected: 'no-change | needs-information | blocked' },
    )
  }

  const result = envelope.result
  switch (result.capabilityId) {
    case 'change.implement': {
      const closedItems = closed.requirementItemRefs
      if (closedItems === undefined) {
        return fail('validator-input-missing', 'requirement item index was not provided')
      }
      const expectedSet = new Set(closedItems)
      const seen = new Set<string>()
      for (const [index, row] of result.requirementCoverage.entries()) {
        if (!expectedSet.has(row.itemRef)) {
          return fail('coverage-unknown-item', `itemRef '${row.itemRef}' is not in the index`, {
            jsonPointer: `/result/requirementCoverage/${index}/itemRef`,
          })
        }
        if (seen.has(row.itemRef)) {
          return fail('coverage-duplicate-item', `itemRef '${row.itemRef}' covered twice`, {
            jsonPointer: `/result/requirementCoverage/${index}/itemRef`,
          })
        }
        seen.add(row.itemRef)
      }
      for (const itemRef of closedItems) {
        if (!seen.has(itemRef)) {
          return fail('coverage-missing-item', `itemRef '${itemRef}' has no disposition`, {
            jsonPointer: '/result/requirementCoverage',
            expected: 'exactly one disposition per requirement item',
          })
        }
      }
      return { ok: true }
    }
    case 'mr.feedback.apply': {
      const snapshot = manifest.feedbackSnapshot
      if (snapshot === null) {
        return fail('validator-input-missing', 'feedback snapshot was not provided in the manifest')
      }
      const key = (threadRef: string, revision: string): string => `${threadRef}\u0000${revision}`
      const expectedSet = new Set(snapshot.items.map((item) => key(item.threadRef, item.revision)))
      const seen = new Set<string>()
      for (const [index, row] of result.feedback.entries()) {
        const k = key(row.threadRef, row.revision)
        if (!expectedSet.has(k)) {
          return fail(
            'feedback-unknown-thread',
            `(threadRef '${row.threadRef}', revision '${row.revision}') was not an input thread revision`,
            { jsonPointer: `/result/feedback/${index}` },
          )
        }
        if (seen.has(k)) {
          return fail('feedback-duplicate-thread', `thread '${row.threadRef}' answered twice`, {
            jsonPointer: `/result/feedback/${index}`,
          })
        }
        seen.add(k)
      }
      if (seen.size !== expectedSet.size) {
        return fail(
          'feedback-missing-disposition',
          `${expectedSet.size - seen.size} input thread(s) have no disposition`,
          { jsonPointer: '/result/feedback', expected: 'one disposition per input thread' },
        )
      }
      return { ok: true }
    }
    case 'pipeline.repair': {
      const closedIssues = closed.pipelineIssueRefs
      if (closedIssues === undefined) {
        return fail('validator-input-missing', 'pipeline issue index was not provided')
      }
      const set = new Set(closedIssues)
      for (const [index, ref] of result.issueRefs.entries()) {
        if (!set.has(ref)) {
          return fail('issue-ref-outside-bundle', `issueRef '${ref}' is not in the bundle`, {
            jsonPointer: `/result/issueRefs/${index}`,
          })
        }
      }
      return { ok: true }
    }
    case 'verification.repair': {
      const evidence = manifest.verificationEvidence
      if (evidence === null) {
        return fail('validator-input-missing', 'verification evidence was not provided')
      }
      const set = new Set(evidence.failureRefs)
      for (const [index, ref] of result.failureRefs.entries()) {
        if (!set.has(ref)) {
          return fail('failure-ref-outside-bundle', `failureRef '${ref}' is not in the bundle`, {
            jsonPointer: `/result/failureRefs/${index}`,
          })
        }
      }
      return { ok: true }
    }
    case 'conflict.repair': {
      const conflictPaths = closed.conflictPaths
      if (conflictPaths === undefined) {
        return fail('validator-input-missing', 'conflict path markers were not provided')
      }
      const set = new Set(conflictPaths)
      for (const [index, ref] of result.conflictRefs.entries()) {
        if (!set.has(ref)) {
          return fail(
            'conflict-path-outside-markers',
            `conflictRef '${ref}' is not a platform-marked conflict path`,
            { jsonPointer: `/result/conflictRefs/${index}` },
          )
        }
      }
      return { ok: true }
    }
  }
}
