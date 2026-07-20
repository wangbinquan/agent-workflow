// Regression test for the 2026-05-24 i18n bug fix: InputNode + OutputNode
// chip labels used to be hardcoded English literals ('↳ input' / '⤴ output')
// so a Chinese-locale workflow editor saw English chips on IO nodes. The
// assertions below lock both the localized rendering AND the absence of the
// old literals — without the source-level grep at the bottom a future
// refactor could re-introduce the hardcoded string and pass the locale test
// only because the React test happens to render under en-US fallback.

import { afterEach, describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ReactFlowProvider } from '@xyflow/react'
import { InputNode } from '../src/components/canvas/nodes/InputNode'
import { OutputNode } from '../src/components/canvas/nodes/OutputNode'
import type { CanvasNodeData } from '../src/components/canvas/nodes/types'
import { setLanguage } from '../src/i18n'
import '../src/i18n'

afterEach(() => {
  document.body.innerHTML = ''
})

function inputData(overrides: Partial<CanvasNodeData> = {}): CanvasNodeData {
  return {
    surface: 'task',
    nodeId: 'i1',
    kind: 'input',
    title: 'requirement',
    inputPorts: [],
    outputPorts: ['requirement'],
    ...overrides,
  }
}
function outputData(overrides: Partial<CanvasNodeData> = {}): CanvasNodeData {
  return {
    surface: 'task',
    nodeId: 'o1',
    kind: 'output',
    title: 'final',
    inputPorts: ['final_doc'],
    outputPorts: [],
    ...overrides,
  }
}

function renderInput(data: CanvasNodeData) {
  return render(
    <ReactFlowProvider>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <InputNode {...({ data, selected: false, id: data.nodeId, type: data.kind } as any)} />
    </ReactFlowProvider>,
  )
}
function renderOutput(data: CanvasNodeData) {
  return render(
    <ReactFlowProvider>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <OutputNode {...({ data, selected: false, id: data.nodeId, type: data.kind } as any)} />
    </ReactFlowProvider>,
  )
}

describe('IO node chip labels are localized', () => {
  test('InputNode renders the English label under en-US', () => {
    setLanguage('en-US')
    const { container } = renderInput(inputData())
    const chip = container.querySelector('.canvas-node__kind')
    expect(chip?.textContent).toContain('Input')
    // Sanity: the icon arrow is preserved (not stripped by the t() wiring).
    expect(chip?.textContent).toContain('↳')
  })

  test('InputNode renders the Chinese label under zh-CN', () => {
    setLanguage('zh-CN')
    try {
      const { container } = renderInput(inputData())
      const chip = container.querySelector('.canvas-node__kind')
      expect(chip?.textContent).toContain('输入')
    } finally {
      setLanguage('en-US')
    }
  })

  test('OutputNode renders the English label under en-US', () => {
    setLanguage('en-US')
    const { container } = renderOutput(outputData())
    const chip = container.querySelector('.canvas-node__kind')
    expect(chip?.textContent).toContain('Output')
    expect(chip?.textContent).toContain('⤴')
  })

  test('OutputNode renders the Chinese label under zh-CN', () => {
    setLanguage('zh-CN')
    try {
      const { container } = renderOutput(outputData())
      const chip = container.querySelector('.canvas-node__kind')
      expect(chip?.textContent).toContain('输出')
    } finally {
      setLanguage('en-US')
    }
  })
})

describe('IO node TSX files no longer carry hardcoded English chip labels', () => {
  // The runtime tests above pass even if a future refactor re-introduces
  // a hardcoded English literal next to the t() call. This grep guards the
  // source so the regression cannot creep back in.
  const FRONTEND_SRC = path.resolve(__dirname, '../src')
  test('InputNode.tsx does not contain "↳ input" literal', () => {
    const body = readFileSync(
      path.join(FRONTEND_SRC, 'components/canvas/nodes/InputNode.tsx'),
      'utf8',
    )
    expect(body).not.toContain('↳ input')
  })
  test('OutputNode.tsx does not contain "⤴ output" literal', () => {
    const body = readFileSync(
      path.join(FRONTEND_SRC, 'components/canvas/nodes/OutputNode.tsx'),
      'utf8',
    )
    expect(body).not.toContain('⤴ output')
  })
})
