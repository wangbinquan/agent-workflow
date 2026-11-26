// Schema-only composition exit for the live registry.
export {
  schemaContribution,
  historySchemaContribution,
  capabilityTemplates,
  repoCapabilityConfig,
  codeHistoryArchives,
  codeHistoryIdIndex,
} from '../infrastructure/persistence/schema'

export {
  codeHistoryQueryStates,
  codeHistoryQueryBuilds,
  codeHistoryQueryRecords,
  codeHistoryQueryWorkItems,
  codeHistoryQueryRounds,
  codeHistoryQueryStages,
  codeHistoryQueryAttempts,
  codeHistoryQueryDeliveries,
  codeHistoryMetricTotals,
  codeHistoryMetricPrefixes,
} from '../infrastructure/persistence/historyQuerySchema'
