import {
  isClarifyAnswerConfirmed,
  isClarifyAnswerValid,
  type ClarifyAnswer,
  type ClarifyQuestion,
} from '@agent-workflow/shared'

export type MindmapNodeStatus = 'done' | 'needs_detail' | 'needs_confirmation'
export type MindmapStatusCounts = Record<MindmapNodeStatus, number>
export interface MindmapNodeSummary {
  id: string
  parentId: string | null
  order: number
  title: string
  kind: 'group' | 'question'
  questionId?: string
  ownStatus?: MindmapNodeStatus
  status: MindmapNodeStatus
  counts: MindmapStatusCounts
}
const emptyCounts = (): MindmapStatusCounts => ({ done: 0, needs_detail: 0, needs_confirmation: 0 })
/** Display-only projection: no separate answers, state transitions or persistence. */
export function projectClarifyMindmap(
  questions: readonly ClarifyQuestion[],
  answers: Readonly<Record<string, ClarifyAnswer>>,
  locked: ReadonlySet<string>,
  title: string,
): MindmapNodeSummary[] {
  const nodes: MindmapNodeSummary[] = [
    {
      id: 'root',
      parentId: null,
      order: 0,
      kind: 'group',
      title,
      status: 'needs_detail',
      counts: emptyCounts(),
    },
  ]
  const groups = new Set(['root'])
  for (const [order, q] of questions.entries()) {
    let parentId = 'root'
    if (q.mindmap?.parentQuestionId) parentId = `q:${q.mindmap.parentQuestionId}`
    else
      for (let i = 0; i < (q.mindmap?.categoryPath.length ?? 0); i++) {
        const path = q.mindmap!.categoryPath.slice(0, i + 1)
        const id = `g:${JSON.stringify(path)}`
        if (!groups.has(id)) {
          groups.add(id)
          nodes.push({
            id,
            parentId,
            order: nodes.length,
            title: path[i]!,
            kind: 'group',
            status: 'needs_detail',
            counts: emptyCounts(),
          })
        }
        parentId = id
      }
    const answer = answers[q.id]
    const ownStatus: MindmapNodeStatus =
      locked.has(q.id) || isClarifyAnswerConfirmed(q, answer)
        ? 'done'
        : answer && isClarifyAnswerValid(q, answer)
          ? 'needs_confirmation'
          : 'needs_detail'
    nodes.push({
      id: `q:${q.id}`,
      questionId: q.id,
      parentId,
      order,
      title: q.title,
      kind: 'question',
      ownStatus,
      status: ownStatus,
      counts: { ...emptyCounts(), [ownStatus]: 1 },
    })
  }
  const children = new Map<string, MindmapNodeSummary[]>()
  for (const node of nodes) {
    if (node.parentId === null) continue
    const list = children.get(node.parentId) ?? []
    list.push(node)
    children.set(node.parentId, list)
  }
  const ordered: MindmapNodeSummary[] = []
  const stack = [nodes[0]!]
  const visited = new Set<string>()
  while (stack.length) {
    const node = stack.pop()!
    if (visited.has(node.id)) continue
    visited.add(node.id)
    ordered.push(node)
    stack.push(...[...(children.get(node.id) ?? [])].reverse())
  }
  const byId = new Map(nodes.map((n) => [n.id, n]))
  for (const node of [...ordered].reverse()) {
    node.status = node.counts.needs_detail
      ? 'needs_detail'
      : node.counts.needs_confirmation
        ? 'needs_confirmation'
        : 'done'
    const parent = node.parentId ? byId.get(node.parentId) : undefined
    if (parent)
      for (const key of Object.keys(node.counts) as MindmapNodeStatus[])
        parent.counts[key] += node.counts[key]
  }
  return ordered
}
export function visibleMindmapNodes(
  nodes: readonly MindmapNodeSummary[],
  collapsed: ReadonlySet<string>,
): MindmapNodeSummary[] {
  const hidden = new Set<string>()
  return nodes.filter((node) => {
    if (node.parentId && (collapsed.has(node.parentId) || hidden.has(node.parentId))) {
      hidden.add(node.id)
      return false
    }
    return true
  })
}
