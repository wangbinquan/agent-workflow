// RFC-368 —— `employee_reaction_artifacts` 的存取（content-addressed，一张表两种 kind）。

import { tablesOf } from '@/platform/persistence/sessionTables'
import { first } from '@/platform/persistence/queryHelpers'
import { eq } from 'drizzle-orm'

import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import type { ReactionArtifactPersistence } from '../application/ports/reactionArtifacts'
import { parseReactionArtifactRef, reactionArtifactRef } from '../domain/reactionArtifacts'

export function createReactionArtifactPersistence(db: PersistenceDb): ReactionArtifactPersistence {
  const persistence: ReactionArtifactPersistence = {
    async put(kind, text, now) {
      const { employeeReactionArtifacts } = tablesOf(db)
      await db
        .insert(employeeReactionArtifacts)
        .values({
          digest: text.digest,
          kind,
          body: text.body,
          bytes: Buffer.byteLength(text.body, 'utf8'),
          createdAt: now,
        })
        .onConflictDoNothing({ target: employeeReactionArtifacts.digest })
      return reactionArtifactRef(kind, text.digest)
    },

    async read(ref) {
      const parsed = parseReactionArtifactRef(ref)
      if (parsed === null) return null
      const { employeeReactionArtifacts } = tablesOf(db)
      const row = await first(
        db
          .select({ body: employeeReactionArtifacts.body })
          .from(employeeReactionArtifacts)
          // 只按 digest 取：digest 是正文的 sha256，同一段正文先被存成另一种 kind 时主键冲突
          // 不新增行，但正文逐字相同——按 kind 再过滤反而会把它读成「不存在」。
          .where(eq(employeeReactionArtifacts.digest, parsed.digest)),
      )
      return row?.body ?? null
    },
  }
  return Object.freeze(persistence)
}
