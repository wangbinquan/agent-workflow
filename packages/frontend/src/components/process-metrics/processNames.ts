// RFC-616 §11 — the display name of a stage, member or work item. The server
// sends raw keys for platform work and for members it may not name; the page
// gives them their product names here, in one place.
import type {
  ProcessMemberRole,
  ProcessStageKind,
  ProcessSubjectSummary,
} from '@agent-workflow/shared'
import { labelText, type ProcessLabel, type Translate } from './processFormat'

export function stageName(
  stage: { readonly key: string; readonly label: ProcessLabel; readonly kind: ProcessStageKind },
  t: Translate,
  language: string,
): string {
  if (stage.kind === 'system' || stage.key === 'unattributed')
    return t(`processMetrics.systemStage.${systemStageMessageKey(stage.key)}`, {
      defaultValue: labelText(stage.label, language),
    })
  const label = labelText(stage.label, language)
  // A member the server may not name (people folded together, an unnamed leader) arrives with
  // its key as its label: it is shown by its role, never by the key.
  if (
    label === stage.key &&
    (stage.kind === 'leader' || stage.kind === 'member-agent' || stage.kind === 'member-human')
  )
    return t(`processMetrics.member.${stage.kind}`)
  return label
}

/**
 * Stages as a tree in reading order: a wrapper directly before what runs inside it, at any
 * depth. The server lists stages in the order the definition stores its nodes, and a wrapper
 * drawn around existing nodes is stored after them.
 */
export function stageTree<T extends { readonly key: string; readonly parentKey: string | null }>(
  stages: readonly T[],
): { readonly stage: T; readonly depth: number }[] {
  const keys = new Set(stages.map((stage) => stage.key))
  const children = new Map<string | null, T[]>()
  for (const stage of stages) {
    // A parent that is not listed (or a stage naming itself) leaves the stage at the top.
    const parent =
      stage.parentKey !== null && stage.parentKey !== stage.key && keys.has(stage.parentKey)
        ? stage.parentKey
        : null
    const siblings = children.get(parent)
    if (siblings) siblings.push(stage)
    else children.set(parent, [stage])
  }
  const rows: { stage: T; depth: number }[] = []
  const placed = new Set<string>()
  const walk = (parent: string | null, depth: number) => {
    for (const stage of children.get(parent) ?? []) {
      if (placed.has(stage.key)) continue
      placed.add(stage.key)
      rows.push({ stage, depth })
      walk(stage.key, depth + 1)
    }
  }
  walk(null, 0)
  // Stages that only reach each other (a damaged definition) still get a row each.
  for (const stage of stages) {
    if (placed.has(stage.key)) continue
    placed.add(stage.key)
    rows.push({ stage, depth: 0 })
  }
  return rows
}

/** `system:repo-prep` → `system-repo-prep`: a colon would be read as a message namespace. */
export function systemStageMessageKey(stageKey: string): string {
  return stageKey.replace(':', '-')
}

export function memberName(
  member: { readonly key: string; readonly name: string | null; readonly role: ProcessMemberRole },
  t: Translate,
): string {
  if (member.role === 'unattributed') return t('processMetrics.member.unattributed')
  if (member.name !== null && member.name !== '') return member.name
  return t(`processMetrics.member.${member.role}`)
}

/** Every stage-like key of a summary with its display name, for hints and themes. */
export function stageNamesOf(
  summary: ProcessSubjectSummary,
  t: Translate,
  language: string,
): Map<string, string> {
  if (summary.kind === 'workflow')
    return new Map(summary.stages.map((stage) => [stage.key, stageName(stage, t, language)]))
  if (summary.kind === 'workgroup')
    return new Map(summary.members.map((member) => [member.key, memberName(member, t)]))
  return new Map(summary.workItems.map((item) => [item.key, stageName(item, t, language)]))
}
