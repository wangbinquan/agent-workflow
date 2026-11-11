// Regression: cross-questioner 'stop' directive must scope to the cross-clarify-driven rerun only —
// NOT to a later review-iterate / process-retry rerun that inherits crossClarifyIteration.
//
// The service-level baselines (buildPromptContext cross-questioner applyLatestDirective) were retired
// with that injector (RFC-132 PR-C unified clarify injection into buildClarifyQueueContext; PR-E1
// deleted the dead injectors). The surviving lock is the node-mechanics source-grep guard below: the
// cross-questioner path no longer has its own SELECT branch nor an applyLatestDirective gate — the
// standing continue/stop directive is the per-node clarify state (nodeStopOverride) flowing into
// resolveEffectiveClarifyChannel + shouldInjectStopNotice, preserving the cci-rerun stop-scoping.

import { describe, expect, test } from 'bun:test'
import { AGENT_MECHANICS_SOURCE } from './helpers/executionMechanismSources'

describe('TaskExecution wiring: cross-questioner clarify state', () => {
  test('nodeMechanics.ts reads the per-node clarify state, not a per-round applyLatestDirective (RFC-132 PR-C)', () => {
    // Source-text guard: catches a future refactor that re-introduces the per-round directive gate.
    // RFC-132 (PR-C §7): the cross-questioner path no longer has its own SELECT branch nor an
    // applyLatestDirective gate — the unified flat injector (buildClarifyQueueContext) queries every
    // role in one shot, and the standing continue/stop directive is the per-node clarify state
    // (nodeStopOverride, from getNodeClarifyDirectiveRow). The cci-rerun stop-scoping is preserved
    // via nodeStopOverride flowing into resolveEffectiveClarifyChannel + shouldInjectStopNotice.
    const source = AGENT_MECHANICS_SOURCE
    expect(source).not.toContain('applyLatestDirective')
    expect(source).not.toContain("consumerKind: 'cross-questioner'")
    expect(source).toContain('await collaboration.buildClarifyQueueContext({')
    // RFC-482: the per-node directive is Task Execution's own read (persistence bundle), not a collaboration call.
    expect(source).toContain('await clarifyDirectives.get(taskId, node.id)')
    expect(source).not.toContain('collaboration.getNodeClarifyDirective')
    expect(source).toContain('const nodeStopOverride = nodeDirective === ')
  })
})
