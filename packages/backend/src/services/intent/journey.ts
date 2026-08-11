// RFC-235 v22 — the server-owned projection of an Intent session onto the
// four business steps. List and detail routes call this exact function; the
// browser only translates the returned closed reason enum.

import type { IntentJourneySnapshot } from '@agent-workflow/shared'

export interface IntentJourneyProjectionInput {
  status: 'active' | 'archived'
  contextRevision: number
  commitSeq: number
  inFlight: boolean
  latestAgentTurnKind?:
    | 'message'
    | 'answers'
    | 'mount-approval'
    | 'running'
    | 'questions'
    | 'changeset'
    | 'error'
  currentDraft: null | {
    id: string
    contextRevision: number
    validationErrors: readonly string[]
  }
  latestCommit?: {
    draftId: string
    state: 'prepared' | 'applying' | 'committed' | 'failed'
  }
}

export function projectIntentJourney(input: IntentJourneyProjectionInput): IntentJourneySnapshot {
  let active: IntentJourneySnapshot
  if (input.latestCommit?.state === 'prepared' || input.latestCommit?.state === 'applying') {
    active = { kind: 'applying', step: 4, completedThrough: 3, reason: 'apply-running' }
  } else if (input.inFlight) {
    active = { kind: 'generating', step: 2, completedThrough: 1, reason: 'generation-running' }
  } else if (input.latestAgentTurnKind === 'questions') {
    active = { kind: 'clarifying', step: 2, completedThrough: 1, reason: 'answer-questions' }
  } else if (input.currentDraft !== null) {
    if (input.currentDraft.contextRevision !== input.contextRevision) {
      active = { kind: 'review-blocked', step: 3, completedThrough: 2, reason: 'draft-stale' }
    } else if (input.currentDraft.validationErrors.length > 0) {
      active = { kind: 'review-blocked', step: 3, completedThrough: 2, reason: 'draft-invalid' }
    } else if (
      input.latestCommit?.state === 'failed' &&
      input.latestCommit.draftId === input.currentDraft.id
    ) {
      active = { kind: 'error', step: 4, completedThrough: 3, reason: 'apply-failed' }
    } else {
      active = { kind: 'review-ready', step: 3, completedThrough: 2, reason: 'review-draft' }
    }
  } else if (input.latestAgentTurnKind === 'error') {
    active = { kind: 'error', step: 2, completedThrough: 1, reason: 'generation-failed' }
  } else if (input.commitSeq > 0) {
    active = { kind: 'applied', step: 4, completedThrough: 4, reason: 'applied' }
  } else {
    active = { kind: 'goal', step: 1, completedThrough: 0, reason: 'describe-goal' }
  }

  return input.status === 'archived' ? { ...active, kind: 'archived', reason: 'archived' } : active
}
