// RFC-359 W12 — one composition for all code-history read surfaces. Both
// database clients supply the same readers and application projections.

import type { CodeHistoryReader } from '../application/ports/historyReader'
import type { CapabilityAgentExistence } from '../application/ports/existingResources'
import type { PersistenceDb } from '@/platform/persistence/persistenceDb'
import {
  createCodeMatrixQuery,
  createCodeDeliveryChainQuery,
  createCodeRoundAttemptsQuery,
  createCodeWorkItemProjectionQuery,
  type CodeDeliveryChainQuery,
} from '@/modules/code-capability/application/codeMatrixQuery'
import { createCodeMetricsQuery } from '@/modules/code-capability/application/codeMetricsQuery'
import {
  createTemplateUpstreamOperations,
  type TemplateUpstreamOperations,
} from '@/modules/code-capability/application/templateUpstreamStatus'
import { createCapabilityMatrixRead } from '@/modules/code-capability/infrastructure/capabilityMatrixRead'
import { createCodeMetricsRead } from '@/modules/code-capability/infrastructure/codeMetricsRead'
import { createDeliveryChainRead } from '@/modules/code-capability/infrastructure/deliveryChainRead'
import { createRoundAttemptsRead } from '@/modules/code-capability/infrastructure/roundAttemptsRead'
import { createTemplateUpstreamPersistence } from '@/modules/code-capability/infrastructure/templateUpstreamPersistence'
import { createWorkItemProjectionRead } from '@/modules/code-capability/infrastructure/workItemProjectionRead'
import type {
  CodeMetricsQuery,
  CodeMatrixQuery,
  CodeRoundAttemptsQuery,
  CodeWorkItemProjectionQuery,
} from '../application/ports/codeQueries'

export interface CodeHistoryQueries {
  readonly matrix: CodeMatrixQuery
  readonly workItems: CodeWorkItemProjectionQuery
  readonly attempts: CodeRoundAttemptsQuery
  readonly deliveries: CodeDeliveryChainQuery
  readonly metrics: CodeMetricsQuery
  readonly templateUpstream: TemplateUpstreamOperations
}

export function composeCodeHistoryQueries(
  db: PersistenceDb,
  agents: CapabilityAgentExistence,
  /** RFC-523: the caller states the reader (the daemon binds the installation's package reader). */
  history: CodeHistoryReader,
): CodeHistoryQueries {
  return Object.freeze({
    matrix: createCodeMatrixQuery(createCapabilityMatrixRead(db, agents)),
    workItems: createCodeWorkItemProjectionQuery(createWorkItemProjectionRead(history)),
    attempts: createCodeRoundAttemptsQuery(createRoundAttemptsRead(history)),
    deliveries: createCodeDeliveryChainQuery(createDeliveryChainRead(history)),
    metrics: createCodeMetricsQuery(createCodeMetricsRead(history)),
    templateUpstream: createTemplateUpstreamOperations(createTemplateUpstreamPersistence(db)),
  })
}

export {
  createCodeHistoryPackageReader,
  type CodeHistoryInstallation,
} from '../infrastructure/history/packageReader'
export type { CodeHistoryReader } from '../application/ports/historyReader'

export type { CodeHistorySource } from '../domain/codeHistoryPackage'
