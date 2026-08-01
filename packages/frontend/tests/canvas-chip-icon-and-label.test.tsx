// Regression test for canvas node identity: every card-shaped renderer keeps
// its icon in the shared tile and its kind label localized beside it.
//
// Earlier renderers mixed glyphs into the label text and some human-category
// labels were hardcoded in English. This file pins:
//   - AgentNode keeps the ⚙ glyph in the shared icon slot
//   - Human-category labels resolve through t()
//   - Source files no longer carry the old English literals

import { afterEach, describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ReactFlowProvider } from '@xyflow/react'
import { AgentNode } from '../src/components/canvas/nodes/AgentNode'
import { ReviewNode } from '../src/components/canvas/nodes/ReviewNode'
import { ClarifyNode } from '../src/components/canvas/nodes/ClarifyNode'
import { CrossClarifyNode } from '../src/components/canvas/nodes/CrossClarifyNode'
import type { CanvasNodeData } from '../src/components/canvas/nodes/types'
import { setLanguage } from '../src/i18n'
import '../src/i18n'

afterEach(() => {
  document.body.innerHTML = ''
})

function mountAgent(data: CanvasNodeData) {
  return render(
    <ReactFlowProvider>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <AgentNode {...({ data, selected: false, id: data.nodeId, type: data.kind } as any)} />
    </ReactFlowProvider>,
  )
}
function mountReview(data: CanvasNodeData) {
  return render(
    <ReactFlowProvider>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <ReviewNode {...({ data, selected: false, id: data.nodeId, type: data.kind } as any)} />
    </ReactFlowProvider>,
  )
}
function mountClarify(data: CanvasNodeData) {
  return render(
    <ReactFlowProvider>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <ClarifyNode {...({ data, selected: false, id: data.nodeId, type: data.kind } as any)} />
    </ReactFlowProvider>,
  )
}
function mountCrossClarify(data: CanvasNodeData) {
  return render(
    <ReactFlowProvider>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <CrossClarifyNode {...({ data, selected: false, id: data.nodeId, type: data.kind } as any)} />
    </ReactFlowProvider>,
  )
}

function agentData(): CanvasNodeData {
  return {
    surface: 'task',
    nodeId: 'a1',
    kind: 'agent-single',
    title: 'coder',
    inputPorts: ['req'],
    outputPorts: ['code'],
  }
}
function reviewData(): CanvasNodeData {
  return {
    surface: 'task',
    nodeId: 'r1',
    kind: 'review',
    title: 'human-gate',
    inputPorts: [],
    outputPorts: ['approved_doc', 'approval_meta'],
  }
}
function clarifyData(): CanvasNodeData {
  return {
    surface: 'task',
    nodeId: 'c1',
    kind: 'clarify',
    title: 'ask-back',
    inputPorts: ['questions'],
    outputPorts: ['answers'],
  }
}
function crossClarifyData(): CanvasNodeData {
  return {
    surface: 'task',
    nodeId: 'cc1',
    kind: 'clarify-cross-agent',
    title: 'cross-ask',
    inputPorts: ['questions'],
    outputPorts: ['to_questioner', 'to_designer'],
  }
}

describe('AgentNode card separates its icon tile from the localized kind label', () => {
  test('en-US: icon shows ⚙ and kind shows "agent"', () => {
    setLanguage('en-US')
    const { container } = mountAgent(agentData())
    const icon = container.querySelector('.canvas-node__icon')
    const chip = container.querySelector('.canvas-node__kind')
    expect(icon?.textContent).toContain('⚙')
    expect(chip?.textContent).toContain('agent')
  })
  test('zh-CN: icon shows ⚙ and kind shows 代理', () => {
    setLanguage('zh-CN')
    try {
      const { container } = mountAgent(agentData())
      const icon = container.querySelector('.canvas-node__icon')
      const chip = container.querySelector('.canvas-node__kind')
      expect(icon?.textContent).toContain('⚙')
      expect(chip?.textContent).toContain('代理')
    } finally {
      setLanguage('en-US')
    }
  })
})

