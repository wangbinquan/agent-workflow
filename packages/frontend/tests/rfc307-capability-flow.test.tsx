// RFC-307 — the capability flow renders, distinguishes the four stage kinds,
// and carries the round's state onto it.
//
// The kind distinction is the assertion that matters most. RFC-304's second
// constitution is "program where a program suffices", and the fact a reader is
// meant to take from this picture is that thirteen steps contain only two model
// calls. If every card renders the same, the picture is decorative.

import { render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { CapabilityFlow, type CapabilityGraphNode } from '../src/components/code/CapabilityFlow'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const node = (
  name: string,
  kind: CapabilityGraphNode['kind'],
  over: Partial<CapabilityGraphNode> = {},
): CapabilityGraphNode => ({
  name,
  kind,
  index: 0,
  requires: [],
  produces: [],
  parallel: false,
  injectable: [],
  terminal: [],
  ...over,
})

const NODES: CapabilityGraphNode[] = [
  node('collect', 'program', { index: 0, produces: ['diff'] }),
  node('review-shard', 'ai', {
    index: 1,
    requires: ['diff'],
    produces: ['findings'],
    parallel: true,
    agentSlot: 'reviewer',
    injectable: ['promptSuffix'],
  }),
  node('gate', 'script', { index: 2, requires: ['findings'], scriptSlot: 'select' }),
  node('sub', 'invoke', {
    index: 3,
    requires: ['findings'],
    invokes: { capability: 'mr-review', from: 'a', to: 'b', stages: ['a', 'b'] },
  }),
]

const EDGES = [
  { id: 'e1', from: 'collect', to: 'review-shard', artifact: 'diff' },
  { id: 'e2', from: 'review-shard', to: 'gate', artifact: 'findings' },
]

describe('CapabilityFlow', () => {
  test('renders one card per stage', () => {
    render(<CapabilityFlow nodes={NODES} edges={EDGES} />)
    for (const stage of NODES) {
      expect(screen.getByTestId(`stage-node-${stage.name}`)).toBeTruthy()
    }
  })

  test('the four stage kinds are visually distinct, not one grey box each', () => {
    render(<CapabilityFlow nodes={NODES} edges={EDGES} />)
    // `data-stage-kind` is what the CSS accents key off. Asserting the
    // attribute rather than a colour keeps the test about the contract between
    // component and stylesheet.
    expect(screen.getByTestId('stage-node-collect').getAttribute('data-stage-kind')).toBe('program')
    expect(screen.getByTestId('stage-node-review-shard').getAttribute('data-stage-kind')).toBe('ai')
    expect(screen.getByTestId('stage-node-gate').getAttribute('data-stage-kind')).toBe('script')
    expect(screen.getByTestId('stage-node-sub').getAttribute('data-stage-kind')).toBe('invoke')
  })

  test('the cards reuse the canvas card classes, so status colours come for free', () => {
    // The reason this component does not reimplement node chrome: the existing
    // `.canvas-node[data-status=…]` rules already paint running/done/failed.
    const card = render(<CapabilityFlow nodes={NODES} edges={EDGES} />).container.querySelector(
      '[data-testid="stage-node-collect"]',
    )
    expect(card?.classList.contains('canvas-node')).toBe(true)
    expect(card?.classList.contains('canvas-node--card')).toBe(true)
  })

  test('a stage with no run row is PENDING, not missing', () => {
    // The picture is the whole sequence at every moment. Drawing only the
    // stages that have rows would make a round in flight look like a two-step
    // capability.
    render(
      <CapabilityFlow nodes={NODES} edges={EDGES} statuses={{ collect: { status: 'done' } }} />,
    )
    expect(screen.getByTestId('stage-node-collect').getAttribute('data-status')).toBe('done')
    expect(screen.getByTestId('stage-node-gate').getAttribute('data-status')).toBe('pending')
    expect(screen.getByTestId('stage-node-sub')).toBeTruthy()
  })

  test('with no statuses at all the cards carry NO status — the structural view', () => {
    render(<CapabilityFlow nodes={NODES} edges={EDGES} />)
    expect(screen.getByTestId('stage-node-collect').getAttribute('data-status')).toBeNull()
  })

  test('a failed stage shows its reason on the card, not just a colour', () => {
    render(
      <CapabilityFlow
        nodes={NODES}
        edges={EDGES}
        statuses={{ gate: { status: 'failed', error: 'gate script exited 2' } }}
      />,
    )
    const card = screen.getByTestId('stage-node-gate')
    expect(card.getAttribute('data-status')).toBe('failed')
    expect(card.textContent).toContain('gate script exited 2')
  })

  test('stages sharing the selected slot are marked as siblings', () => {
    render(<CapabilityFlow nodes={NODES} edges={EDGES} siblings={['gate']} />)
    expect(screen.getByTestId('stage-node-gate').classList.contains('stage-node--sibling')).toBe(
      true,
    )
    expect(screen.getByTestId('stage-node-collect').classList.contains('stage-node--sibling')).toBe(
      false,
    )
  })

  test('slot and parallel facts reach the card', () => {
    render(<CapabilityFlow nodes={NODES} edges={EDGES} />)
    const ai = screen.getByTestId('stage-node-review-shard')
    // The slot line is what tells a reader which configuration key this step
    // reads — the exact link that was missing before this RFC.
    expect(ai.textContent).toContain('capabilityFlow.agentSlot')
    expect(ai.textContent).toContain('capabilityFlow.parallel')
    expect(screen.getByTestId('stage-node-gate').textContent).toContain('capabilityFlow.scriptSlot')
  })
})
