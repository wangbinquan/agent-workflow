// RFC-396: the abcacb artifact bound flow edges before their semantic nodes.
// These DOM shapes retain Mermaid 11.15's edge/lifeline order and node IDs;
// the actual renderer is additionally covered by the RFC-396 browser journey.
import { beforeEach, expect, test, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GraphModelView } from '@/features/development-automation/graph-development/GraphModelView'
import type { GraphViewData } from '@/features/development-automation/graph-development/graphDesignModel'

const renderMermaid = vi.hoisted(() => vi.fn())
vi.mock('@/components/review/MermaidBlock', () => ({
  MermaidBlock: { render: renderMermaid },
}))
vi.mock('@/hooks/useTheme', () => ({ useResolvedTheme: () => 'light' }))
vi.mock('@/components/prose/Prose', () => ({
  Prose: ({ body }: { body: string }) => <div>{body}</div>,
}))

type Rendering = GraphViewData['renderings'][number]
const elementIndex = [
  { renderId: 'g123', elementId: 'first', label: 'First node' },
  { renderId: 'g1234', elementId: 'second', label: 'Second node' },
]
function rendering(source = 'flowchart TD'): Rendering {
  return { modelId: 'model', format: 'mermaid', source, elementIndex }
}

function nodeSvg(prefix: 'flowchart' | 'state' | 'entity', withSvgPrefix = true) {
  const idPrefix = withSvgPrefix ? `mermaid-fixture-${prefix}` : prefix
  return `<svg id="mermaid-fixture" xmlns="http://www.w3.org/2000/svg">
    <g class="edgePaths">
      <path id="mermaid-fixture-L_g123_g1234_0" data-id="L_g123_g1234_0" />
    </g>
    <g class="edgeLabels"><g class="label" id="${idPrefix}-g123-0">Edge label</g></g>
    <g class="nodes">
      <g class="node default" id="${idPrefix}-g1234-1"><text>Second node</text></g>
      <g class="node default" id="${idPrefix}-g123-0"><text>First node</text></g>
      <g class="node default" id="${idPrefix}-g123-note-2"><text>Unindexed note</text></g>
    </g>
  </svg>`
}

const sequenceSvg = `<svg id="mermaid-sequence" xmlns="http://www.w3.org/2000/svg">
  <g><line id="actor0" data-et="life-line" data-id="g123" />
    <g data-et="participant" data-type="participant" data-id="g123">
      <rect class="actor actor-top" name="g123"/><text class="actor actor-box">First node</text>
    </g>
  </g>
  <g><line id="actor1" data-et="life-line" data-id="g1234" />
    <g data-et="participant" data-type="participant" data-id="g1234">
      <rect class="actor actor-top" name="g1234"/><text class="actor actor-box">Second node</text>
    </g>
  </g>
  <line data-et="message" data-from="g123" data-to="g1234" />
  <g><rect class="actor actor-bottom" name="g123"/><text class="actor actor-box">First node</text></g>
  <g><rect class="actor actor-bottom" name="g1234"/><text class="actor actor-box">Second node</text></g>
</svg>`

beforeEach(() => {
  renderMermaid.mockReset()
  renderMermaid.mockImplementation(async (mount: HTMLElement) => {
    mount.innerHTML = nodeSvg('flowchart')
  })
})

test.each([
  ['flowchart', 'flowchart TD', true],
  ['flowchart', 'flowchart TD', false],
  ['state', 'stateDiagram-v2', false],
  ['state', 'stateDiagram-v2', true],
  ['entity', 'erDiagram', false],
  ['entity', 'erDiagram', true],
] as const)(
  '%s node containers (%s, SVG prefix: %s) exclude edges, labels and ID prefixes',
  async (prefix, source, prefixed) => {
    renderMermaid.mockImplementation(async (mount: HTMLElement) => {
      mount.innerHTML = nodeSvg(prefix, prefixed)
    })
    const onSelect = vi.fn()
    const view = rendering(source)
    const { container, rerender } = render(
      <GraphModelView rendering={view} selectedIds={['first']} onSelect={onSelect} zh={false} />,
    )
    const first = await screen.findByRole('button', { name: 'First node', pressed: true })
    const second = screen.getByRole('button', { name: 'Second node', pressed: false })
    expect(screen.getAllByRole('button')).toHaveLength(2)
    expect(first.tagName.toLowerCase()).toBe('g')
    expect(first.classList.contains('node')).toBe(true)
    expect(second.id).toContain('-g1234-1')
    for (const excluded of container.querySelectorAll('path, .edgeLabels *, [id$="-note-2"]')) {
      expect(excluded.hasAttribute('role')).toBe(false)
      expect(excluded.hasAttribute('aria-pressed')).toBe(false)
      fireEvent.click(excluded)
    }
    expect(onSelect).not.toHaveBeenCalled()
    for (const [target, id] of [
      [first, 'first'],
      [second, 'second'],
    ] as const) {
      expect(target.getAttribute('tabindex')).toBe('0')
      fireEvent.click(target.querySelector('text')!)
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(id)
      onSelect.mockClear()
      for (const key of ['Enter', ' ']) {
        expect(fireEvent.keyDown(target, { key })).toBe(false)
        expect(onSelect).toHaveBeenCalledExactlyOnceWith(id)
        onSelect.mockClear()
      }
      fireEvent.keyDown(target, { key: 'Escape' })
      expect(onSelect).not.toHaveBeenCalled()
    }
    rerender(
      <GraphModelView rendering={view} selectedIds={['second']} onSelect={onSelect} zh={false} />,
    )
    expect(first.getAttribute('aria-pressed')).toBe('false')
    expect(second.getAttribute('aria-pressed')).toBe('true')
    expect(renderMermaid).toHaveBeenCalledTimes(1)
  },
)

