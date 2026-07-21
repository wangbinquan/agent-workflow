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
import { PALETTE_MIME, deserialize } from '../src/components/canvas/nodePalette'

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
  test('canvas history shortcuts work while native text-field undo remains untouched', () => {
    const onUndo = vi.fn()
    const onRedo = vi.fn()
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <WorkflowCanvas
          surface="editor"
          definition={EMPTY_DEFINITION}
          canUndo
          canRedo
          onUndo={onUndo}
          onRedo={onRedo}
        />
      </I18nextProvider>,
    )
    const canvas = container.querySelector<HTMLElement>('.workflow-canvas')!
    const textInput = document.createElement('input')
    canvas.append(textInput)

    fireEvent.keyDown(textInput, { key: 'z', ctrlKey: true })
    expect(onUndo).not.toHaveBeenCalled()
    expect(onRedo).not.toHaveBeenCalled()

    fireEvent.keyDown(canvas, { key: 'z', ctrlKey: true })
    expect(onUndo).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(canvas, { key: 'z', metaKey: true, shiftKey: true })
    expect(onRedo).toHaveBeenCalledTimes(1)
    fireEvent.keyDown(canvas, { key: 'y', ctrlKey: true })
    expect(onRedo).toHaveBeenCalledTimes(2)
  })

  test('the row is the primary click target and a separate desktop grip preserves HTML5 drag', () => {
    const onAdd = vi.fn()
    const { container } = render(
      <I18nextProvider i18n={i18n}>
        <EditorSidebar agents={[]} onAdd={onAdd} />
      </I18nextProvider>,
    )
    const item = container.querySelector<HTMLButtonElement>('.editor-sidebar__item')
    const grip = item?.querySelector<HTMLElement>('.workflow-node-picker__drag-grip') ?? null
    expect(item).not.toBeNull()
    expect(item?.tagName).toBe('BUTTON')
    expect(item?.getAttribute('draggable')).toBeNull()
    expect(grip?.getAttribute('draggable')).toBe('true')

    const setData = vi.fn()
    const setEffectAllowed = vi.fn()
    const dataTransfer = {
      setData,
      get effectAllowed() {
        return 'none'
      },
      set effectAllowed(value: string) {
        setEffectAllowed(value)
      },
    }
    const dragStart = new DragEvent('dragstart', { bubbles: true, cancelable: true })
    Object.defineProperty(dragStart, 'dataTransfer', { value: dataTransfer })
    fireEvent(grip!, dragStart)
    expect(setData).toHaveBeenCalledTimes(2)
    const calls = setData.mock.calls as Array<[string, string]>
    expect(calls.map(([mime]) => mime)).toEqual([PALETTE_MIME, 'text/plain'])
    expect(deserialize(calls[0]![1])).toEqual(deserialize(calls[1]![1]))
    expect(setEffectAllowed).toHaveBeenCalledWith('copy')
    expect(onAdd).not.toHaveBeenCalled()

    fireEvent.click(item!)
    expect(onAdd).toHaveBeenCalledTimes(1)
  })

  test('sidebar delegates search, row activation, and keyboard navigation to the shared picker', () => {
    const sidebar = readFileSync(
      resolve(__dirname, '../src/components/canvas/EditorSidebar.tsx'),
      'utf8',
    )
    const picker = readFileSync(
      resolve(__dirname, '../src/components/workflow-editor/WorkflowNodePicker.tsx'),
      'utf8',
    )
    expect(sidebar).toContain('<WorkflowNodePickerCatalog')
    expect(sidebar).toContain('showDragGrip')
    expect(sidebar).not.toContain('<input')
    expect(picker).toContain('<TextInput')
    expect(picker).toContain('type="search"')
    expect(picker).toContain("event.key === 'ArrowDown'")
    expect(picker).toContain("event.key === 'Enter' || event.key === ' '")
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
            surface="editor"
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
    // 2026-07-21 落点修复：插入点是"锚点"（视口中心 / 拖放光标），节点必须
    // 以它为中心（centerAnchoredTopLeft），不是把整个矩形挂在锚点右下方。
    expect(src).toMatch(
      /centerAnchoredTopLeft\(\s*rf\.screenToFlowPosition\(viewportCenter\(box\)\),\s*DEFAULT_NODE_SIZE_BY_KIND\[item\.kind\],\s*\)/,
    )
    expect(src).toMatch(
      /centerAnchoredTopLeft\(\s*rf\.screenToFlowPosition\(\{ x: e\.clientX, y: e\.clientY \}\),\s*DEFAULT_NODE_SIZE_BY_KIND\[item\.kind\],\s*\)/,
    )
  })
})
