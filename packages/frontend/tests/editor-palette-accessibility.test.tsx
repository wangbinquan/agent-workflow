import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { createRef, useState } from 'react'
import { I18nextProvider } from 'react-i18next'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { EditorSidebar } from '../src/components/canvas/EditorSidebar'
import {
  WorkflowCanvas,
  type WorkflowCanvasHandle,
  viewportCenter,
} from '../src/components/canvas/WorkflowCanvas'
import i18n from '../src/i18n'

const EMPTY_DEFINITION: WorkflowDefinition = {
  $schema_version: 3,
  inputs: [],
  nodes: [],
  edges: [],
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('accessible workflow palette activation', () => {
  test('a real button preserves HTML5 drag and click inserts exactly once', () => {
    const onAdd = vi.fn()
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <EditorSidebar agents={[]} onAdd={onAdd} />
      </I18nextProvider>,
    )
    const item = container.querySelector<HTMLButtonElement>('.editor-sidebar__item')
    expect(item).not.toBeNull()
    expect(item?.tagName).toBe('BUTTON')
    expect(item?.getAttribute('draggable')).toBe('true')

    const setData = vi.fn()
    const dataTransfer = { setData, effectAllowed: 'none' }
    fireEvent.dragStart(item!, { dataTransfer })
    expect(setData).toHaveBeenCalledTimes(2)
    expect(onAdd).not.toHaveBeenCalled()

    fireEvent.click(item!)
    expect(onAdd).toHaveBeenCalledTimes(1)
  })

  test('native button semantics cover Enter and Space without a duplicate key handler', () => {
    const src = readFileSync(
      resolve(__dirname, '../src/components/canvas/EditorSidebar.tsx'),
      'utf8',
    )
    const item = src.match(
      /<button[\s\S]*?draggable[\s\S]*?onDragStart=\{[\s\S]*?onClick=\{\(\) => onAdd\(entry\.item\)\}[\s\S]*?<\/button>/,
    )
    expect(item).not.toBeNull()
    expect(item?.[0]).toContain('type="button"')
    // Native buttons synthesize one click for Enter / Space. A parallel
    // onKeyDown activation path would double-add a node in real browsers.
    expect(item?.[0]).not.toContain('onKeyDown')
  })

  test('imperative center insertion appends and selects the same fresh node', async () => {
    const handle = createRef<WorkflowCanvasHandle>()
    const onChange = vi.fn()
    const onSelect = vi.fn()

    function Harness() {
      const [definition, setDefinition] = useState(EMPTY_DEFINITION)
      return (
        <I18nextProvider i18n={i18n}>
          <WorkflowCanvas
            ref={handle}
            definition={definition}
            onChange={(next) => {
              onChange(next)
              setDefinition(next)
            }}
            onSelect={onSelect}
          />
        </I18nextProvider>
      )
    }

    const { container } = render(<Harness />)
    const canvas = container.querySelector<HTMLElement>('.workflow-canvas')
    expect(canvas).not.toBeNull()
    Object.defineProperty(canvas, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        left: 10,
        top: 20,
        width: 480,
        height: 360,
        right: 490,
        bottom: 380,
        x: 10,
        y: 20,
        toJSON: () => ({}),
      }),
    })

    act(() => handle.current?.addPaletteItemAtViewportCenter({ kind: 'input' }))

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]?.[0] as WorkflowDefinition
    expect(next.nodes).toHaveLength(1)
    expect(next.nodes[0]?.kind).toBe('input')
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(onSelect).toHaveBeenCalledWith({ kind: 'node', id: next.nodes[0]?.id })
    await waitFor(() => expect(container.querySelectorAll('.react-flow__node')).toHaveLength(1))
    await waitFor(() =>
      expect(container.querySelector('.react-flow__node')?.classList.contains('selected')).toBe(
        true,
      ),
    )
  })

  test('screen placement uses the current canvas rectangle center', () => {
    expect(viewportCenter({ left: 10, top: 20, width: 480, height: 360 })).toEqual({
      x: 250,
      y: 200,
    })
    const src = readFileSync(
      resolve(__dirname, '../src/components/canvas/WorkflowCanvas.tsx'),
      'utf8',
    )
    expect(src).toMatch(
      /insertPaletteItem\(item, rf\.screenToFlowPosition\(viewportCenter\(box\)\), true\)/,
    )
    expect(src).toMatch(
      /insertPaletteItem\(item, rf\.screenToFlowPosition\(\{ x: e\.clientX, y: e\.clientY \}\), false\)/,
    )
  })
})
