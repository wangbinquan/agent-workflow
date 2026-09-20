import {
  canonicalJson,
  PlannedDirectoryNodeSchema,
  PlannedRepoSchema,
} from '@agent-workflow/shared'
import { z } from 'zod'
import { sha256Hex } from '@/util/hash'
import type { CachedRepositoryRecord } from '../ports/repositoryWorkspaceStore'

/** Content configuration identity. Cache paths, fetch clocks and secrets are not revisions. */
export function repositoryPreparationRevision(
  row: Pick<CachedRepositoryRecord, 'id' | 'urlHash' | 'defaultBranch'>,
): string {
  return `sha256:${sha256Hex(canonicalJson({ version: 1, id: row.id, source: row.urlHash, defaultBranch: row.defaultBranch }))}`
}

const repository = z
  .object({
    id: z.string(),
    revision: z.string(),
    urlHash: z.string(),
    defaultBranch: z.string().nullable(),
  })
  .strict()
export const SealedRepositorySourceFactsSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('public-url'),
    cachedRepoId: z.string(),
    requestedRef: z.string().nullable(),
    // SC-private original source. No raw source is returned by a public port.
    url: z.string(),
  })
  .strict()
export const RepositoryPreparationFactsSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(['repository', 'repository-group']),
    repositories: z.array(repository),
    groups: z.array(
      z.object({ id: z.string(), version: z.number().int(), name: z.string() }).strict(),
    ),
    layout: z
      .object({ repos: z.array(PlannedRepoSchema), nodes: z.array(PlannedDirectoryNodeSchema) })
      .strict(),
    groupName: z.string().nullable(),
  })
  .strict()
export type RepositoryPreparationFacts = z.infer<typeof RepositoryPreparationFactsSchema>
export function repositoryPreparationFactsJson(facts: RepositoryPreparationFacts): string {
  return canonicalJson(RepositoryPreparationFactsSchema.parse(facts))
}
