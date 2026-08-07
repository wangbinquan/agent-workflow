// RFC-264 — the SINGLE source of truth for human-readable resource names
// (workflow + workgroup). Replaces the 2026-07-10 slug rule
// `^[a-z0-9][a-z0-9_-]*$`, which forced Chinese-facing installations to name
// every resource `code-audit-pipeline`.
//
// Safe to relax because the name is nowhere near a path: REST + router + export
// header all key on the ULID (routes/workflows.ts:106,411), worktrees/branches
// use repo-slug + task ULID (util/git.ts:941,969), and builtin rows are
// discriminated by the `builtin` column (systemResources.ts). What the name
// still IS: the owner-unique key for workgroups (workgroups_owner_name_unique)
// and the authoritative call-node selector (schemas/workflow.ts CallWorkflow /
// CallWorkgroup), so look-alike names are disambiguated in the UI by the
// ULID suffix (frontend lib/resource-option-label.ts), not by a stricter rule.

import { z } from 'zod'

/** Max length in CODE POINTS (the `u`-flagged quantifier below counts those). */
export const RESOURCE_DISPLAY_NAME_MAX = 128

/**
 * Fold the equivalences that would otherwise produce two names rendering
 * identically. Idempotent by construction; order matters:
 *
 *  1. NFC — identity for Han ideographs, folds the compatibility-ideograph /
 *     dakuten / Hangul / accented-Latin cases. NOT NFKC: that would rewrite
 *     `（重构）` into `(重构)` and `Ａ` into `A`, which is editing user input.
 *  2. `\p{Zs}` → U+0020 — NBSP and the ideographic space U+3000 (what a Chinese
 *     IME emits) become the ordinary space, so step 3 can see them.
 *  3. collapse runs of spaces.
 *  4. trim — also eats a trailing newline from a paste. INTERNAL `\n` / `\t`
 *     survive (they are `\p{Cc}`, not `\p{Zs}`) and are REJECTED below, so a
 *     multi-line paste errors instead of being silently joined into one line.
 */
export function normalizeResourceDisplayName(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/\p{Zs}/gu, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
}

/**
 * Applied to the NORMALIZED value. Blacklist-shaped: everything not listed is
 * allowed (Han, kana, Hangul, Latin incl. uppercase, digits, punctuation,
 * emoji, the ordinary space).
 *
 *  `(?!_)`  reserves the `__agent_host__` / `__workgroup_host__` shape for the
 *           framework rows that are inserted bypassing this schema.
 *  `\p{Cc}` control chars — includes `\t` `\n` `\r`.
 *  `\p{Cf}` format chars — zero-width U+200B, RTL override U+202E: invisible
 *           characters are a pure spoofing surface.
 *  `\p{Cs}` lone surrogates — only reachable from a UTF-16-unit truncation bug.
 *  `\p{Co}` private use — renders differently per installed font.
 *  `\p{Zl}` `\p{Zp}` line / paragraph separators.
 *
 * The `u` flag makes `{1,128}` count CODE POINTS, so the bound is 128 real
 * characters (128 Han ideographs), not 128 UTF-16 units.
 */
export const RESOURCE_DISPLAY_NAME_RE = /^(?!_)[^\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]{1,128}$/u

export const RESOURCE_DISPLAY_NAME_MSG =
  'name must not start with "_", must not contain control characters, and is at most 128 characters'

/**
 * Normalizes on parse, so every write path that goes through a schema stores
 * the folded form without calling the normalizer by hand. `z.preprocess`
 * yields a `ZodEffects<ZodString>` — `.optional()` still chains (relied on by
 * schemas/scheduledTask.ts).
 *
 * The length bound lives in the regex only: a second UTF-16-counting `.max()`
 * would disagree with it for astral-plane names.
 */
export const ResourceDisplayNameSchema = z.preprocess(
  (value) => (typeof value === 'string' ? normalizeResourceDisplayName(value) : value),
  z.string().min(1, 'name is required').regex(RESOURCE_DISPLAY_NAME_RE, RESOURCE_DISPLAY_NAME_MSG),
)

/** Convenience predicate for callers that only need a verdict (frontend forms). */
export function isValidResourceDisplayName(normalized: string): boolean {
  return RESOURCE_DISPLAY_NAME_RE.test(normalized)
}
