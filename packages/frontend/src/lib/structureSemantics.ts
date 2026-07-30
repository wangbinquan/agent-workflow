// RFC-088 semantics — implementation hoisted to shared by RFC-239 (the
// change-group model needs severity on both ends; single source there). This
// module stays as a re-export so existing `@/lib/structureSemantics` imports
// and their tests keep working unchanged. The display-only token diff
// (`diffSignatureTokens`) intentionally stays in `./structureView` — shared
// uses its own zero-dependency LCS predicate instead.

export {
  classifyBreaking,
  explainChange,
  orderAndFilterChanges,
  walkthroughItems,
  severityCounts,
  signatureTokensRemoved,
  SEVERITY_RANK,
  type Severity,
  type BreakingReason,
  type BreakingVerdict,
  type SortBy,
  type ChangeFilter,
  type WalkthroughItem,
} from '@agent-workflow/shared'
