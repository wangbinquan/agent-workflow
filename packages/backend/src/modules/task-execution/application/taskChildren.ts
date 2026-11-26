import { TaskChildrenPageSchema } from '@agent-workflow/shared'
import { z } from 'zod'
import { ValidationError } from '@/platform/errors/domainErrors'
import type { TaskChildrenQuery, TaskChildrenRead } from './ports/taskChildren'

const CursorSchema = z
  .object({
    v: z.literal(1),
    parentTaskId: z.string().min(1),
    userId: z.string(),
    canReadAllTasks: z.boolean(),
    startedAt: z.number().int().nonnegative().safe(),
    id: z.string().min(1),
  })
  .strict()

function decodeCursor(raw: string) {
  try {
    const bytes = Buffer.from(raw, 'base64url')
    if (bytes.toString('base64url') !== raw) throw new Error('noncanonical cursor')
    return CursorSchema.parse(JSON.parse(bytes.toString('utf8')))
  } catch {
    throw new ValidationError('task-children-cursor-invalid', 'invalid task children cursor')
  }
}

export function createTaskChildrenQuery(read: TaskChildrenRead): TaskChildrenQuery {
  return {
    async list(viewer, input) {
      if (input.parentTaskId.length === 0)
        throw new ValidationError('task-filter-invalid', 'parent task id must not be empty')
      const rawLimit = input.limit ?? '100'
      const limit = Number(rawLimit)
      if (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200)
        throw new ValidationError('task-filter-invalid', 'limit must be an integer from 1 to 200')
      const cursor = input.cursor === undefined ? null : decodeCursor(input.cursor)
      if (
        cursor !== null &&
        (cursor.parentTaskId !== input.parentTaskId ||
          cursor.userId !== viewer.userId ||
          cursor.canReadAllTasks !== viewer.canReadAllTasks)
      )
        throw new ValidationError(
          'task-children-cursor-invalid',
          'cursor does not match this query',
        )
      const rows = await read.page({
        parentTaskId: input.parentTaskId,
        viewer,
        take: limit + 1,
        after: cursor,
      })
      const visible = rows.slice(0, limit)
      const last = visible.at(-1)
      const nextCursor =
        rows.length > limit && last !== undefined
          ? Buffer.from(
              JSON.stringify({
                v: 1,
                parentTaskId: input.parentTaskId,
                ...viewer,
                startedAt: last.startedAt,
                id: last.id,
              }),
            ).toString('base64url')
          : null
      return TaskChildrenPageSchema.parse({
        schemaVersion: 1,
        parentTaskId: input.parentTaskId,
        items: visible.map(({ id, status }) => ({ id, status })),
        nextCursor,
      })
    },
  }
}
