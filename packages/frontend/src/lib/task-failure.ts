// RFC-203 T4 — the ONE oracle for "how do we explain a failed task/node to a
// human". Three tiers (audit P1 F-2: every failure surface used to render the
// raw English machine token from errorSummary):
//
//   1. `failureCode` (RFC-145 machine taxonomy, now projected into
//      Task/TaskSummary/NodeRun DTOs) → `tasks.failure.<code>`.
//   2. Known errorSummary tokens (exact or prefix — the summary column is a
//      machine protocol, task-wizard.ts even string-matches it; we NEVER
//      change the writers, only translate at display time) →
//      `tasks.failure.summary.<key>`.
//   3. Generic domain copy; the raw summary/message stay available for the
//      collapsible detail block.

import i18n from 'i18next'
import type { FailureCode } from '@agent-workflow/shared'

export interface TaskFailureInput {
  failureCode?: FailureCode | null
  errorSummary?: string | null
  errorMessage?: string | null
}

export interface TaskFailureCopy {
  /** Localized, human explanation — never a machine token. */
  title: string
  /** Localized next-step guidance when authored. */
  hint?: string
  /** Raw machine summary/message for the collapsible detail block. */
  raw?: string
  /** Which tier matched (test anchor + telemetry). */
  matched: 'failure-code' | 'summary-token' | 'generic'
}

/** Exact-match summary tokens → i18n key suffix. */
const EXACT_TOKENS: Record<string, string> = {
  'snapshot-lost': 'snapshotLost',
  'snapshot-invalid': 'snapshotInvalid',
  'snapshot-missing': 'snapshotMissing',
  'live-child-survived': 'liveChildSurvived',
  'daemon-restart': 'daemonRestart',
  'orphan-reconcile': 'orphanReconcile',
  'canceled by user': 'canceledByUser',
  'scheduler error': 'schedulerError',
  'dw-generate-exhausted': 'dwGenerateExhausted',
}

/** Prefix-match summary tokens (writers append detail after the prefix). */
const PREFIX_TOKENS: ReadonlyArray<readonly [string, string]> = [
  ['node-timeout', 'nodeTimeout'],
  ['child-unkillable', 'childUnkillable'],
  ['scheduler stalled', 'schedulerStalled'],
  ['worktree creation failed', 'worktreeCreationFailed'],
  ['workgroup hit max_rounds', 'workgroupMaxRounds'],
]

// `... exited with code N` carries the runtime name first — match anywhere.
const EXITED_WITH_CODE = /exited with code \d+/

function summaryTokenKey(summary: string): string | null {
  const exact = EXACT_TOKENS[summary]
  if (exact !== undefined) return exact
  for (const [prefix, key] of PREFIX_TOKENS) {
    if (summary.startsWith(prefix)) return key
  }
  if (EXITED_WITH_CODE.test(summary)) return 'exitedWithCode'
  return null
}

export function describeTaskFailure(input: TaskFailureInput): TaskFailureCopy {
  const t = i18n.t.bind(i18n)
  const raw =
    input.errorSummary !== null &&
    input.errorSummary !== undefined &&
    input.errorSummary.trim() !== ''
      ? input.errorSummary
      : (input.errorMessage ?? undefined)

  if (input.failureCode !== null && input.failureCode !== undefined) {
    const key = `tasks.failure.${input.failureCode}`
    if (i18n.exists(key)) {
      const hintKey = `${key}__hint`
      return {
        title: t(key),
        ...(i18n.exists(hintKey) ? { hint: t(hintKey) } : {}),
        ...(raw !== undefined ? { raw } : {}),
        matched: 'failure-code',
      }
    }
  }

  if (input.errorSummary !== null && input.errorSummary !== undefined) {
    const tokenKey = summaryTokenKey(input.errorSummary)
    if (tokenKey !== null) {
      const key = `tasks.failure.summary.${tokenKey}`
      if (i18n.exists(key)) {
        const hintKey = `${key}__hint`
        return {
          title: t(key),
          ...(i18n.exists(hintKey) ? { hint: t(hintKey) } : {}),
          ...(raw !== undefined ? { raw } : {}),
          matched: 'summary-token',
        }
      }
    }
  }

  return {
    title: t('tasks.failure.generic'),
    ...(raw !== undefined ? { raw } : {}),
    matched: 'generic',
  }
}
