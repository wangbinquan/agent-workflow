// RFC-359 W12 — one composition for all code-history read surfaces. Both
// database clients supply the same readers and application projections.

import type { ProviderNeutralDatabase } from '@/db/query'
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
} from '@/modules/code-capability/public/queries'

export interface CodeHistoryQueries {
  readonly matrix: CodeMatrixQuery
  readonly workItems: CodeWorkItemProjectionQuery
  readonly attempts: CodeRoundAttemptsQuery
  readonly deliveries: CodeDeliveryChainQuery
  readonly metrics: CodeMetricsQuery
  readonly templateUpstream: TemplateUpstreamOperations
}

export function composeCodeHistoryQueries(db: ProviderNeutralDatabase): CodeHistoryQueries {
  return Object.freeze({
    matrix: createCodeMatrixQuery(createCapabilityMatrixRead(db)),
    workItems: createCodeWorkItemProjectionQuery(createWorkItemProjectionRead(db)),
    attempts: createCodeRoundAttemptsQuery(createRoundAttemptsRead(db)),
    deliveries: createCodeDeliveryChainQuery(createDeliveryChainRead(db)),
    metrics: createCodeMetricsQuery(createCodeMetricsRead(db)),
    templateUpstream: createTemplateUpstreamOperations(createTemplateUpstreamPersistence(db)),
  })
}
