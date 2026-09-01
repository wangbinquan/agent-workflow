import type { DbClient } from '@/db/client'
import type { CommittedReviewArtifactReader } from '../application/ports/committedReviewArtifactReader'
import { readCommittedReviewArtifactBody } from './fsHumanGateArtifactStore'

export class SqliteCommittedReviewArtifactReader implements CommittedReviewArtifactReader {
  constructor(
    private readonly db: DbClient,
    private readonly appHome: string,
  ) {}

  async read(finalPath: string): Promise<string> {
    return readCommittedReviewArtifactBody(this.db, this.appHome, finalPath)
  }
}