test('sequence participants select independently of lifelines and synchronize mirrored actors', async () => {
  renderMermaid.mockImplementation(async (mount: HTMLElement) => {
    mount.innerHTML = sequenceSvg
  })
  const view = rendering('sequenceDiagram')
  const onSelect = vi.fn()
  const { container, rerender } = render(
    <GraphModelView rendering={view} selectedIds={['first']} onSelect={onSelect} zh={false} />,
  )
  await screen.findAllByRole('button', { name: 'First node', pressed: true })
  expect(screen.getAllByRole('button')).toHaveLength(4)
  for (const line of container.querySelectorAll('line')) {
    expect(line.hasAttribute('role')).toBe(false)
    fireEvent.click(line)
  }
  expect(onSelect).not.toHaveBeenCalled()
  for (const item of elementIndex) {
    const actors = screen.getAllByRole('button', { name: item.label })
    expect(actors).toHaveLength(2)
    for (const actor of actors) {
      expect(actor.tagName.toLowerCase()).toBe('g')
      fireEvent.click(actor.querySelector('text')!)
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(item.elementId)
      onSelect.mockClear()
      for (const key of ['Enter', ' ']) {
        expect(fireEvent.keyDown(actor, { key })).toBe(false)
        expect(onSelect).toHaveBeenCalledExactlyOnceWith(item.elementId)
        onSelect.mockClear()
      }
    }
  }
  rerender(
    <GraphModelView rendering={view} selectedIds={['second']} onSelect={onSelect} zh={false} />,
  )
  expect(screen.getAllByRole('button', { name: 'First node', pressed: false })).toHaveLength(2)
  expect(screen.getAllByRole('button', { name: 'Second node', pressed: true })).toHaveLength(2)
  expect(renderMermaid).toHaveBeenCalledTimes(1)
})

test('rerender and unmount remove old click and keyboard handlers', async () => {
  const view = rendering()
  const firstSelect = vi.fn(),
    nextSelect = vi.fn()
  const { rerender, unmount } = render(
    <GraphModelView rendering={view} selectedIds={[]} onSelect={firstSelect} zh={false} />,
  )
  const previous = await screen.findByRole('button', { name: 'First node' })
  rerender(<GraphModelView rendering={view} selectedIds={[]} onSelect={nextSelect} zh={false} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'First node' })).not.toBe(previous))
  fireEvent.click(previous)
  fireEvent.keyDown(previous, { key: 'Enter' })
  expect(firstSelect).not.toHaveBeenCalled()
  expect(nextSelect).not.toHaveBeenCalled()
  const current = screen.getByRole('button', { name: 'First node' })
  fireEvent.click(current)
  expect(nextSelect).toHaveBeenCalledExactlyOnceWith('first')
  unmount()
  fireEvent.click(current)
  fireEvent.keyDown(current, { key: ' ' })
  expect(nextSelect).toHaveBeenCalledTimes(1)
})

test('a disposed asynchronous render cannot replace the current diagram', async () => {
  let finishOld!: () => void
  renderMermaid.mockImplementationOnce(
    (mount: HTMLElement) =>
      new Promise<void>((resolve) => {
        finishOld = () => {
          mount.innerHTML = nodeSvg('flowchart')
          resolve()
        }
      }),
  )
  const onSelect = vi.fn()
  const { rerender } = render(
    <GraphModelView rendering={rendering()} selectedIds={[]} onSelect={onSelect} zh={false} />,
  )
  renderMermaid.mockImplementation(async (mount: HTMLElement) => {
    mount.innerHTML = sequenceSvg
  })
  rerender(
    <GraphModelView
      rendering={rendering('sequenceDiagram')}
      selectedIds={['second']}
      onSelect={onSelect}
      zh={false}
    />,
  )
  await screen.findAllByRole('button', { name: 'Second node', pressed: true })
  await act(async () => {
    finishOld()
  })
  expect(screen.getAllByRole('button')).toHaveLength(4)
  expect(screen.getAllByRole('button', { name: 'Second node', pressed: true })).toHaveLength(2)
  expect(document.querySelector('#mermaid-fixture')).toBeNull()
})

test('markdown keeps its semantic list contract and removes a previous SVG binding', async () => {
  const onSelect = vi.fn()
  const { container, rerender } = render(
    <GraphModelView rendering={rendering()} selectedIds={[]} onSelect={onSelect} zh={false} />,
  )
  const previous = await screen.findByRole('button', { name: 'First node' })
  rerender(
    <GraphModelView
      rendering={{ ...rendering(), format: 'markdown', source: 'Decision table' }}
      selectedIds={[]}
      onSelect={onSelect}
      zh={false}
    />,
  )
  expect(screen.getByText('Decision table')).toBeDefined()
  expect(container.querySelector('svg')).toBeNull()
  fireEvent.click(previous)
  expect(onSelect).not.toHaveBeenCalled()
  expect(renderMermaid).toHaveBeenCalledTimes(1)
})
