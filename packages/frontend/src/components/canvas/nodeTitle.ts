// RFC-146 T4 — node display-title single source.
//
// The derivation used to exist twice and had already drifted: the canvas
// card rule (WorkflowCanvas.nodeTitle: title → agentName/inputKey → id) knew
// nothing about review nodes, while the loop-candidates rule
// (wrapperCandidates.deriveTitle: title → agentName → review:<port> → '')
// carried the `review:<port>` special case the canvas lacked. This module is
// the one full rule; callers only choose the empty-fallback (canvas appends
// `?? id`, candidate labels keep '' so the UI renders the bare nodeId).

import type { WorkflowNode } from '@agent-workflow/shared'
import i18n from '@/i18n'

/**
 * Full display-title derivation, WITHOUT the final id fallback:
 *   1. user-set `title` (review/clarify historically wrote it directly;
 *      every kind opts in via the Inspector's display-name field);
 *   2. agent-single → agentName (or the localized "(unset agent)");
 *   3. input → inputKey (or the localized "(unset key)");
 *   4. review → `review:<port>` when inputSource.portName is wired;
 *   5. call-workflow → workflowName (or the localized kind label, RFC-243);
 *   6. call-workgroup → workgroupName (same rule, RFC-243 PR-4);
 *   7. otherwise '' — callers decide the id fallback.
 */
export function nodeDisplayTitle(n: WorkflowNode): string {
  const rec = n as unknown as Record<string, unknown>
  if (typeof rec.title === 'string' && rec.title.length > 0) {
    return rec.title
  }
  if (n.kind === 'agent-single') {
    return typeof rec.agentName === 'string' && rec.agentName.length > 0
      ? rec.agentName
      : i18n.t('editor.nodeTitleUnsetAgent')
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
export function nodeTitle(n: WorkflowNode): string {
  const derived = nodeDisplayTitle(n)
  return derived.length > 0 ? derived : n.id
}
