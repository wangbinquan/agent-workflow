// RFC-234 §4/§1.3 (T5) — INTENT.md composition + deterministic history
// compaction. RFC-348 — the capability-teaching sections are RENDERED from the
// registries under `modules/intent/domain/teaching/` (node kinds, resource
// types, workflow parts, platform map); this file only assembles.
//
// INTENT.md is the single entry document the intent agent reads first. It is
// assembled fresh every turn (the underlying opencode store is ephemeral —
// multi-turn = full context replay). Composition rules, all locked by
// tests/rfc234-intent-doc.test.ts:
//
//  - History compaction is DETERMINISTIC (design §1.3): the most recent
//    RECENT_TURNS_VERBATIM turns render verbatim; older turns collapse to one
//    structured line each; ANSWER turns are decision facts and NEVER compact.
//    Any truncation is explicitly labeled — silence never means completeness.
//  - Every user-authored or resource-derived text enters through
//    fenceUntrusted(nonce) (RFC-200): the fence is an injection MITIGATION,
//    not an authorization boundary (that lives in mount approval + apply
//    revalidation).
//  - The document teaches the exact output contract (ports, handle grammar,
//    secret sentinel, size bounds) so schema rejections stay rare.
//  - No node kind, resource type, payload / envelope field or inventory file
//    name is spelled here (RFC-348, locked by tests/intent-teaching-registry):
//    every such literal lives in the teaching registries / typed renderers, so
//    a kind or field the registries do not know cannot reach the model and a
//    roster addition fails to compile until it is registered.

import {
  WORKFLOW_SCHEMA_VERSION,
  fenceUntrusted,
  type IntentQuestion,
  type IntentResourceType,
  type PrivilegedNodeLens,
} from '@agent-workflow/shared'
import {
  INTENT_TURN_GUIDANCE,
  renderCapabilityLimits,
  renderCommonMistakes,
  renderDeliveryBudget,
  renderOutputContract,
  renderPayloadSchemas,
  renderPlatformCapabilityMap,
  renderPlatformModel,
  renderReferenceRules,
  renderRequestedArtifactType,
  renderWorkingDirectoryLayout,
  type IntentDocPrivileges,
} from '@/modules/intent/domain/teaching/render'

export type { IntentDocPrivileges }

export const RECENT_TURNS_VERBATIM = 8
const HISTORY_VERBATIM_TURN_CAP_BYTES = 16 * 1024
export { INTENT_TURN_GUIDANCE }

export interface IntentDocTurn {
  seq: number
  role: 'user' | 'agent'
  kind: 'message' | 'answers' | 'mount-approval' | 'questions' | 'changeset' | 'error'
  /** Display text: message text / summary / structured JSON for answers. */
  text: string
}

/**
 * The lens says "redact this" (`true` = the actor may NOT author); the doc wants
 * the positive capability. Flip it in exactly one place so the two spellings can
 * never drift apart (RFC-253 / RFC-269: the two write gates read the same
 * `actor.permissions`, so "taught but unsaveable" cannot happen).
 */
export function privilegesFromLens(lens: PrivilegedNodeLens): IntentDocPrivileges {
  return { mayAuthorScripts: !lens.scripts, mayAuthorCodeHostCalls: !lens.codeHost }
}

export interface IntentDocInput {
  sessionTitle: string
  turns: readonly IntentDocTurn[]
  /** Canonical JSON of the current draft changeset; null when none. */
  currentDraftJson: string | null
  /** Blocking validation errors on the current draft (verbatim strings). */
  validationErrors: readonly string[]
  /** Pending unanswered questions from the latest questions turn, if any. */
  pendingQuestions: readonly IntentQuestion[]
  hiddenDependencyNote: string | null
  /**
   * RFC-291 面 C — mounted roots that could not be materialised this epoch.
   *
   * Kept SEPARATE from hiddenDependencyNote on purpose: one says "a dependency
   * of something you can see is invisible to you", the other says "a resource
   * you explicitly mounted is gone". Folding them into one parameter would make
   * the rendered advice wrong for whichever case lost the coin toss.
   */
  unavailableMountNote: string | null
  envelopeNonce: string
  /** Output language directive (config intentBuilderLang or mirror-input). */
  langDirective: string
  privileges: IntentDocPrivileges
  /**
   * RFC-348 D4 (RFC-235 D33) — the resource type the user picked when opening
   * the session (`hint`), rendered as a weak preference; absent/null when the
   * session was opened without one.
   */
  requestedArtifactType?: IntentResourceType | null
}

