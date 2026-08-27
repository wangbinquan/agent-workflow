// RFC-333 T11 — compiled-e2e-only barrier for the exact commit -> wake crash
// window. Production binaries define AW_E2E_BUILD=false, so this seam is inert
// there even if a similarly named environment variable is present. The e2e
// binary can publish a durable marker and let the harness SIGKILL the daemon
// before the composition invokes the immediate wake; boot must then recover the
// already-committed canonical intent.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

declare const AW_E2E_BUILD: boolean | undefined

export type HumanGateDecisionBarrierKind = 'review' | 'clarify' | 'questions'

export async function waitAtHumanGateDecisionCommitBarrier(input: {
  readonly kind: HumanGateDecisionBarrierKind
  readonly taskId: string
  readonly operationId: string
}): Promise<void> {
  if (!(typeof AW_E2E_BUILD === 'boolean' && AW_E2E_BUILD)) return

  const barrierDir = process.env.AW_E2E_HUMAN_GATE_DECISION_BARRIER_DIR
  const barrierKind = process.env.AW_E2E_HUMAN_GATE_DECISION_BARRIER_KIND
  if (barrierDir === undefined || barrierKind !== input.kind) return

  mkdirSync(barrierDir, { recursive: true })
  writeFileSync(
    join(barrierDir, `${input.kind}.committed.json`),
    JSON.stringify({ ...input, committedAt: Date.now() }),
    'utf8',
  )

  // Intentionally never resolves. The Playwright harness observes the marker
  // and externally SIGKILLs the daemon, which models a real process crash more
  // faithfully than throwing through the request stack.
  await new Promise<never>(() => {})
}
