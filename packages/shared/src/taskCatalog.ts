import { z } from 'zod'

import { TASK_SOURCE_IDS } from './taskCreation'
import { FailureCodeSchema, TaskStatusSchema } from './schemas/task'
import { OwnerIdentitySchema } from './schemas/user'

export const TaskSourceIdSchema = z.enum(TASK_SOURCE_IDS)

const TaskCatalogLocalizedTextSchema = z
  .object({
    'zh-CN': z.string().min(1),
    'en-US': z.string().min(1),
  })
  .strict()

export const TaskCatalogListItemSchema = z
  .object({
    id: z.string().min(1),
    sourceId: TaskSourceIdSchema,
    title: z.string().min(1),
    subject: z
      .object({
        resourceId: z.string().min(1).nullable(),
        label: TaskCatalogLocalizedTextSchema,
      })
      .strict(),
    targetLabel: z.string().nullable(),
    status: TaskStatusSchema,
    statusDetail: TaskCatalogLocalizedTextSchema.nullable(),
    startedAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    finishedAt: z.number().int().nonnegative().nullable(),
    executionClock: z
      .object({
        runningMs: z.number().int().nonnegative(),
        runningSince: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    ownerUserId: z.string().nullable(),
    owner: OwnerIdentitySchema.nullable(),
    ownerLabel: z.string().nullable(),
    errorSummary: z.string().nullable(),
    failureCode: FailureCodeSchema.nullable(),
    childCount: z.number().int().nonnegative(),
    repositoryCount: z.number().int().nonnegative(),
    scheduledTaskId: z.string().nullable(),
    openAlertCount: z.number().int().nonnegative(),
    hierarchy: z
      .object({
        parentItemId: z.string().nullable(),
        invocationDepth: z.number().int().nonnegative(),
        matchKind: z.enum(['self', 'context']),
        parentAvailability: z.enum(['none', 'visible', 'unavailable']),
        qualifyingChildCount: z.number().int().nonnegative(),
        matchingDescendantCount: z.number().int().nonnegative(),
        branchStartedAt: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
export type TaskCatalogListItem = z.infer<typeof TaskCatalogListItemSchema>

export const TaskCatalogPageSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceIds: z.array(TaskSourceIdSchema),
    items: z.array(TaskCatalogListItemSchema),
    nextCursor: z.string().min(1).nullable(),
    facets: z
      .object({
        all: z.number().int().nonnegative(),
        active: z.number().int().nonnegative(),
        attention: z.number().int().nonnegative(),
        finished: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
export type TaskCatalogPage = z.infer<typeof TaskCatalogPageSchema>

export const TaskCatalogSourcesDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    sources: z.array(
      z
        .object({
          id: TaskSourceIdSchema,
          order: z.number().int(),
          catalogPath: z.string().startsWith('/'),
          labelKey: z.string().min(1),
          descriptionKey: z.string().min(1),
          creationPermission: z.string().min(1),
          listPermission: z.string().min(1),
          detailPath: z.string().startsWith('/'),
        })
        .strict(),
    ),
  })
  .strict()
export type TaskCatalogSourcesDocument = z.infer<typeof TaskCatalogSourcesDocumentSchema>

/** Source-owned runtime projection normalized by the task catalog adapter. */
export const DigitalEmployeeTaskPageSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: z.string().min(1),
          revision: z.number().int().positive(),
          state: z.enum(['active', 'waiting', 'blocked', 'terminal']),
          terminalKind: z.string().nullable(),
          blockReason: z.string().nullable(),
          employeeRef: z.object({ id: z.string().min(1), revision: z.number().int().positive() }),
          employeeName: z.string().min(1),
          typeRef: z.object({ typeId: z.string().min(1), revision: z.number().int().positive() }),
          typeName: TaskCatalogLocalizedTextSchema,
          taskName: z.string().min(1),
          subjectRef: z.string().min(1),
          targetRef: z.string().nullable(),
          currentWorkItemRef: z.string().nullable(),
          currentWorkItemName: TaskCatalogLocalizedTextSchema.nullable(),
          activeRound: z
            .object({
              id: z.string().min(1),
              state: z.string().min(1),
              workItemRef: z.string().min(1),
              attemptOrdinal: z.number().int().nonnegative(),
            })
            .strict()
            .nullable(),
          pendingEventCount: z.number().int().nonnegative(),
          openChannelCount: z.number().int().nonnegative(),
          createdAt: z.number().int().nonnegative(),
          updatedAt: z.number().int().nonnegative(),
        })
        .strict(),
    ),
    nextCursor: z.string().min(1).nullable(),
    facets: z
      .object({
        all: z.number().int().nonnegative(),
        active: z.number().int().nonnegative(),
        attention: z.number().int().nonnegative(),
        finished: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict()
export type DigitalEmployeeTaskPage = z.infer<typeof DigitalEmployeeTaskPageSchema>
export type DigitalEmployeeTaskListItem = DigitalEmployeeTaskPage['items'][number]
