// RFC-507 (RFC-294 S10 step 14): graph design evidence, manual acceptance, verification requests and
// the published verification profile listings, moved verbatim out of the module's graph development
// assembly. The assembly builds the store, artifacts, commands, queries, profile persistence, the
// employee workspace and the delivery bridge and passes them in.
import {
  canonicalJson,
  GraphEvidenceBindingSchema,
  repositoryMaterializationCommit,
  type GraphImplementationBasis,
} from '@agent-workflow/shared'
import type {
  CandidateDeliveryParticipant,
  ChangeCandidateParticipant,
} from '@/modules/source-control/public/types'
import { staleGraphReads } from '../../domain/graph-development/model'
import type { VerificationProfilePersistence } from '../ports/configResourceStore'
import type { GraphDesignArtifacts } from '../ports/graphDesignArtifacts'
import type { GraphDesignCasePort } from '../ports/graphDesignExecution'
import type { GraphDesignStore } from '../ports/graphDesignStore'
import type { VerificationCommandEffectsFactory } from '../ports/verificationCommandEffects'
import type { GraphDesignCommands } from './designCommands'
import type { GraphDesignQueries } from './designQueries'
import type { GraphVerificationWorkspace } from './verification'

/** Published, unarchived verification profiles with their parsed content (the employee workspace's listing). */
export async function listGraphVerificationProfileContents(
  profiles: VerificationProfilePersistence,
) {
  return await Promise.all(
    (await profiles.list())
      .filter((profile) => profile.publishedRevision && !profile.archivedAt)
      .map(async (profile) => {
        const revision = (await profiles.getRevision(profile.id, profile.publishedRevision!))!
        return {
          id: profile.id,
          name: profile.name,
          revision: revision.revision,
          digest: revision.contentDigest,
          content: JSON.parse(revision.contentJson) as unknown,
        }
      }),
  )
}

export interface GraphEvidenceAcceptanceDependencies {
  readonly store: GraphDesignStore
  readonly artifacts: GraphDesignArtifacts
  readonly commands: GraphDesignCommands
  readonly queries: GraphDesignQueries
  readonly profiles: VerificationProfilePersistence
  readonly cases: GraphDesignCasePort
  readonly candidates: CandidateDeliveryParticipant & ChangeCandidateParticipant
  readonly verification: VerificationCommandEffectsFactory
  /** The delivery bridge's continuation workspace. */
  readonly continuationWorkspace: (
    designId: string,
  ) => Promise<(GraphVerificationWorkspace & { readonly remoteHeadSha: string | null }) | null>
  /** The employee workspace's current state. */
  readonly workspaceState: (designId: string) => Promise<GraphVerificationWorkspace>
  readonly changed?: (caseId: string) => void
}

