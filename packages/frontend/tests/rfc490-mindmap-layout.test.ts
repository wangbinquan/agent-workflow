// RFC-490 (design §4.2, §5): siblings wrap instead of running off the canvas. A row
// holds as many subtrees as fit the width handed down to it; one row keeps the centred
// fan of RFC-372, several rows share a left rail. The width a level may use shrinks by
// one rail per wrapping ancestor, so nested wrapping cannot outgrow the stage. Card
// sizes are constants, so answering never re-lays out (RFC-372 L14). The last block
// covers the camera rule for the question panel that opens beside the canvas.
import { describe, expect, test } from 'vitest'
import {
  MINDMAP_CARD_WIDTH,
  MINDMAP_COLUMN_GAP,
  MINDMAP_LEVEL_GAP,
  MINDMAP_QUESTION_HEIGHT,
  MINDMAP_RAIL_INSET,
  layoutMindmap,
  mindmapColumns,
  mindmapRootWidth,
  type MindmapTopologyNode,
} from '../src/lib/clarify/mindmap/layout'
import {
  MINDMAP_PANEL_MARGIN,
  panelResizeCamera,
  type MindmapCamera,
} from '../src/lib/clarify/mindmap/geometry'

const root: MindmapTopologyNode = { id: 'root', parentId: null, order: 0, kind: 'group' }
const leaves = (count: number, parentId = 'root', prefix = 'q'): MindmapTopologyNode[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i}`,
    parentId,
    order: i + 1,
    kind: 'question' as const,
  }))
const at = (layout: ReturnType<typeof layoutMindmap>, id: string) =>
  layout.nodes.find((node) => node.id === id)!
function overlapping(layout: ReturnType<typeof layoutMindmap>): string[] {
  const hits: string[] = []
  for (const a of layout.nodes)
    for (const b of layout.nodes) {
      if (a.id >= b.id) continue
      if (
        Math.abs(a.x - b.x) < (a.width + b.width) / 2 &&
        Math.abs(a.y - b.y) < (a.height + b.height) / 2
      )
        hits.push(`${a.id}/${b.id}`)
    }
  return hits
}

describe('RFC-490 column budget', () => {
  test('follows the stage width at the readable scale and stays within 1..5', () => {
    expect([358, 458, 830, 1150, 1336, 4000].map(mindmapColumns)).toEqual([1, 1, 3, 4, 5, 5])
    // Nothing measurable: the desktop default.
    expect([0, Number.NaN, -1].map(mindmapColumns)).toEqual([3, 3, 3])
  })

  test('a column is only promised once two rails fit beside the full row', () => {
    // The thresholds sit exactly where the row, the margins and two rails fit at 0.85.
    expect([503, 504].map(mindmapColumns)).toEqual([1, 2])
    expect([1186, 1187].map(mindmapColumns)).toEqual([4, 5])
    for (const width of [504, 732, 960, 1187]) {
      const columns = mindmapColumns(width)
      expect(mindmapRootWidth(columns)).toBeLessThanOrEqual(width / 0.85 - 48)
    }
    expect(mindmapRootWidth(3)).toBe(
      3 * MINDMAP_CARD_WIDTH + 2 * MINDMAP_COLUMN_GAP + 2 * MINDMAP_RAIL_INSET,
    )
  })
})

describe('RFC-490 wrapped layout', () => {
  test('siblings that fit stay in one centred row with no rail (RFC-372 look)', () => {
    const layout = layoutMindmap([root, ...leaves(3)], 'root', 3)
    expect(layout.blocks).toEqual([])
    const step = MINDMAP_CARD_WIDTH + MINDMAP_COLUMN_GAP
    expect(['q0', 'q1', 'q2'].map((id) => at(layout, id).x)).toEqual([-step, 0, step])
    expect(new Set(['q0', 'q1', 'q2'].map((id) => at(layout, id).y)).size).toBe(1)
  })

  test('more siblings than columns wrap into left-aligned rows hanging from one rail', () => {
    const layout = layoutMindmap([root, ...leaves(5)], 'root', 3)
    expect(layout.blocks).toHaveLength(1)
    const [block] = layout.blocks
    expect(block!.parentId).toBe('root')
    expect(block!.rows.map((row) => row.childIds)).toEqual([
      ['q0', 'q1', 'q2'],
      ['q3', 'q4'],
    ])
    // Rows share their left edge; the second row starts under the first.
    expect(at(layout, 'q3').x).toBe(at(layout, 'q0').x)
    expect(at(layout, 'q4').x).toBe(at(layout, 'q1').x)
    expect(at(layout, 'q3').y - at(layout, 'q0').y).toBe(
      MINDMAP_QUESTION_HEIGHT + MINDMAP_LEVEL_GAP,
    )
    // The rail sits left of every card, the buses above their rows.
    const left = at(layout, 'q0').x - MINDMAP_CARD_WIDTH / 2
    expect(block!.railX).toBeLessThan(left)
    expect(left - block!.railX).toBeLessThanOrEqual(MINDMAP_RAIL_INSET)
    for (const row of block!.rows) {
      const top = at(layout, row.childIds[0]!).y - MINDMAP_QUESTION_HEIGHT / 2
      expect(row.busY).toBeLessThan(top)
      expect(row.busY).toBeGreaterThan(top - MINDMAP_LEVEL_GAP)
    }
    expect(layout.bounds.left).toBeLessThanOrEqual(block!.railX)
    expect(overlapping(layout)).toEqual([])
  })

  test('the reading width is bounded by the columns however many siblings there are', () => {
    for (const columns of [1, 3, 5]) {
      const layout = layoutMindmap([root, ...leaves(40)], 'root', columns)
      expect(layout.bounds.right - layout.bounds.left).toBeLessThanOrEqual(
        mindmapRootWidth(columns),
      )
      const rows = layout.blocks[0]!.rows
      expect(rows.every((row) => row.childIds.length <= columns)).toBe(true)
      // A full row really holds that many cards: the rail does not cost a column.
      expect(rows[0]!.childIds).toHaveLength(columns)
      expect(overlapping(layout)).toEqual([])
    }
  })

  test('the parent sits centred over its wrapped block', () => {
    const layout = layoutMindmap([root, ...leaves(5)], 'root', 3)
    const cards = layout.nodes.filter((node) => node.parentId === 'root')
    const left = Math.min(...cards.map((node) => node.x - node.width / 2)) - MINDMAP_RAIL_INSET
    const right = Math.max(...cards.map((node) => node.x + node.width / 2))
    expect((left + right) / 2).toBe(at(layout, 'root').x)
    // Symmetric around the root, which the readable camera centres.
    expect(layout.bounds.right).toBe(-left)
  })

  test('every level wrapping at once still fits the width promised for the stage', () => {
    // Categories, their questions and their follow-ups all have more children than fit.
    const nodes: MindmapTopologyNode[] = [root]
    for (let c = 0; c < 4; c++) {
      nodes.push({ id: `c${c}`, parentId: 'root', order: c, kind: 'group' })
      for (let q = 0; q < 7; q++) {
        nodes.push({ id: `c${c}q${q}`, parentId: `c${c}`, order: q, kind: 'question' })
        nodes.push(...leaves(4, `c${c}q${q}`, `c${c}q${q}f`))
      }
    }
    for (const columns of [2, 3, 4, 5]) {
      const layout = layoutMindmap(nodes, 'root', columns)
      expect(layout.blocks.length).toBeGreaterThan(4)
      expect(layout.bounds.right - layout.bounds.left).toBeLessThanOrEqual(
        mindmapRootWidth(columns),
      )
      expect(overlapping(layout)).toEqual([])
    }
  })

  test('a single child inherits the whole width; only a branching parent keeps a rail', () => {
    // root -> one category -> five questions: the category may use the full root width.
    const layout = layoutMindmap(
      [root, { id: 'only', parentId: 'root', order: 0, kind: 'group' }, ...leaves(5, 'only')],
      'root',
      3,
    )
    expect(layout.blocks.map((block) => block.parentId)).toEqual(['only'])
    expect(layout.blocks[0]!.rows.map((row) => row.childIds.length)).toEqual([3, 2])
    expect(layout.bounds.right - layout.bounds.left).toBeLessThanOrEqual(mindmapRootWidth(3))
  })

  test('a subtree wider than the budget takes a row of its own and keeps its children under it', () => {
    const layout = layoutMindmap(
      [
        root,
        { id: 'a', parentId: 'root', order: 1, kind: 'group' },
        { id: 'b', parentId: 'root', order: 2, kind: 'group' },
        ...leaves(5, 'a', 'a'),
        ...leaves(1, 'b', 'b'),
      ],
      'root',
      3,
    )
    const rootBlock = layout.blocks.find((block) => block.parentId === 'root')!
    expect(rootBlock.rows.map((row) => row.childIds)).toEqual([['a'], ['b']])
    // "b" starts below everything that hangs under "a".
    const lowestOfA = Math.max(
      ...layout.nodes
        .filter((node) => node.parentId === 'a')
        .map((node) => node.y + node.height / 2),
    )
    expect(at(layout, 'b').y - at(layout, 'b').height / 2).toBeGreaterThanOrEqual(
      lowestOfA + MINDMAP_LEVEL_GAP,
    )
    expect(overlapping(layout)).toEqual([])
  })

  test('300 siblings with a 100-deep chain stay separate at every column count', () => {
    const nodes: MindmapTopologyNode[] = [root]
    for (let i = 0; i < 300; i++)
      nodes.push({
        id: `q${String(i).padStart(3, '0')}`,
        parentId: i > 10 && i < 110 ? `q${String(i - 1).padStart(3, '0')}` : 'root',
        order: i,
        kind: 'question',
      })
    for (const columns of [1, 3, 5]) {
      const layout = layoutMindmap(nodes, 'root', columns)
      expect(layout.nodes).toHaveLength(301)
      expect(overlapping(layout)).toEqual([])
      const byId = new Map(layout.nodes.map((node) => [node.id, node]))
      for (const node of layout.nodes) {
        if (!node.parentId) continue
        const parent = byId.get(node.parentId)!
        expect(node.y - node.height / 2 - (parent.y + parent.height / 2)).toBeGreaterThanOrEqual(
          MINDMAP_LEVEL_GAP,
        )
      }
    }
  })

  test('5000 nodes lay out without recursion, and the column count defaults to three', () => {
    const nodes: MindmapTopologyNode[] = [root, ...leaves(4999)]
    const layout = layoutMindmap(nodes, 'root')
    expect(layout.nodes).toHaveLength(5000)
    expect(layout.blocks[0]!.rows).toHaveLength(Math.ceil(4999 / 3))
    expect(layout.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(
      true,
    )
  })
})

describe('RFC-490 panel camera (design §4.2)', () => {
  const camera: MindmapCamera = { x: 400, y: 60, zoom: 0.85 }
  const wide = { width: 830, height: 600 }
  const narrow = { width: 410, height: 600 }
  // World centre and size of a card; its screen box is x * 0.85 + 400 +- 100.
  const card = (x: number) => ({ x, y: 200, width: MINDMAP_CARD_WIDTH, height: 136 })
  const open = (x: number | undefined, from = camera) =>
    panelResizeCamera({
      camera: from,
      previous: wide,
      next: narrow,
      opening: true,
      node: x === undefined ? undefined : card(x),
      session: null,
    })
  const close = (
    current: MindmapCamera,
    session: ReturnType<typeof open>['session'],
    x: number | undefined = 100,
  ) =>
    panelResizeCamera({
      camera: current,
      previous: narrow,
      next: wide,
      opening: false,
      node: x === undefined ? undefined : card(x),
      session,
    })

  test('opening leaves the camera alone while the picked card still fits', () => {
    // Screen box 129.7..330.3: inside the 410 wide canvas with its margin.
    const result = open(-200)
    expect(result.camera).toBe(camera)
    // What closing will need: where the map was, and that nobody has moved it yet.
    expect(result.session).toEqual({ before: camera, manual: false, located: false })
    // No selected card, nothing to keep in view.
    expect(open(undefined).camera).toBe(camera)
  })

  test('opening pans just far enough when the panel would push the picked card out', () => {
    // Screen box 384.7..585.3 in the wide canvas: the narrow one ends at 410.
    const result = open(100)
    const right = (100 + MINDMAP_CARD_WIDTH / 2) * 0.85 + result.camera.x
    expect(right).toBeCloseTo(narrow.width - MINDMAP_PANEL_MARGIN, 6)
    expect(result.camera.zoom).toBe(camera.zoom)
    expect(result.camera.y).toBe(camera.y)
    // The place to return to is the one before the pan.
    expect(result.session?.before).toBe(camera)
  })

  test('a card wider than the room keeps its left edge instead of trading it away', () => {
    const zoomed: MindmapCamera = { x: 40, y: 0, zoom: 2.5 }
    // 590 px wide on screen, left edge at 45: only the 29 px to the margin can be given.
    const result = open(120, zoomed)
    const left = (120 - MINDMAP_CARD_WIDTH / 2) * 2.5 + result.camera.x
    expect(left).toBeCloseTo(MINDMAP_PANEL_MARGIN, 6)
  })

  test('a card that was out of view before is not chased', () => {
    // Entirely right of the wide canvas: selecting it never panned, and still does not.
    expect(open(700).camera).toBe(camera)
    expect(open(-900).camera).toBe(camera)
  })

  test('closing puts the map back exactly where it was when the panel opened', () => {
    const opened = open(100)
    expect(opened.camera).not.toBe(camera)
    // The earlier camera itself, not a recomputed one.
    const restored = close(opened.camera, opened.session)
    expect(restored.camera).toBe(camera)
    expect(restored.session).toBeNull()
    // Nothing was moved on opening: closing changes nothing either.
    const still = open(-200)
    expect(close(still.camera, still.session, -200).camera).toBe(camera)
    // No panel had been opened at this size (a hidden canvas reports nothing).
    expect(close(camera, null)).toEqual({ camera, session: null })
  })

  test('a position the reader chose while the panel was open is kept', () => {
    const opened = open(100)
    const moved = { ...opened.camera, y: opened.camera.y + 30 }
    expect(close(moved, { ...opened.session!, manual: true })).toEqual({
      camera: moved,
      session: null,
    })
  })

  test('nodes located meanwhile do not leave the map off to one side', () => {
    const opened = open(-200)
    // "Confirm and next" centred another card in the narrow canvas: the camera moved,
    // but not by the reader's hand.
    const centred: MindmapCamera = { ...camera, x: narrow.width / 2 - 100 * 0.85 }
    const located = { ...opened.session!, located: true }
    // That card is in view at full width from where the map was: back to exactly there.
    expect(close(centred, located, 100).camera).toBe(camera)
    // A card that is out of view from there is located again, at full width.
    const far = close(centred, located, 1400).camera
    expect(far.x).toBeCloseTo(wide.width / 2 - 1400 * 0.85, 6)
    expect(far.zoom).toBe(camera.zoom)
    // Without a locate nothing is revealed on close: selecting never pans.
    expect(close(centred, opened.session, 1400).camera).toBe(camera)
  })
})
