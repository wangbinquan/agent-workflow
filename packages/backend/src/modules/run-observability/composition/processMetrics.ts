// RFC-616 — the single assembly of process metrics. Roots inject the database,
// the fact implementations the owning contexts offer, and the model runner.

import type { Hono } from 'hono'
import type { ProcessInsightSchedule } from '@agent-workflow/shared'
import type {
  ProcessEmployeeFacts,
  ProcessGateFacts,
  ProcessSubjectEvents,
  ProcessTaskFacts,
  ProcessWorkgroupFacts,
} from '@/platform/contracts/processFacts'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import { createInsightAnalyses, type InsightAnalyses } from '../application/process/insightAnalyses'
import {
  createOperationRecorder,
  type OperationRecorder,
} from '../application/process/operationObservations'
import type {
  ProcessIdentityDirectory,
  ProcessWorkflowNames,
} from '../application/process/ports/directories'
import type { InsightRunner } from '../application/process/ports/insightRunner'
import { createProcessQueries, type ProcessQueries } from '../application/process/processQueries'
import { createProcessTexts } from '../application/process/processTexts'
import type { ProcessSources } from '../application/process/sources'
import { createSubjectActivity } from '../application/process/subjectActivity'
import { createCallPersistence } from '../infrastructure/callPersistence'
import { createInsightPersistence } from '../infrastructure/insightPersistence'
import { createOperationPersistence } from '../infrastructure/operationPersistence'
import { mountProcessRoutes } from '../inbound/http/processRoutes'

export type {
  ProcessIdentityDirectory,
  ProcessWorkflowNames,
} from '../application/process/ports/directories'

export interface ProcessMetrics {
  readonly queries: ProcessQueries
  readonly insights: InsightAnalyses
  mount(app: Hono): void
}

/** The write side alone: what the route registry needs to record human operations. */
export function composeOperationRecorder(input: {
  readonly db: PersistenceDb
  readonly writable?: () => boolean
}): OperationRecorder {
  return createOperationRecorder({
    store: createOperationPersistence(input.db),
    writable: input.writable,
  })
}

export function composeProcessMetrics(input: {
  readonly db: PersistenceDb
  readonly tasks: ProcessTaskFacts
  readonly workgroups: ProcessWorkgroupFacts
  readonly gates: ProcessGateFacts
  readonly employees: ProcessEmployeeFacts
  readonly events: ProcessSubjectEvents
  readonly identities: ProcessIdentityDirectory
  readonly workflowNames: ProcessWorkflowNames
  readonly runner: InsightRunner
  readonly schedule: () => Promise<ProcessInsightSchedule>
  readonly clock?: () => number
}): ProcessMetrics {
  const clock = input.clock ?? Date.now
  const sources: ProcessSources = {
    tasks: input.tasks,
    workgroups: input.workgroups,
    gates: input.gates,
    employees: input.employees,
    events: input.events,
    calls: createCallPersistence(input.db),
    operations: createOperationPersistence(input.db),
    identities: input.identities,
    workflowNames: input.workflowNames,
  }
  const queries = createProcessQueries({ sources, clock })
  const insights = createInsightAnalyses({
    store: createInsightPersistence(input.db),
    runner: input.runner,
    texts: createProcessTexts(sources),
    schedule: input.schedule,
    activity: createSubjectActivity(sources),
    clock,
  })
  return {
    queries,
    insights,
    mount: (app) => mountProcessRoutes(app, { queries, insights }),
  }
}
