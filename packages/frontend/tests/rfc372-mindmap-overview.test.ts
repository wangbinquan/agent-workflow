// Daily AW: a three-level taxonomy at 40% lost alternate category labels because
// the preview collision padding was taller than the distance between ancestors.
import { expect, test, vi } from 'vitest'
import { ClarifyQuestionSchema } from '@agent-workflow/shared'
import { drawMindmap, hitMindmap } from '../src/lib/clarify/mindmap/draw'
import { layoutMindmap, indexMindmapLayout } from '../src/lib/clarify/mindmap/layout'
import { projectClarifyMindmap } from '../src/lib/clarify/mindmap/projection'

test('overview keeps each nested category readable and selectable at 40%', () => {
  const question = ClarifyQuestionSchema.parse({
    id: 'q',
    title: '查询策略',
    kind: 'single',
    options: ['副本', '主库'],
    mindmap: { categoryPath: ['性能', '数据库', '慢查询'] },
  })
  const nodes = projectClarifyMindmap([question], {}, new Set(), '设计')
  const layout = layoutMindmap(nodes, 'root')
  const fillText = vi.fn()
  const ctx = {
    clearRect() {},
    fillRect() {},
    beginPath() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    bezierCurveTo() {},
    stroke() {},
    fill() {},
    arc() {},
    roundRect() {},
    measureText: (text: string) => ({ width: [...text].length * 12 }),
    fillText,
  } as unknown as CanvasRenderingContext2D
  const result = drawMindmap({
    ctx,
    viewport: { width: 800, height: 600 },
    camera: { x: 400, y: 100, zoom: 0.4 },
    layout,
    index: indexMindmapLayout(layout),
    positions: new Map(layout.nodes.map((n) => [n.id, n])),
    nodes: new Map(nodes.map((n) => [n.id, n])),
    selectedId: null,
    highlightPending: false,
    palette: {
      background: '#fff',
      surface: '#fff',
      text: '#111',
      muted: '#555',
      border: '#ddd',
      accent: '#35c',
      status: { done: '#080', needs_detail: '#880', needs_confirmation: '#08c' },
    },
  })
  const drawn = fillText.mock.calls as [string, number, number][]
  // Every category of the chain keeps its whole name.
  expect(drawn.map((call) => call[0])).toEqual(
    expect.arrayContaining(['设计', '性能', '数据库', '慢查询']),
  )
  // RFC-490: a question's overview label leads with its number, drawn on its own; the
  // title follows on the same line in whatever room is left. This fake font charges
  // 12 px for every character, the Latin "Q1 " included, so nothing but the ellipsis of
  // 查询策略 fits: the number, not a cut-off title, is what identifies the card here.
  // (Before RFC-490 the label was the bare title, and this asserted 查询策略 in full.)
  const number = drawn.findIndex((call) => call[0] === 'Q1 ')
  expect(number).toBeGreaterThanOrEqual(0)
  const [prefix, prefixX, prefixY] = drawn[number]!
  const [title, titleX, titleY] = drawn[number + 1]!
  expect(title).toBe('…')
  expect(titleY).toBe(prefixY)
  expect(titleX).toBe(prefixX + [...prefix].length * 12)
  expect(drawn.filter((call) => call[0].startsWith('Q'))).toHaveLength(1)
  for (const node of layout.nodes) {
    expect(hitMindmap(result.hits, 400 + node.x * 0.4, 100 + node.y * 0.4)).toBe(node.id)
  }
})