export function createGraphEvidenceAcceptance(deps: GraphEvidenceAcceptanceDependencies) {
  const { store, artifacts, commands, queries, profiles } = deps
  async function latestVerification(id: string) {
    const record = (await store.records(id))
      .filter((row) => row.kind === 'verification' && row.status === 'completed')
      .sort((a, b) => b.createdAt - a.createdAt)[0]
    return record
      ? (JSON.parse(record.payloadJson) as {
          basisId: string
          basisDigest: string
          implementationRoundRef: string
          candidate: { treeOid: string }
          environmentDigest: string
          profileDigests: Record<string, string>
        })
      : null
  }
  async function currentEvidenceTarget(id: string) {
    const continuation = await deps.continuationWorkspace(id)
    const current = continuation ?? (await deps.workspaceState(id))
    // Publication advances the baseline to the verified commit. Deriving a new
    // delivery candidate then correctly reports no delta, but evidence still
    // needs the actual current tree, including any later workspace drift.
    const candidate = await deps.candidates.stage({
      baselineRepoPath: current.baselineRepoPath,
      baselineSha: repositoryMaterializationCommit(current.baseline),
      overlayRoot: current.workspacePath,
      uploadPlan: current.uploadPlan,
    })
    try {
      return {
        candidateTreeOid: candidate.ok ? candidate.treeOid : null,
        commitSha: continuation?.remoteHeadSha ?? null,
        environmentDigest:
          (await deps.verification.environment?.(current.workspacePath))?.digest ?? null,
      }
    } finally {
      if (candidate.ok) await candidate.cleanup()
    }
  }
  return {
    latestVerification,
    currentEvidenceTarget,
    async basis(id: string, basisId: string) {
      const value = await commands.basis(id, basisId)
      const document = await commands.document(id)
      return { ...value, staleIds: staleGraphReads(document, value.basis.readSet) }
    },
    async evidence(id: string) {
      const latest = await latestVerification(id)
      const links = await store.links(id)
      const delivery = links.filter((link) => link.id.startsWith('delivery:')).at(-1)
      const commitSha = delivery
        ? (JSON.parse(delivery.payloadJson) as { commitSha: string }).commitSha
        : null
      const currentProfiles: Record<string, string> = {}
      for (const profile of await profiles.list())
        if (profile.publishedRevision && !profile.archivedAt) {
          const digest =
            (await profiles.getRevision(profile.id, profile.publishedRevision))?.contentDigest ?? ''
          currentProfiles[profile.id] = digest
          currentProfiles[`${profile.id}@${profile.publishedRevision}`] = digest
        }
      // Approved work pins an immutable profile revision. Publishing or
      // archiving its resource does not silently replace or revoke that pin.
      for (const link of links.filter((link) => link.kind === 'evidence')) {
        const ref = GraphEvidenceBindingSchema.parse(JSON.parse(link.payloadJson)).profileRef
        if (ref)
          currentProfiles[`${ref.id}@${ref.revision}`] =
            (await profiles.getRevision(ref.id, ref.revision))?.contentDigest ?? ''
      }
      // A retained passing receipt describes an earlier tree. Read the active
      // workspace so a repair invalidates it even before the next verification.
      const current = latest ? await currentEvidenceTarget(id).catch(() => null) : null
      const projected = await queries.evidence(id, {
        basisDigest: latest?.basisDigest ?? null,
        candidateTreeOid: current?.candidateTreeOid ?? null,
        profileDigests: currentProfiles,
        environmentDigest: current?.environmentDigest ?? null,
        commitSha: current?.commitSha ?? commitSha,
      })
      const approvedBasis =
        latest && current?.candidateTreeOid === latest.candidate.treeOid
          ? await commands.basis(id, latest.basisId).catch(() => null)
          : null
      const candidate =
        approvedBasis &&
        staleGraphReads(await commands.document(id), approvedBasis.basis.readSet).length === 0
          ? {
              basisId: approvedBasis.basis.id,
              basisDigest: approvedBasis.basis.digest,
              candidateTreeOid: current!.candidateTreeOid!,
              obligationIds: approvedBasis.basis.obligationIds,
            }
          : null
      return { ...projected, candidate }
    },
    async verificationProfiles() {
      return await Promise.all(
        (await profiles.list())
          .filter((profile) => profile.publishedRevision && !profile.archivedAt)
          .map(async (profile) => {
            const revision = (await profiles.getRevision(profile.id, profile.publishedRevision!))!
            return {
              id: profile.id,
              name: profile.name,
              revision: revision.revision,
              digest: revision.contentDigest,
            }
          }),
      )
    },
    async accept(
      id: string,
      request: {
        requestId: string
        basisId: string
        candidateTreeOid: string
        obligationIds: string[]
        result: 'passed' | 'failed'
        comment: string
      },
      actorUserId: string,
    ) {
      const basis = (await commands.basis(id, request.basisId)).basis
      const current = await latestVerification(id)
      const target = await currentEvidenceTarget(id)
      if (
        !current ||
        current.basisDigest !== basis.digest ||
        current.candidate.treeOid !== request.candidateTreeOid ||
        target.candidateTreeOid !== request.candidateTreeOid ||
        staleGraphReads(await commands.document(id), basis.readSet).length > 0
      )
        throw new Error('graph-acceptance-candidate-mismatch')
      if (
        !request.obligationIds.length ||
        request.obligationIds.some(
          (id) =>
            !basis.obligationIds.includes(id) ||
            !basis.document.obligations.some(
              (obligation) => obligation.id === id && obligation.verification.kind === 'manual',
            ),
        )
      )
        throw new Error('graph-acceptance-obligation-invalid')
      const record = await commands.beginRecord(
        id,
        `acceptance:${request.requestId}`,
        'acceptance',
        { ...request, actorUserId },
      )
      if (record.status === 'completed') return JSON.parse(record.payloadJson) as unknown
      const artifact = await artifacts.put([
        {
          path: 'acceptance.json',
          content: canonicalJson({ ...request, actorUserId, recordedAt: record.createdAt }),
        },
      ])
      const evidence = GraphEvidenceBindingSchema.parse({
        id: `acceptance:${request.requestId}`,
        kind: 'acceptance',
        basisDigest: basis.digest,
        obligationIds: request.obligationIds,
        readSet: basis.readSet,
        candidateTreeOid: request.candidateTreeOid,
        commitSha: null,
        profileRef: null,
        environmentDigest: null,
        executionRef: null,
        artifactRef: artifact.artifactRef,
        artifactDigest: artifact.digest,
        ci: null,
        result: request.result,
        summary: request.comment,
        limitations: ['仅记录指定候选和范围的人工作出的验收判断。'],
        recordedAt: record.createdAt,
      })
      await store.insertLink({
        designId: id,
        id: evidence.id,
        kind: 'evidence',
        payloadJson: canonicalJson(evidence),
        createdAt: record.createdAt,
      })
      await commands.finishRecord(record, 'completed', evidence)
      deps.changed?.(basis.document.caseId)
      return evidence
    },
    async requestVerification(id: string, requestId: string) {
      const document = await commands.document(id)
      const payload = await artifacts.put([
        { path: 'request.json', content: canonicalJson({ requestId, designId: id }) },
      ])
      return await deps.cases.requestWork({
        caseId: document.caseId,
        requestId,
        kind: 'verification',
        payloadRef: payload,
        withdrawReview: false,
      })
    },
    async exportBasis(id: string, basisId: string): Promise<GraphImplementationBasis['files']> {
      return (await commands.basis(id, basisId)).basis.files
    },
  }
}