describe('Human-category chips resolve through i18n', () => {
  test('ReviewNode chip: ⚖ + localized label', () => {
    setLanguage('en-US')
    const { container } = mountReview(reviewData())
    const icon = container.querySelector('.canvas-node__icon')
    const chip = container.querySelector('.canvas-node__kind')
    expect(icon?.textContent).toContain('⚖')
    expect(chip?.textContent).toContain('review')

    setLanguage('zh-CN')
    try {
      const { container: zhContainer } = mountReview(reviewData())
      const zhIcon = zhContainer.querySelector('.canvas-node__icon')
      const zhChip = zhContainer.querySelector('.canvas-node__kind')
      expect(zhIcon?.textContent).toContain('⚖')
      expect(zhChip?.textContent).toContain('评审')
    } finally {
      setLanguage('en-US')
    }
  })

  test('ClarifyNode chip falls back to "⚡ {t(clarifyNode.label)}" — Chinese under zh-CN', () => {
    setLanguage('zh-CN')
    try {
      const { container } = mountClarify(clarifyData())
      const icon = container.querySelector('.canvas-node__icon')
      const chip = container.querySelector('.canvas-node__kind')
      expect(icon?.textContent).toContain('⚡')
      expect(chip?.textContent).toContain('反问')
      // Must NOT collapse back to the English fallback literal.
      expect(chip?.textContent ?? '').not.toContain('clarify')
    } finally {
      setLanguage('en-US')
    }
  })

  test('ClarifyNode chip respects an explicit kindLabel override (caller control preserved)', () => {
    setLanguage('zh-CN')
    try {
      const data = { ...clarifyData(), kindLabel: '⚡ 自定义' } as CanvasNodeData & {
        kindLabel?: string
      }
      const { container } = mountClarify(data)
      const chip = container.querySelector('.canvas-node__kind')
      expect(chip?.textContent).toContain('自定义')
      // i18n fallback should not fire when the caller passes kindLabel.
      expect(chip?.textContent ?? '').not.toContain('反问')
    } finally {
      setLanguage('en-US')
    }
  })

  test('CrossClarifyNode chip falls back to "⚡ {t(crossClarifyNode.label)}" — Chinese under zh-CN', () => {
    setLanguage('zh-CN')
    try {
      const { container } = mountCrossClarify(crossClarifyData())
      const icon = container.querySelector('.canvas-node__icon')
      const chip = container.querySelector('.canvas-node__kind')
      expect(icon?.textContent).toContain('⚡')
      expect(chip?.textContent).toContain('跨代理反问')
      expect(chip?.textContent ?? '').not.toContain('cross-clarify')
    } finally {
      setLanguage('en-US')
    }
  })
})

describe('Source files no longer carry the old hardcoded chip literals', () => {
  // Locks the i18n routing in source — without these grep guards a future
  // refactor could re-introduce a literal next to the t() call and pass the
  // runtime tests under en-US (because the fallback string happens to match).
  const FRONTEND_SRC = path.resolve(__dirname, '../src')
  function read(rel: string): string {
    return readFileSync(path.join(FRONTEND_SRC, rel), 'utf8')
  }
  test('AgentNode.tsx no longer renders the literal "agent" without t()', () => {
    const body = read('components/canvas/nodes/AgentNode.tsx')
    expect(body).not.toContain('>agent<')
  })
  test('ReviewNode.tsx no longer renders the "⚖ review" literal', () => {
    const body = read('components/canvas/nodes/ReviewNode.tsx')
    expect(body).not.toContain('⚖ review')
  })
  test('ClarifyNode.tsx no longer hardcodes "⚡ clarify" as the fallback', () => {
    const body = read('components/canvas/nodes/ClarifyNode.tsx')
    expect(body).not.toContain("?? '⚡ clarify'")
  })
  test('CrossClarifyNode.tsx no longer hardcodes "⚡ cross-clarify" as the fallback', () => {
    const body = read('components/canvas/nodes/CrossClarifyNode.tsx')
    expect(body).not.toContain("?? '⚡ cross-clarify'")
  })
})
