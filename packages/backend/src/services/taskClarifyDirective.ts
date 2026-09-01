// RFC-349 compatibility facade. Provider-neutral callers use the
// collaboration command/query surface; legacy SQLite consumers remain bound
// to the provider adapter without importing database mechanisms here.

export {
  getNodeClarifyDirective,
  getNodeClarifyDirectiveRow,
  isAskingNodeInSnapshot,
  listNodeClarifyDirectives,
  setNodeClarifyDirective,
  setNodeClarifyDirectiveTx,
} from '@/modules/collaboration/infrastructure/legacySqliteTaskClarifyDirective'
