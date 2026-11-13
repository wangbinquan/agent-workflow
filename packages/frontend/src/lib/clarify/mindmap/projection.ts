import {
  isClarifyAnswerConfirmed,
  isClarifyAnswerValid,
  type ClarifyAnswer,
  type ClarifyDecision,
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
  answerSummary?: string
  decisionStatus?: ClarifyDecision['status']
  ownStatus?: MindmapNodeStatus
  status: MindmapNodeStatus
  counts: MindmapStatusCounts
  /** RFC-490: a configured category with no question under it yet. It carries no
   *  status of its own and never counts towards any total. */
  empty?: boolean
  /** RFC-490: wording the outline search matches beyond the title: option labels,
   *  descriptions and recommendation reasons, the custom answer and the rationale. */
  searchText?: string
}
const emptyCounts = (): MindmapStatusCounts => ({ done: 0, needs_detail: 0, needs_confirmation: 0 })
/** The node a follow-up target names: a question, a category, or the root. */
export function mindmapTargetNodeId(target: string | readonly string[]): string {
  if (typeof target === 'string') return `q:${target}`
  return target.length ? `g:${JSON.stringify(target)}` : 'root'
}
/** Display-only projection: no separate answers, state transitions or persistence. */
export function projectClarifyMindmap(
  questions: readonly ClarifyQuestion[],
  answers: Readonly<Record<string, ClarifyAnswer>>,
  locked: ReadonlySet<string>,
  title: string,
  categoryPaths: readonly (readonly string[])[] = [],
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
  /** Creates every missing category on the path and returns the deepest one. */
  const category = (categoryPath: readonly string[]): string => {
    let parentId = 'root'
    for (let i = 0; i < categoryPath.length; i++) {
      const path = categoryPath.slice(0, i + 1)
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
    return parentId
  }
  for (const [order, q] of questions.entries()) {
    const parentId = q.mindmap?.parentQuestionId
      ? `q:${q.mindmap.parentQuestionId}`
      : category(q.mindmap?.categoryPath ?? [])
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
      answerSummary: clarifyAnswerPreview(q, answer),
      decisionStatus: answer?.decision?.status,
      ownStatus,
      status: ownStatus,
      counts: { ...emptyCounts(), [ownStatus]: 1 },
      searchText: [
        ...q.options.flatMap((option) => [
          option.label,
          option.description,
          option.recommendationReason,
        ]),
        answer?.customText,
        answer?.decision?.rationale,
      ]
        .filter(Boolean)
        .join('\n'),
    })
  }
  // Configured categories nobody asked about come last, after the model's own order.
  for (const path of categoryPaths) category(path)
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
    if (
      node.kind === 'group' &&
      node.id !== 'root' &&
      node.counts.done + node.counts.needs_detail + node.counts.needs_confirmation === 0
    )
      node.empty = true
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

/** Answer labels come from the question, never stale draft labels or an AI rewrite. */
export function clarifyAnswerPreview(
  question: ClarifyQuestion,
  answer: ClarifyAnswer | undefined,
): string {
  if (!answer) return ''
  return [
    ...answer.selectedOptionIndices.map((index) => question.options[index]?.label).filter(Boolean),
    answer.customText,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** RFC-490: the words around a search hit that is not in the title, for the result row. */
export function mindmapSearchSnippet(text: string, query: string, radius = 18): string {
  const at = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
  if (at < 0 || !query) return ''
  const start = Math.max(0, at - radius)
  const end = Math.min(text.length, at + query.length + radius)
  return (
    (start > 0 ? '…' : '') +
    text.slice(start, end).replace(/\s+/g, ' ') +
    (end < text.length ? '…' : '')
  )
}

/** Compress decorative category chains on the canvas only. Outline and target IDs stay canonical. */
export function compressMindmapCategories(
  nodes: readonly MindmapNodeSummary[],
  preserve: ReadonlySet<string> = new Set(),
): MindmapNodeSummary[] {
  const children = new Map<string, MindmapNodeSummary[]>()
  for (const node of nodes)
    if (node.parentId) {
      const list = children.get(node.parentId) ?? []
      list.push(node)
      children.set(node.parentId, list)
    }
  const omitted = new Map<string, { parentId: string | null; prefix: string }>()
  const result: MindmapNodeSummary[] = []
  for (const node of nodes) {
    const parent = node.parentId ? omitted.get(node.parentId) : undefined
    const parentId = parent ? parent.parentId : node.parentId
    const title = parent ? `${parent.prefix} / ${node.title}` : node.title
    const descendants = children.get(node.id)
    if (
      node.id !== 'root' &&
      node.kind === 'group' &&
      !preserve.has(node.id) &&
      descendants?.length === 1 &&
      descendants[0]!.kind === 'group'
    ) {
      omitted.set(node.id, { parentId, prefix: title })
    } else result.push({ ...node, parentId, title })
  }
  return result
}
