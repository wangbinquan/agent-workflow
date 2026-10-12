// Pure helpers shared by the clarify answer surfaces (the /clarify detail page and
// the RFC-128 centralized answer pane). Extracted so the two entry points compare /
// classify a ClarifyAnswer identically (dedup — there was one local copy in
// clarify.detail.tsx).

import type { ClarifyAnswer } from '@agent-workflow/shared'

/** RFC-099 — user-state equality for clarify drafts. Labels are server-refilled, so
 *  they're intentionally ignored; only the user's option picks + custom text matter. */
export function answersEqual(a: ClarifyAnswer, b: ClarifyAnswer): boolean {
  const ai = [...a.selectedOptionIndices].sort((x, y) => x - y)
  const bi = [...b.selectedOptionIndices].sort((x, y) => x - y)
  if (ai.length !== bi.length || ai.some((v, i) => v !== bi[i])) return false
  return a.customText === b.customText && a.confirmedBasis === b.confirmedBasis
}

/** True when a ClarifyAnswer carries a real user decision (an option pick OR custom
 *  text). The negation is "no answer yet". Used to decide which questions a submit
 *  actually seals (the centralized pane only submits filled answers). */
export function isAnswerFilled(a: ClarifyAnswer | undefined): boolean {
  if (a === undefined) return false
  return a.selectedOptionIndices.length > 0 || a.customText.length > 0
}
