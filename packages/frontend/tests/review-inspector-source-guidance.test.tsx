// Review source UX contract. A review node does not accept an arbitrary text
// parameter: it snapshots exactly one agent output declared with a Markdown
// kind. RFC-354 (schema v6): that source IS the review's single
// `__review_input__` edge, wired on the canvas — the inspector must teach the
// contract from that edge (ready / invalid / unavailable), show what is
// wired, and let the author disconnect it; it offers no second picker.

import type { Agent, WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@agent-workflow/shared'
import { REVIEW_INPUT_PORT_NAME } from '@agent-workflow/shared'
import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { NodeInspector } from '../src/components/canvas/NodeInspector'
import { setLanguage } from '../src/i18n'

function storedAgent(
  id: string,
  name: string,
  outputs: string[],
  outputKinds: Record<string, string>,
): Agent {
  return {
    id,
    name,
    outputs,
    outputKinds,
  } as unknown as Agent
}

function agentNode(id: string, agent: Agent): WorkflowNode {
  return {
    id,
    kind: 'agent-single',
    agentId: agent.id,
    agentName: agent.name,
  } as unknown as WorkflowNode
}

function reviewNode(): WorkflowNode {
  return {
    id: 'review',
    kind: 'review',
    rerunnableOnReject: [],
    rerunnableOnIterate: [],
  } as unknown as WorkflowNode
}

/** RFC-354: the review input is this one edge. */
function reviewEdge(sourceNodeId: string, portName: string): WorkflowEdge {
  return {
    id: 'review-in',
    source: { nodeId: sourceNodeId, portName },
    target: { nodeId: 'review', portName: REVIEW_INPUT_PORT_NAME },
  }
}

function Host({
  initial,
  agents,
  onChangeSpy = () => {},
}: {
  initial: WorkflowDefinition
  agents: Agent[]
  onChangeSpy?: (definition: WorkflowDefinition) => void
}) {
  const [definition, setDefinition] = useState(initial)
  return (
    <NodeInspector
      definition={definition}
      selectedNodeId="review"
      agents={agents}
      onChange={(next) => {
        setDefinition(next)
        onChangeSpy(next)
      }}
      onClose={() => {}}
    />
  )
}

function definitionOf(nodes: WorkflowNode[], edges: WorkflowDefinition['edges'] = []) {
  return {
    $schema_version: 6 as const,
    inputs: [],
    nodes,
    edges,
  }
}

beforeEach(() => {
  setLanguage('en-US')
})

describe('review inspector source guidance', () => {
  test('comment injection uses one picker with review context and no unrelated task-runtime values', () => {
    const onChangeSpy = vi.fn()
    render(
      <Host
        initial={definitionOf([
          {
            ...reviewNode(),
            commentInjectTemplate: 'Review: ',
          } as WorkflowNode,
        ])}
        agents={[]}
        onChangeSpy={onChangeSpy}
      />,
    )
    const picker = screen.getByTestId('review-runtime-parameter-picker')
    const area = picker.closest('.form-field')?.querySelector('textarea') as HTMLTextAreaElement
    area.setSelectionRange(area.value.length, area.value.length)
    fireEvent.pointerDown(picker, { button: 0 })
    fireEvent.click(picker)
    const search = screen.getByRole('combobox', { name: /Search parameter|搜索参数/ })

    fireEvent.change(search, { target: { value: '__repo_path__' } })
    expect(screen.queryByRole('option', { name: /__repo_path__/ })).toBeNull()
    fireEvent.change(search, { target: { value: '__review_comments__' } })
    fireEvent.click(screen.getByRole('option', { name: /__review_comments__/ }))

    const latest = onChangeSpy.mock.calls.at(-1)?.[0] as WorkflowDefinition
    const review = latest.nodes.find((node) => node.id === 'review') as unknown as Record<
      string,
      unknown
    >
    expect(review.commentInjectTemplate).toBe('Review: {{__review_comments__}}')
  })

  test('explains the one required input and why a plain string output is unavailable', () => {
    const writer = storedAgent('agent-writer', 'writer', ['result'], { result: 'string' })
    render(
      <Host
        initial={definitionOf([agentNode('source', writer), reviewNode()])}
        agents={[writer]}
      />,
    )

    expect(screen.getByTestId('review-source-guide').textContent).toContain(
      'No reviewable output is available',
    )
    expect(screen.getByTestId('review-source-guide').textContent).toContain(
      'A plain string cannot be reviewed',
    )
    expect(screen.getByRole('link', { name: /Configure agent outputs/ }).getAttribute('href')).toBe(
      '/agents',
    )
    expect(screen.getByTestId('review-source-unwired')).toBeTruthy()
  })

  test('an unwired review with an eligible upstream tells the author to wire the edge — no form picker', () => {
    const writer = storedAgent('agent-writer', 'writer', ['draft', 'diagnostics'], {
      draft: 'markdown',
      diagnostics: 'string',
    })
    render(
      <Host
        initial={definitionOf([agentNode('source', writer), reviewNode()])}
        agents={[writer]}
      />,
    )
    const guide = screen.getByTestId('review-source-guide')
    expect(guide.textContent).toContain('Only one required input remains')
    expect(guide.textContent).toContain('input handle on the canvas')
    expect(screen.getByTestId('review-source-unwired')).toBeTruthy()
    expect(screen.queryByTestId('review-source-node')).toBeNull()
    expect(screen.queryByTestId('review-source-port')).toBeNull()
  })

  test('a wired Markdown edge reads as ready and Disconnect removes exactly that edge', () => {
    const writer = storedAgent('agent-writer', 'writer', ['draft'], { draft: 'markdown' })
    const onChangeSpy = vi.fn()
    render(
      <Host
        initial={definitionOf(
          [agentNode('source', writer), reviewNode()],
          [reviewEdge('source', 'draft')],
        )}
        agents={[writer]}
        onChangeSpy={onChangeSpy}
      />,
    )
    const guide = screen.getByTestId('review-source-guide')
    expect(guide.textContent).toContain('Review content is ready')
    expect(guide.textContent).toContain('single-document review')
    expect(screen.getByTestId('review-source-summary').textContent).toContain('draft')

    fireEvent.click(screen.getByTestId('review-source-disconnect'))
    const latest = onChangeSpy.mock.calls.at(-1)?.[0] as WorkflowDefinition
    expect(latest.edges).toEqual([])
    const review = latest.nodes.find((node) => node.id === 'review') as unknown as Record<
      string,
      unknown
    >
    expect('inputSource' in review).toBe(false)
    expect(screen.getByTestId('review-source-guide').textContent).toContain(
      'Only one required input remains',
    )
  })

  test('a wired non-Markdown edge is flagged as not reviewable', () => {
    const writer = storedAgent('agent-writer', 'writer', ['result'], { result: 'string' })
    render(
      <Host
        initial={definitionOf(
          [agentNode('source', writer), reviewNode()],
          [reviewEdge('source', 'result')],
        )}
        agents={[writer]}
      />,
    )
    expect(screen.getByTestId('review-source-guide').textContent).toContain('cannot be reviewed')
    expect(screen.getByTestId('review-source-summary').textContent).toContain('result')
  })

  test('identifies list<path<md>> as a multi-document review input', () => {
    const writer = storedAgent('agent-writer', 'writer', ['docs'], {
      docs: 'list<path<md>>',
    })
    render(
      <Host
        initial={definitionOf(
          [agentNode('source', writer), reviewNode()],
          [reviewEdge('source', 'docs')],
        )}
        agents={[writer]}
      />,
    )

    const guide = screen.getByTestId('review-source-guide')
    expect(guide.textContent).toContain('Review content is ready')
    expect(guide.textContent).toContain('multi-document review')
    expect(guide.textContent).toContain('list<path<md>>')
  })

  test('re-run pickers offer only the wired source and its reachable upstream', () => {
    const sourceAgent = storedAgent('agent-source', 'writer', ['draft'], { draft: 'markdown' })
    const ancestorAgent = storedAgent('agent-ancestor', 'researcher', ['notes'], {
      notes: 'string',
    })
    const unrelatedAgent = storedAgent('agent-unrelated', 'bystander', ['notes'], {
      notes: 'string',
    })
    render(
      <Host
        initial={definitionOf(
          [
            agentNode('ancestor', ancestorAgent),
            agentNode('source', sourceAgent),
            agentNode('unrelated', unrelatedAgent),
            reviewNode(),
          ],
          [
            {
              id: 'ancestor-source',
              source: { nodeId: 'ancestor', portName: 'notes' },
              target: { nodeId: 'source', portName: 'notes' },
            },
            reviewEdge('source', 'draft'),
          ],
        )}
        agents={[sourceAgent, ancestorAgent, unrelatedAgent]}
      />,
    )

    fireEvent.focus(screen.getByTestId('review-rerun-reject'))
    expect(screen.getByRole('option', { name: /writer \(source\)/i })).toBeTruthy()
    expect(screen.getByRole('option', { name: /researcher \(ancestor\)/i })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /bystander \(unrelated\)/i })).toBeNull()
  })
})
