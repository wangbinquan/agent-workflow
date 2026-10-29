// RFC-333 T11 — compiled-e2e-only barrier for the exact commit -> wake crash
// window. Production binaries define AW_E2E_BUILD=false, so this seam is inert
// there even if a similarly named environment variable is present. The e2e
// binary publishes a durable marker, freezes the daemon and lets the harness
// SIGKILL it before anything invokes the wake; boot must then recover the
// already-committed canonical intent.

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
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
  const markerPath = join(barrierDir, `${input.kind}.committed.json`)
  const pendingPath = `${markerPath}.${process.pid}.tmp`
  // The reader treats the final path's existence as readiness. Publish only
  // after all JSON bytes are written; otherwise it can observe an empty file.
  writeFileSync(pendingPath, JSON.stringify({ ...input, committedAt: Date.now() }), 'utf8')
  renameSync(pendingPath, markerPath)

  // A crash at this instant runs nothing else in the process, so freeze the thread
  // until the Playwright harness SIGKILLs it. Parking only this request on a
  // promise that never settles left the event loop running: the daemon's own
  // human-gate continuation worker (1 s cycle) claimed the committed continuation
  // and started the next node, and a kill landing after that is a crash during a
  // running node, which correctly leaves the task interrupted instead of
  // continued (Windows CI 40950592110, e2e shard 2/4, both attempts; locally a
  // kill delayed 1.8 s after the marker failed 5 of 5).
  const frozen = new Int32Array(new SharedArrayBuffer(4))
  for (;;) Atomics.wait(frozen, 0, 0)
}
