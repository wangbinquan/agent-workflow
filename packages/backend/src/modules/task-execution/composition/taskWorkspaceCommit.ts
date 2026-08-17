// RFC-308 — task-execution owns the authority handed to code-capability;
// source-control owns every Git mechanism behind it.

import type { TaskWorkspaceCommitParticipant } from '../public/participants'
import type {
  RepositoryCommitCandidateParticipant,
  RepositoryCommitPublicationParticipant,
} from '@/modules/source-control/public/participants'

export function bindTaskWorkspaceCommitParticipant(input: {
  candidate: RepositoryCommitCandidateParticipant
  publication: RepositoryCommitPublicationParticipant
}): TaskWorkspaceCommitParticipant {
  const { candidate, publication } = input

  return Object.freeze({
    async preview() {
      const result = await candidate.preview()
      return result.ok
        ? {
            ok: true as const,
            diff: result.diff,
            policyDigest: result.receipt.policyDigest,
            excludedPaths: result.receipt.excludedPaths,
          }
        : result
    },
    async freeze(request: {
      message: string
      keepRef: string
      authorName?: string
      authorEmail?: string
    }) {
      const prepared = await candidate.prepare()
      if (!prepared.ok)
        return { ok: false as const, reason: 'failed' as const, error: prepared.error }
      const committed = await candidate.commitPrepared({
        message: request.message,
        verification: 'artifact',
        ...(request.authorName !== undefined ? { authorName: request.authorName } : {}),
        ...(request.authorEmail !== undefined ? { authorEmail: request.authorEmail } : {}),
      })
      if (!committed.ok) {
        return committed.reason === 'no-changes'
          ? {
              ok: false as const,
              reason: 'no-changes' as const,
              policyDigest: prepared.receipt.policyDigest,
              excludedPaths: prepared.receipt.excludedPaths,
            }
          : committed
      }
      const kept = await publication.updateRef({
        ref: request.keepRef,
        commitSha: committed.commitSha,
      })
      if (!kept.ok) return { ok: false as const, reason: 'failed' as const, error: kept.error }
      return {
        ok: true as const,
        commitSha: committed.commitSha,
        policyDigest: prepared.receipt.policyDigest,
        excludedPaths: prepared.receipt.excludedPaths,
      }
    },
    publish(request: {
      mode: 'cas' | 'new'
      baseSha: string
      tipSha: string
      remote: string
      branch: string
    }) {
      return publication.publish({
        baseSha: request.baseSha,
        tipSha: request.tipSha,
        mode:
          request.mode === 'cas'
            ? {
                kind: 'cas',
                remote: request.remote,
                branch: request.branch,
                expectedRemoteSha: request.baseSha,
              }
            : { kind: 'new', remote: request.remote, branch: request.branch },
      })
    },
    release: (request: { ref: string }) => publication.updateRef({ ref: request.ref }),
  })
}
