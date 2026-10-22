import { z } from 'zod'

const objectId = z.string().regex(/^[a-f0-9]{40,64}$/)

/** An unborn repository is explicit; its checkout anchor is not a business parent. */
export const RepositoryContentBaselineSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('commit'), commitSha: objectId, treeOid: objectId }).strict(),
  z
    .object({
      kind: z.literal('unborn'),
      targetBranch: z.string().min(1),
      emptyTreeOid: objectId,
      materializationCommitSha: objectId,
    })
    .strict(),
])

export type RepositoryContentBaseline = z.infer<typeof RepositoryContentBaselineSchema>

export function repositoryMaterializationCommit(baseline: RepositoryContentBaseline): string {
  return baseline.kind === 'commit' ? baseline.commitSha : baseline.materializationCommitSha
}

export function repositoryBusinessParent(baseline: RepositoryContentBaseline): string | null {
  return baseline.kind === 'commit' ? baseline.commitSha : null
}
