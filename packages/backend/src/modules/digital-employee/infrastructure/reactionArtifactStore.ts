// RFC-368 —— `employee_reaction_artifacts` 的存取（content-addressed，一张表两种 kind）。

import { eq } from 'drizzle-orm'

import type { ProviderNeutralDatabase } from '@/db/query'
import { employeeReactionArtifacts } from '@/db/schema'
import type { ReactionArtifactPersistence } from '../application/ports/reactionArtifacts'
import { parseReactionArtifactRef, reactionArtifactRef } from '../domain/reactionArtifacts'

export function createReactionArtifactPersistence(
  db: ProviderNeutralDatabase,
): ReactionArtifactPersistence {
  const persistence: ReactionArtifactPersistence = {
    async put(kind, text, now) {
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
        .run()
      return reactionArtifactRef(kind, text.digest)
    },

    async read(ref) {
      const parsed = parseReactionArtifactRef(ref)
      if (parsed === null) return null
      const row = await db
        .select({ body: employeeReactionArtifacts.body })
        .from(employeeReactionArtifacts)
        // 只按 digest 取：digest 是正文的 sha256，同一段正文先被存成另一种 kind 时主键冲突
        // 不新增行，但正文逐字相同——按 kind 再过滤反而会把它读成「不存在」。
        .where(eq(employeeReactionArtifacts.digest, parsed.digest))
        .get()
      return row?.body ?? null
    },
  }
  return Object.freeze(persistence)
}
