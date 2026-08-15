// RFC-304 T31b — turning "misconfigured" into something a person can act on.
//
// `deriveReadiness` already names the missing piece; this says where to go and
// fix it. The pairing lives here rather than in a component because the mapping
// from "no binding" to "the page that binds one" is a property of how this
// module is configured — a copy in the frontend would drift the day a route
// moves, and the symptom would be a fix link that 404s exactly when somebody is
// already stuck.
//
// The failure this exists to prevent is the one the design names as the most
// common reason a platform like this gets abandoned: configured, silent, and no
// way to tell why. A red label with no next step is only marginally better.

import type { ReadinessIssue } from '@/modules/code-capability/domain/templateLayers'
import type { CodeRepairAction } from '@/modules/code-capability/public/queries'

/**
 * Where each missing prerequisite is fixed.
 *
 * Exhaustive over `ReadinessIssue['code']` by construction — a `Record` of the
 * union, so adding a readiness code without a repair route fails the build
 * rather than silently rendering an issue nobody can act on.
 */
const REPAIR: Record<ReadinessIssue['code'], { label: string; route: string }> = {
  'no-binding': {
    label: 'Choose which review configuration this repository uses',
    route: '/code/bindings',
  },
  'no-trigger': {
    label: 'Connect a webhook so events can reach this repository',
    route: '/webhooks',
  },
  'code-host-unconfigured': {
    label: 'Add the code host connection this repository publishes through',
    route: '/settings/code-hosts',
  },
  'agent-not-visible': {
    // Distinct from `no-binding`: the binding exists, and the agent it names is
    // gone or not visible to this repository's audience. Sending someone to the
    // binding page is right — that is where the slot is re-pointed.
    label: 'Point the reviewer slot at an agent this repository can see',
    route: '/code/bindings',
  },
  'framework-missing': {
    label: 'Restore or replace the framework this binding was built on',
    route: '/code/frameworks',
  },
  'no-wake-source': {
    label: 'Give this capability something that can start it',
    route: '/webhooks',
  },
}

/**
 * Repair actions for a cell's issues, in the same order.
 *
 * Same order rather than sorted or deduped: the issues are already ordered by
 * `deriveReadiness`, and a UI that renders issue[i] beside action[i] must be
 * able to rely on that. Deduping would break the pairing for the (real) case
 * where two agent slots are both invisible.
 */
export function repairActionsFor(issues: readonly ReadinessIssue[]): readonly CodeRepairAction[] {
  return issues.map((issue) => ({
    code: issue.code,
    label: REPAIR[issue.code].label,
    route: REPAIR[issue.code].route,
  }))
}
