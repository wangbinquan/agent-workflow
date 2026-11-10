// RFC-468 — the single-row mint entry for the deferred repository preparation (it mints its synthetic `__repo_prep__`
// row here; RFC-478 moved that caller from `services/task.ts` into `./deferredRepositoryPreparation.ts`), moved from
// `services/nodeRunMint.ts`. The body is
// unchanged: it hands the request to the lifecycle port of the legacy node-run operations, which resolve the record
// through the one `buildNodeRunMintRecord` and insert it through the shared mint program (no INSERT here; RFC-098
// grep guard). Callers that mint inside their own transaction use `createNodeRunMintParticipantInTx(tx)`.
import type { NodeRunMintInput } from '../application/ports/nodeRunLifecyclePersistence'
import {
  createLegacySqliteNodeRunOperations,
  type LegacySqliteNodeRunDatabase,
} from './legacySqliteNodeRunOperations'

/**
 * Mint one node_runs row. Returns the new ULID id.
 *
 * Resolution order per field: `overrides` ≻ `inheritFrom` ≻ default.
 */
export async function mintNodeRun(
  db: LegacySqliteNodeRunDatabase,
  args: NodeRunMintInput,
): Promise<string> {
  return await createLegacySqliteNodeRunOperations(db).lifecycle.mint(args)
}
