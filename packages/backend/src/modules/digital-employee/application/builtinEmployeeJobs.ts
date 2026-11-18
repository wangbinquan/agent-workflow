// RFC-505 (RFC-294 S10 step 12): the built-in job template seeding use case, moved verbatim out of
// composition/builtinJobTemplates.ts (the process clock is now passed in). The composition entry
// wires the authoring persistence, the publish command and the clock.
import { canonicalJson } from '@agent-workflow/shared'
import { employeeJobTemplateContentSchema } from '../domain/model'
import type { DigitalEmployeeAuthoringPersistence } from './ports/authoringStore'

export interface BuiltinEmployeeJobsDependencies {
  readonly store: Pick<DigitalEmployeeAuthoringPersistence, 'getJobTemplate' | 'createJobTemplate'>
  readonly publish: (input: {
    id: string
    actorUserId: null
  }) => Promise<{ id: string; revision: number }>
  readonly now: () => number
}

/** Code-owned default jobs use the same publish validation as authored jobs. */
export function createBuiltinEmployeeJobs(deps: BuiltinEmployeeJobsDependencies) {
  const { store, publish } = deps
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
      const now = deps.now()
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
          createdAt: deps.now(),
          updatedAt: deps.now(),
          archivedAt: null,
        })
      return existing?.publishedRevision
        ? { id: input.id, revision: existing.publishedRevision }
        : await publish({ id: input.id, actorUserId: null })
    },
  }
}