function clip(text: string, capBytes: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= capBytes) return { text, truncated: false }
  let out = text
  while (Buffer.byteLength(out, 'utf8') > capBytes) {
    out = out.slice(0, Math.floor(out.length * 0.9))
  }
  return { text: out, truncated: true }
}

/** Deterministic history block. Exported separately for the golden test. */
export function renderHistory(turns: readonly IntentDocTurn[], nonce: string): string {
  const lines: string[] = []
  const verbatimFrom = Math.max(0, turns.length - RECENT_TURNS_VERBATIM)
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i] as IntentDocTurn
    const label = `turn ${turn.seq} (${turn.role}/${turn.kind})`
    const isAnswers = turn.kind === 'answers' || turn.kind === 'mount-approval'
    if (i >= verbatimFrom || isAnswers) {
      const { text, truncated } = clip(turn.text, HISTORY_VERBATIM_TURN_CAP_BYTES)
      lines.push(`### ${label}${truncated ? ' [TRUNCATED]' : ''}`)
      lines.push(fenceUntrusted(label, text, nonce))
      lines.push('')
    } else {
      const first = turn.text.split('\n', 1)[0] ?? ''
      const head = first.length > 200 ? `${first.slice(0, 200)}…` : first
      lines.push(`- ${label} [compacted]: ${fenceUntrusted(label, head, nonce)}`)
    }
  }
  if (verbatimFrom > 0) {
    lines.unshift(
      `> History note: turns before ${turns[verbatimFrom]?.seq ?? '?'} are compacted to one line each (answers are never compacted).`,
      '',
    )
  }
  return lines.join('\n')
}

export function buildIntentDoc(input: IntentDocInput): string {
  const sections: string[] = []
  const capabilityLimits = renderCapabilityLimits(input.privileges)
  // Codex impl-gate P1-4: the title is user-authored (derived from their first
  // message) — it must be fenced like any other untrusted text, not spliced
  // into the system-authored heading.
  sections.push(`# Intent session

${fenceUntrusted('session title', input.sessionTitle, input.envelopeNonce)}

${renderWorkingDirectoryLayout()}

${renderPlatformModel(input.privileges)}

${renderPlatformCapabilityMap()}

${renderRequestedArtifactType(input.requestedArtifactType ?? null)}

${renderReferenceRules()}

## Secrets (hard)

Credential-bearing fields (MCP env values / remote headers / a remote MCP's
\`oauth.clientSecret\` / script \`env\` values) must be the exact sentinel
\`‹secret›\` — the user fills real values at confirm time. Emitting anything
credential-shaped anywhere in the changeset is rejected.${
    capabilityLimits.length === 0 ? '' : `\n\n${capabilityLimits}`
  }`)

  sections.push(renderDeliveryBudget())

  sections.push(renderPayloadSchemas(input.privileges, WORKFLOW_SCHEMA_VERSION))

  sections.push(renderCommonMistakes(input.privileges))

  sections.push(renderOutputContract(input.langDirective))

  sections.push(`## Conversation history\n\n${renderHistory(input.turns, input.envelopeNonce)}`)

  if (input.pendingQuestions.length > 0) {
    sections.push(
      `## Pending questions you asked (now answered above — regenerate accordingly)\n\n${fenceUntrusted(
        'pending questions',
        JSON.stringify(input.pendingQuestions, null, 2),
        input.envelopeNonce,
      )}`,
    )
  }

  if (input.currentDraftJson !== null) {
    sections.push(
      `## Current draft changeset (your previous proposal — evolve it, do not restart unless asked)\n\n${fenceUntrusted(
        'current draft',
        input.currentDraftJson,
        input.envelopeNonce,
      )}`,
    )
  }

  if (input.validationErrors.length > 0) {
    sections.push(
      `## BLOCKING validation errors on the current draft (fix ALL of these)\n\n${input.validationErrors
        .map((e) => `- ${fenceUntrusted('validation error', e, input.envelopeNonce)}`)
        .join('\n')}`,
    )
  }

  const accessNotes = [input.hiddenDependencyNote, input.unavailableMountNote].filter(
    (note): note is string => note !== null,
  )
  if (accessNotes.length > 0) {
    sections.push(`## Access notes\n\n${accessNotes.join('\n\n')}`)
  }

  return `${sections.join('\n\n')}\n`
}
