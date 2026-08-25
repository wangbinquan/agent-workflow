// RFC-326 — the `collaboration` context's public QUERIES (RFC-294 exact entrypoint).
//
// `resolveReviewAnchor` is a pure query: given a document and a simplified locator
// it answers "which composite anchor does this denote", or exactly why it cannot
// (candidates with global occurrence numbers, near misses, …). It never writes.
//
// `buildReviewAnchorDocument` prepares the one-scan document model a batch of
// resolutions shares; `createReviewAnchorBudget` bounds the total scanning a single
// request may do.

export {
  REVIEW_ANCHOR_CANDIDATE_LIMIT,
  REVIEW_ANCHOR_CONTEXT_CHARS,
  REVIEW_ANCHOR_DEFAULT_BUDGET_CHARS,
  REVIEW_ANCHOR_MESSAGE_CANDIDATE_LIMIT,
  REVIEW_ANCHOR_SUGGESTION_LIMIT,
  buildReviewAnchorDocument,
  createReviewAnchorBudget,
  paragraphIdxAt,
  resolveReviewAnchor,
  sectionPathAt,
} from '../domain/reviewAnchor'
