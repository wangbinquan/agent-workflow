// RFC-146 T4 — node display-title single source.
//
// The derivation used to exist twice and had already drifted: the canvas
// card rule (WorkflowCanvas.nodeTitle: title → agentName/inputKey → id) knew
// nothing about review nodes, while the loop-candidates rule
// (wrapperCandidates.deriveTitle: title → agentName → review:<port> → '')
// carried the `review:<port>` special case the canvas lacked. This module is
// the one full rule; callers only choose the empty-fallback (canvas appends
// `?? id`, candidate labels keep '' so the UI renders the bare nodeId).

import { isCodeHostAction, resolveNodeAgent, type WorkflowNode } from '@agent-workflow/shared'
import i18n from '@/i18n'

interface DisplayAgent {
  name: string
}

type DisplayAgentLookup =
  | ReadonlyMap<string, DisplayAgent>
  | Readonly<Record<string, DisplayAgent | undefined>>

/**
 * Referenced-agent display name, independent from the node's custom title.
 *
 * The current configured resource name wins over the persisted display
 * snapshot. Keeping this separate from nodeDisplayTitle() lets AgentNode show
 * the same "custom node title + referenced resource" hierarchy as the two
 * call-resource cards.
 */
export function nodeAgentDisplayName(n: WorkflowNode, agents?: DisplayAgentLookup): string {
  if (n.kind !== 'agent-single') return ''
  const rec = n as unknown as Record<string, unknown>
  const configuredName = agents === undefined ? undefined : resolveNodeAgent(n, agents)?.name
  if (typeof configuredName === 'string' && configuredName.length > 0) return configuredName
  return typeof rec.agentName === 'string' && rec.agentName.length > 0 ? rec.agentName : ''
}

/**
 * Full display-title derivation, WITHOUT the final id fallback:
 *   1. user-set `title` (review/clarify historically wrote it directly;
 *      every kind opts in via the Inspector's display-name field);
 *   2. agent-single → the configured agent's current name, then the node's
 *      display snapshot; an unresolved node returns '' for the caller's id
 *      fallback rather than claiming that its agent is unset;
 *   3. input → inputKey (or the localized "(unset key)");
 *   4. review → `review:<port>` when inputSource.portName is wired;
 *   5. call-workflow → workflowName (or the localized kind label, RFC-243);
 *   6. call-workgroup → workgroupName (same rule, RFC-243 PR-4);
 *   7. code-host-call → localized action label (or the localized kind label);
 *   8. otherwise '' — callers decide the id fallback.
 */
export function nodeDisplayTitle(n: WorkflowNode, agents?: DisplayAgentLookup): string {
  const rec = n as unknown as Record<string, unknown>
  if (typeof rec.title === 'string' && rec.title.length > 0) {
    return rec.title
  }
  if (n.kind === 'agent-single') {
    return nodeAgentDisplayName(n, agents)
  }
  if (n.kind === 'call-workflow') {
    // RFC-243 — the referenced workflow name IS the node's identity (same
    // rule as agentName); an unset ref falls back to the kind label rather
    // than the raw node id so fresh drops read as "调用工作流".
    return typeof rec.workflowName === 'string' && rec.workflowName.length > 0
      ? rec.workflowName
      : i18n.t('callWorkflowNode.label')
  }
  if (n.kind === 'call-workgroup') {
    // RFC-243 PR-4 — workgroup twin of the rule above: workgroupName is the
    // identity, kind label the unset fallback.
    return typeof rec.workgroupName === 'string' && rec.workgroupName.length > 0
      ? rec.workgroupName
      : i18n.t('callWorkgroupNode.label')
  }
  if (n.kind === 'code-host-call') {
    const action = rec.action
    return isCodeHostAction(action)
      ? i18n.t(`codeHostAction.${action.replace('.', '_')}`, { defaultValue: action })
      : i18n.t('codeHostNode.label')
  }
  if (n.kind === 'input') {
    return typeof rec.inputKey === 'string' ? rec.inputKey : i18n.t('editor.nodeTitleUnsetKey')
  }
  if (n.kind === 'review') {
    // flag-audit W0（§3-4）：schema 字段是 inputSource（shared/schemas/review.ts）。
    const src = (rec.inputSource as { portName?: unknown } | undefined)?.portName
    if (typeof src === 'string' && src.length > 0) return `review:${src}`
  }
  return ''
}

/** Canvas card title: the full rule with the node-id fallback. */
export function nodeTitle(n: WorkflowNode, agents?: DisplayAgentLookup): string {
  const derived = nodeDisplayTitle(n, agents)
  return derived.length > 0 ? derived : n.id
}
