import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { canonicalJson } from '@agent-workflow/shared'
import { createDigitalEmployeeAuthoringPersistence } from '../infrastructure/authoringStore'
import { employeeJobTemplateContentSchema } from '../domain/model'

/** Code-owned default jobs use the same publish validation as authored jobs. */
export function composeBuiltinEmployeeJobs(
  db: PersistenceDb,
  publish: (input: { id: string; actorUserId: null }) => Promise<{ id: string; revision: number }>,
) {
  const store = createDigitalEmployeeAuthoringPersistence(db)
  return {
    async ensure(input: { id: string; name: string; content: unknown }) {
      const content = employeeJobTemplateContentSchema.parse(input.content)
      const existing = await store.getJobTemplate(input.id)
      if (
        existing &&
        (existing.ownerUserId !== null || canonicalJson(existing.draft) !== canonicalJson(content))
      )
        throw new Error(`builtin-employee-job-content-conflict:${input.id}`)
      if (!existing)
        await store.createJobTemplate({
          id: input.id,
          typeRef: content.typeRef,
          name: input.name,
          draft: content,
          publishedRevision: null,
          ownerUserId: null,
          visibility: 'public',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          archivedAt: null,
        })
      return existing?.publishedRevision
        ? { id: input.id, revision: existing.publishedRevision }
        : await publish({ id: input.id, actorUserId: null })
    },
  }
}
