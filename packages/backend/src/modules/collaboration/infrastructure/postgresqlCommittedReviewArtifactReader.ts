import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { and, eq, inArray } from 'drizzle-orm'
import { collaborationGateArtifacts, collaborationGateOperations } from '@/db/schema'
import type { PostgresqlDatabaseClient } from '@/platform/persistence/postgresqlDatabaseClient'
import { sha256Hex } from '@/util/hash'
import type { CommittedReviewArtifactReader } from '../application/ports/committedReviewArtifactReader'
import { HumanGateOperationError } from '../domain/humanGateOperation'

function absolutePath(appHome: string, relativePath: string): string {
  return join(appHome, ...relativePath.split('/'))
}

function readVerified(path: string, sha256: string, byteSize: number): string {
  const body = readFileSync(path)
  if (sha256Hex(body) !== sha256 || body.byteLength !== byteSize) {
    throw new HumanGateOperationError(
      'human-gate-artifact-digest-mismatch',
      `human-gate artifact content does not match its journal: ${path}`,
      { expectedBytes: byteSize, actualBytes: body.byteLength },
    )
  }
  return body.toString('utf8')
}

export class PostgresqlCommittedReviewArtifactReader implements CommittedReviewArtifactReader {
  constructor(
    private readonly db: PostgresqlDatabaseClient,
    private readonly appHome: string,
  ) {}

  async read(finalPath: string): Promise<string> {
    const rows = await this.db
      .select({
        stagedPath: collaborationGateArtifacts.stagedPath,
        sha256: collaborationGateArtifacts.sha256,
        byteSize: collaborationGateArtifacts.byteSize,
      })
      .from(collaborationGateArtifacts)
      .innerJoin(
        collaborationGateOperations,
        eq(collaborationGateOperations.id, collaborationGateArtifacts.operationId),
      )
      .where(
        and(
          eq(collaborationGateArtifacts.finalPath, finalPath),
          inArray(collaborationGateArtifacts.state, ['consumed', 'finalized']),
          inArray(collaborationGateOperations.state, ['committed', 'completed']),
        ),
      )
      .limit(1)
    const artifact = rows[0]
    const final = absolutePath(this.appHome, finalPath)
    if (existsSync(final)) {
      return artifact === undefined
        ? readFileSync(final, 'utf8')
        : readVerified(final, artifact.sha256, artifact.byteSize)
    }
    if (artifact !== undefined) {
      const staged = absolutePath(this.appHome, artifact.stagedPath)
      if (existsSync(staged)) return readVerified(staged, artifact.sha256, artifact.byteSize)
    }
    throw new HumanGateOperationError(
      'human-gate-artifact-missing',
      `review body file not found: ${finalPath}`,
    )
  }
}
