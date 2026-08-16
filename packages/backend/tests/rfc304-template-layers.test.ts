// RFC-304 §2.5 / §3.1 — the two template layers.
//
// The layer split is a permission model, so the tests are written as permission
// tests: what a group lead can reach, what they cannot, and what happens when
// they try. The department layer carries scripts and hooks, which run as the
// daemon with its full credential surface; the group layer exists so a team can
// own their own configuration WITHOUT that surface.
//
// Two design choices get explicit tests because the alternative looks kinder
// and is worse:
//
//   - a binding write carrying a hook is REJECTED, not stripped. Silently
//     dropping a hook someone wrote is how a team spends a month believing
//     their gate runs;
//   - an unknown param key is REPORTED, not applied. A typo that silently does
//     nothing leaves "why is my threshold ignored?" with no answer anywhere.
//
// The readiness tests are about the same failure in a different place:
// "configured, silent, and no way to tell why" is the most common reason a
// platform like this gets abandoned, so every non-ready state must name what is
// missing specifically enough to fix.

import { describe, expect, test } from 'bun:test'
import {
  canWriteFramework,
  deriveReadiness,
  FRAMEWORK_ONLY_FIELDS,
  rejectFrameworkOnlyFields,
  type ReadinessInput,
  type ReadinessIssue,
} from '../src/modules/code-capability/domain/templateLayers'

describe('RFC-304 §2.5 — the group layer cannot reach the daemon surface', () => {
  test('a binding write carrying scripts or hooks is rejected, not stripped', () => {
    const rejections = rejectFrameworkOnlyFields({
      name: 'my binding',
      agentBySlot: { reviewer: 'agent-1' },
      hooks: [{ stage: 'publish', phase: 'pre', script: 'curl $SECRET_URL' }],
    })
    expect(rejections).toHaveLength(1)
    expect(rejections[0]?.field).toBe('hooks')
    // The message has to say WHY, or the author's next move is to try a
    // different field name rather than to ask for framework access.
    expect(rejections[0]?.message).toContain('scripts:author')
  })

  test('every framework-only field is covered, enumerated from the list itself', () => {
    // Enumerated rather than hand-listed so a field added to the department
    // layer later is covered the day it is added.
    for (const field of FRAMEWORK_ONLY_FIELDS) {
      const rejections = rejectFrameworkOnlyFields({ [field]: 'anything' })
      expect(rejections.map((r) => r.field)).toEqual([field])
    }
  })

  test('an ordinary binding write passes untouched', () => {
    // Reverse assertion: a check that rejected everything would satisfy the
    // tests above while making bindings unwritable.
    expect(
      rejectFrameworkOnlyFields({
        name: 'my binding',
        frameworkId: 'fw-1',
        agentBySlot: { reviewer: 'agent-1' },
        promptBySlot: { reviewer: 'focus on error handling' },
        params: { severityThreshold: 'major' },
      }),
    ).toEqual([])
  })

  test('non-object payloads do not crash the check', () => {
    // It runs on the RAW body, before schema parsing, so it meets whatever
    // arrives on the wire.
    for (const payload of [null, undefined, 'string', 42, []]) {
      expect(rejectFrameworkOnlyFields(payload)).toEqual([])
    }
  })

  test('writing a framework needs resource write AND scripts:author', () => {
    // Both, not either: resource write alone would let a granted binding owner
    // reach the daemon's surface; scripts:author alone would bypass the ACL.
    expect(canWriteFramework({ hasResourceWrite: true, hasScriptsAuthor: true })).toBe(true)
    expect(canWriteFramework({ hasResourceWrite: true, hasScriptsAuthor: false })).toBe(false)
    expect(canWriteFramework({ hasResourceWrite: false, hasScriptsAuthor: true })).toBe(false)
    expect(canWriteFramework({ hasResourceWrite: false, hasScriptsAuthor: false })).toBe(false)
  })
})

// Parameter resolution moved to `traceCapabilityParams` in the shared package
// and is covered by `packages/shared/tests/rfc304-capability-params.test.ts`.
// There were two implementations of it — this module's `resolveParams`, which
// nothing called, and the shared one, which everything called. Two resolvers
// that never run together can disagree forever without a test noticing.

describe('RFC-304 §3.1 — readiness names what is missing', () => {
  const ready = (over: Partial<ReadinessInput> = {}): ReadinessInput => ({
    enabled: true,
    hasBinding: true,
    frameworkExists: true,
    hasTrigger: true,
    codeHostConfigured: true,
    invisibleAgentSlots: [],
    requiresWakeSource: false,
    hasWakeSource: false,
    ...over,
  })

  test('all prerequisites present ⇒ ready, with no issues', () => {
    expect(deriveReadiness(ready())).toEqual({ state: 'ready', issues: [] })
  })

  test('not enabled ⇒ disabled, and nothing is reported as missing', () => {
    // Listing prerequisites for a capability nobody turned on is noise that
    // buries the cells that ARE misconfigured.
    expect(deriveReadiness(ready({ enabled: false }))).toEqual({ state: 'disabled', issues: [] })
  })

  test('each missing prerequisite is reported with an actionable code', () => {
    // Typed as the code union, not `string`: a typo in an expected code is
    // then a compile error rather than a test that quietly asserts nothing.
    const cases: Array<[Partial<ReadinessInput>, ReadinessIssue['code']]> = [
      [{ hasBinding: false }, 'no-binding'],
      [{ hasTrigger: false }, 'no-trigger'],
      [{ codeHostConfigured: false }, 'code-host-unconfigured'],
      [{ invisibleAgentSlots: ['reviewer'] }, 'agent-not-visible'],
    ]
    for (const [over, code] of cases) {
      const r = deriveReadiness(ready(over))
      expect(r.state).toBe('misconfigured')
      expect(r.issues.map((i) => i.code)).toContain(code)
      // Each issue drives a one-click fix in the matrix, so the detail must
      // name the specific thing rather than restate the code.
      const issue = r.issues.find((i) => i.code === code)
      expect(issue).toBeDefined()
      expect(issue?.detail.length ?? 0).toBeGreaterThan(10)
    }
  })

  test('several missing prerequisites are ALL reported', () => {
    // Reporting one at a time turns setup into a guessing loop: fix, re-check,
    // discover the next one.
    const r = deriveReadiness(
      ready({ hasTrigger: false, codeHostConfigured: false, invisibleAgentSlots: ['a', 'b'] }),
    )
    expect(r.issues).toHaveLength(4)
  })

  test('a missing framework is reported only once a binding exists', () => {
    // Otherwise the user is sent looking for a framework they never chose.
    const noBinding = deriveReadiness(ready({ hasBinding: false, frameworkExists: false }))
    expect(noBinding.issues.map((i) => i.code)).toEqual(['no-binding'])

    const dangling = deriveReadiness(ready({ frameworkExists: false }))
    expect(dangling.issues.map((i) => i.code)).toContain('framework-missing')
  })

  test('ci-fix without a wake source is NOT ready — AC-14d', () => {
    // The specific trap: everything else is configured, so the cell would show
    // `ready` while nothing on earth could start it.
    const r = deriveReadiness(ready({ requiresWakeSource: true, hasWakeSource: false }))
    expect(r.state).toBe('misconfigured')
    expect(r.issues.map((i) => i.code)).toEqual(['no-wake-source'])
  })

  test('a capability that needs no wake source is unaffected by not having one', () => {
    // Reverse assertion: requiring it unconditionally would make every
    // review-only repo permanently misconfigured.
    expect(deriveReadiness(ready({ requiresWakeSource: false, hasWakeSource: false })).state).toBe(
      'ready',
    )
  })
})
