// RFC-013: read-only historical-version mode resolver.
//
// The detail page at `/reviews/$nodeRunId?version=<vid>` shows either:
//   - the current pending/decided version (no ?version query, or it matches
//     the current version's id), with all the review controls (approve /
//     reject / iterate, comment add/edit/delete, diff toggle), OR
//   - a historical version, in read-only mode (decision buttons + comment
//     write affordances hidden, diff toggle hidden, keyboard shortcuts off).
//
// `resolveReviewView` is the single source of truth for which mode the
// page is in. Pulled into its own pure function so it can be exercised by
// unit tests without rendering the page.

import type { DocVersion, DocVersionDecision } from '@agent-workflow/shared'

export type ReviewView =
  | { mode: 'current' }
  | {
      mode: 'historical'
      vid: string
      /** decision + index when the local versions list contained the vid; the
       *  read-only banner uses these to render `viewing version vN (rejected)`.
       *  When the versions array isn't loaded yet, these stay undefined and
       *  the UI falls back to placeholder labels until the network query
       *  resolves. */
      decision?: DocVersionDecision
      versionIndex?: number
    }
  | { mode: 'invalid'; requested: string }

/**
 * Decide which review view the page should render.
 *
 * Parameters intentionally do not include async query state — pass the
 * already-resolved `versions` array (or undefined when it's still loading).
 *
 * Rules (in order):
 *   1. Empty / undefined / empty-string `versionQuery` → `mode: 'current'`.
 *   2. `versionQuery === currentVersionId` → `mode: 'current'` (the link
 *      target for the "current" row in the list-page expand panel; we treat
 *      it identically to the no-query path so the banner doesn't appear).
 *   3. `versions === undefined` (not loaded yet) → `mode: 'historical'`
 *      optimistically; the network request for that vid will surface 404
 *      separately if it's bogus.
 *   4. Versions loaded + match found → `mode: 'historical'` with the
 *      version's decision + index pre-populated.
 *   5. Versions loaded + no match → `mode: 'invalid'`. The page reacts by
 *      showing a toast and replacing the URL with the no-query form.
 */
export function resolveReviewView(
  versionQuery: string | undefined,
  currentVersionId: string,
  versions: DocVersion[] | undefined,
): ReviewView {
  if (versionQuery === undefined || versionQuery === '') return { mode: 'current' }
  if (versionQuery === currentVersionId) return { mode: 'current' }
  if (versions === undefined) {
    return { mode: 'historical', vid: versionQuery }
  }
  const match = versions.find((v) => v.id === versionQuery)
  if (match === undefined) return { mode: 'invalid', requested: versionQuery }
  return {
    mode: 'historical',
    vid: match.id,
    decision: match.decision,
    versionIndex: match.versionIndex,
  }
}
