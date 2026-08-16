// RFC-304 — the catalog the configuration UI is built from.
//
// This exists because the `/code` page could not configure anything. The matrix
// let an operator switch a capability ON but never choose its binding, so the
// cell sat `misconfigured` forever; the "go fix it" button pointed at a route
// that did not exist; and the templates tab could list and copy but not create.
// The only way to configure the platform was the HTTP API.
//
// Fixing that needs the UI to know two things per capability: that it exists,
// and which agent slots a binding must fill. Both are already in the stage
// contracts, so this endpoint DERIVES them rather than restating them.
//
// That choice is the whole point. Every drift defect this RFC produced has the
// same shape — a registry grew and a second reader did not: the scheduler that
// wired one capability, the i18n table that stopped at `pipeline_succeeded`,
// the visual helper still waiting on `/webhooks`. A hard-coded capability list
// in the frontend would have been the next one.

import { describe, expect, test } from 'bun:test'
import { CODE_CAPABILITIES } from '../src/modules/code-capability/domain/stageContract'
import { lookupStageContract } from '../src/modules/code-capability/domain/capabilityRegistry'

/** What the route builds, expressed here as the contract under test. */
function catalog(): Array<{ capability: string; agentSlots: string[] }> {
  return CODE_CAPABILITIES.map((capability) => ({
    capability,
    agentSlots: [
      ...new Set(
        (lookupStageContract(capability)?.stages ?? []).flatMap((stage) =>
          stage.kind === 'ai' ? [stage.agentSlot] : [],
        ),
      ),
    ],
  }))
}

describe('RFC-304 — the capability catalog', () => {
  test('every shipped capability is listed', () => {
    // Enumerated from the shipped list, so a sixth capability appears in the
    // configuration UI without a frontend change — and cannot be forgotten.
    expect(
      catalog()
        .map((row) => row.capability)
        .sort(),
    ).toEqual([...CODE_CAPABILITIES].sort())
  })

  test('each capability reports the agent slots a binding must fill', () => {
    // The binding dialog renders one agent picker per slot. An empty list would
    // render a dialog with nothing to fill in and produce a binding that maps
    // no agent — which fails at the round's first AI stage, after it has taken
    // the merge-request lease.
    const bySlot = new Map(catalog().map((row) => [row.capability, row.agentSlots]))

    expect(bySlot.get('mr-review')).toEqual(['reviewer'])
    expect(bySlot.get('ci-fix')).toEqual(['ci-fixer'])
    expect(bySlot.get('mr-comment-fix')).toEqual(['fixer'])
    // `requirement` has TWO — comprehension and implementation are different
    // jobs and a team may well want different models on them.
    expect(bySlot.get('requirement')?.length).toBe(2)
  })

  test('slots are de-duplicated — mr-review asks for its reviewer once', () => {
    // `mr-review` has two AI stages (`review-shard`, `review-global`) filled by
    // the SAME slot. Reporting it twice would render two identical pickers and
    // invite an operator to wonder which one matters.
    for (const row of catalog()) {
      expect(new Set(row.agentSlots).size, `${row.capability} repeats a slot`).toBe(
        row.agentSlots.length,
      )
    }
  })

  test('a capability with no AI stage reports an empty slot list, not an error', () => {
    // `mr-monitor` is scripts only. Its binding legitimately maps no agent, and
    // the dialog must let that through rather than blocking on a picker that
    // has nothing to pick.
    expect(catalog().find((row) => row.capability === 'mr-monitor')?.agentSlots).toEqual([])
  })
})
