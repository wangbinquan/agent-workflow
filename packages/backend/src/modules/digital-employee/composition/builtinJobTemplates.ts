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
    /** Setup templates are user-configurable after the first seed; restart never overwrites edits. */
    async ensureDraft(input: { id: string; name: string; content: unknown }) {
      const content = employeeJobTemplateContentSchema.parse(input.content)
      const existing = await store.getJobTemplate(input.id)
      if (existing) {
        if (
          existing.typeRef.typeId !== content.typeRef.typeId ||
          existing.typeRef.revision !== content.typeRef.revision
        )
          throw new Error(`builtin-employee-job-type-conflict:${input.id}`)
        return { id: existing.id, publishedRevision: existing.publishedRevision }
      }
      const now = Date.now()
      await store.createJobTemplate({
        id: input.id,
        typeRef: content.typeRef,
        name: input.name,
        draft: content,
        publishedRevision: null,
        ownerUserId: null,
        visibility: 'public',
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      })
      return { id: input.id, publishedRevision: null }
    },
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
