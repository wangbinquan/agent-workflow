// RFC-490 (design §5.3, §5.4): what the canvas paints. A question card is 236 × 136:
// "Qn · status" with the decision's maturity right-aligned on the same row, two lines
// of title, two lines of answer, and the pending follow-ups on the bottom line. A
// skipped question reads "Not applicable" / "Decide later" where its answer would be,
// a configured category nobody asked about is a dashed slot saying so, the overview
// leads every question label with its number, and a parent whose children wrapped is
// joined to them by one rail with a bus per row instead of one curve per child.
// The drawing goes to a recording stand-in for the 2D context.
import { describe, expect, test } from 'vitest'
import {
  ClarifyQuestionSchema,
  clarifyAnswerBasis,
  type ClarifyAnswer,
  type ClarifyQuestion,
} from '@agent-workflow/shared'
import { drawMindmap, hitMindmap, type MindmapPalette } from '../src/lib/clarify/mindmap/draw'
import { worldToScreen, type MindmapCamera } from '../src/lib/clarify/mindmap/geometry'
import {
  MINDMAP_CARD_WIDTH,
  MINDMAP_GROUP_HEIGHT,
  MINDMAP_QUESTION_HEIGHT,
  indexMindmapLayout,
  layoutMindmap,
} from '../src/lib/clarify/mindmap/layout'
import {
  projectClarifyMindmap,
  type MindmapNodeSummary,
} from '../src/lib/clarify/mindmap/projection'

/** Every character is 6 px wide whatever the font, so widths can be read off a string. */
const CHAR = 6
const palette: MindmapPalette = {
  background: '#fff',
  surface: '#fefefe',
  text: '#111',
  muted: '#555',
  border: '#ddd',
  accent: '#35c',
  status: { done: '#080', needs_detail: '#880', needs_confirmation: '#08c' },
}
/** The labels the canvas passes (MindmapCanvas), in English. */
const labels = {
  status: {
    done: 'Confirmed',
    needs_detail: 'Unanswered',
    needs_confirmation: 'Needs confirmation',
  },
  pending: (count: number) => `${count} child questions pending`,
  confirmed: 'Confirmed',
  decision: {
    decided: 'Decided',
    provisional: 'Provisional',
    deferred: 'Decide later',
    'not-applicable': 'Not applicable',
    unmarked: 'Unmarked',
  },
  empty: 'No questions yet',
}
const viewport = { width: 1200, height: 900 }

interface Call {
  name: string
  args: unknown[]
  fill: string
  stroke: string
  dash: number[]
}
function recordingContext() {
  const calls: Call[] = []
  let dash: number[] = []
  const ctx: Record<string, unknown> = {
    fillStyle: '',
    strokeStyle: '',
    font: '',
    lineWidth: 1,
    globalAlpha: 1,
    textBaseline: '',
    setLineDash: (segments: number[]) => {
      dash = [...segments]
    },
    measureText: (text: string) => ({ width: text.length * CHAR }),
  }
  for (const name of [
    'clearRect',
    'fillRect',
    'beginPath',
    'moveTo',
    'lineTo',
    'closePath',
    'bezierCurveTo',
    'stroke',
    'fill',
    'arc',
    'rect',
    'roundRect',
    'fillText',
  ])
    ctx[name] = (...args: unknown[]) => {
      calls.push({
        name,
        args,
        fill: ctx.fillStyle as string,
        stroke: ctx.strokeStyle as string,
        dash,
      })
    }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

function paint(
  nodes: readonly MindmapNodeSummary[],
  camera: MindmapCamera,
  options: { columns?: number; labels?: typeof labels | null } = {},
) {
  const layout = layoutMindmap(nodes, 'root', options.columns ?? 3)
  const positions = new Map(layout.nodes.map((node) => [node.id, node]))
  const { ctx, calls } = recordingContext()
  const drawing = drawMindmap({
    ctx,
    viewport,
    camera,
    layout,
    index: indexMindmapLayout(layout),
    positions,
    nodes: new Map(nodes.map((node) => [node.id, node])),
    selectedId: null,
    highlightPending: false,
    palette,
    ...(options.labels === null ? {} : { labels: options.labels ?? labels }),
  })
  /** The card's screen box, computed the way the drawing computes it. */
  const box = (id: string) => {
    const item = positions.get(id)!
    const { x, y } = worldToScreen(item, camera)
    const width = item.width * camera.zoom
    const height = item.height * camera.zoom
    return { left: x - width / 2, top: y - height / 2, width, height, x, y }
  }
  const texts = calls
    .filter((call) => call.name === 'fillText')
    .map((call) => ({
      text: call.args[0] as string,
      x: call.args[1] as number,
      y: call.args[2] as number,
      fill: call.fill,
    }))
  /** What is written inside a card on the line `offset` px below its top edge. */
  const line = (id: string, offset: number) => {
    const card = box(id)
    return texts.filter(
      (item) =>
        item.y === card.top + offset && item.x >= card.left && item.x <= card.left + card.width,
    )
  }
  return { layout, positions, calls, drawing, box, texts, line }
}

const option = (label: string) => ({ label, description: '' })
const ask = (
  id: string,
  title: string,
  mindmap: { categoryPath: string[]; parentQuestionId?: string },
): ClarifyQuestion =>
  ClarifyQuestionSchema.parse({
    id,
    title,
    kind: 'single',
    options: [option('Streaming replica'), option('Nightly backup')],
    mindmap,
  })
const confirmed = (question: ClarifyQuestion, value: Omit<ClarifyAnswer, 'questionId'>) => {
  const answer = { questionId: question.id, ...value }
  return { ...answer, confirmedBasis: clarifyAnswerBasis(question, answer) }
}
const none = { selectedOptionIndices: [], selectedOptionLabels: [], customText: '' }

// Performance holds four states of a question; Reliability is configured and empty.
const recovery = ask('recovery', 'Recovery target', { categoryPath: ['Performance'] })
const lag = ask('lag', 'Replica lag', { categoryPath: ['Performance'] })
const backups = ask('backups', 'Backups', { categoryPath: ['Performance'] })
const drill = ask('drill', 'Failover drill', {
  categoryPath: ['Performance'],
  parentQuestionId: 'recovery',
})
const round = projectClarifyMindmap(
  [recovery, lag, backups, drill],
  {
    // Answered, provisional, confirmed; its follow-up below is still open.
    recovery: confirmed(recovery, {
      ...none,
      selectedOptionIndices: [0],
      decision: { status: 'provisional' },
    }),
    // Skipped: nothing chosen, deliberately.
    lag: confirmed(lag, { ...none, decision: { status: 'not-applicable' } }),
    // Answered without a maturity mark, not confirmed yet.
    backups: { questionId: 'backups', ...none, selectedOptionIndices: [1] },
    // `drill` has no answer at all.
  },
  new Set(),
  'Reports',
  [['Performance'], ['Reliability']],
)
const PERFORMANCE = 'g:["Performance"]'
const RELIABILITY = 'g:["Reliability"]'
const READING: MindmapCamera = { x: 600, y: 80, zoom: 1 }
const INSET = 16

describe('RFC-490 question card (design §5.4)', () => {
  test('the fixture is what the cases below assume', () => {
    const byId = new Map(round.map((node) => [node.id, node]))
    expect(byId.get('q:recovery')).toMatchObject({
      ownStatus: 'done',
      decisionStatus: 'provisional',
    })
    expect(byId.get('q:lag')).toMatchObject({ ownStatus: 'done', decisionStatus: 'not-applicable' })
    expect(byId.get('q:backups')).toMatchObject({ ownStatus: 'needs_confirmation' })
    expect(byId.get('q:drill')).toMatchObject({ ownStatus: 'needs_detail', parentId: 'q:recovery' })
    expect(byId.get(RELIABILITY)?.empty).toBe(true)
    expect(byId.get(PERFORMANCE)?.empty).toBeUndefined()
  })

  test('the card is 236 × 136 and reads number · status, title, answer, pending follow-ups', () => {
    const { box, line, drawing } = paint(round, READING)
    const card = box('q:recovery')
    expect([card.width, card.height]).toEqual([MINDMAP_CARD_WIDTH, MINDMAP_QUESTION_HEIGHT])
    expect([card.width, card.height]).toEqual([236, 136])
    expect(line('q:recovery', 19)[0]).toMatchObject({ text: 'Q1 · Confirmed', x: card.left + 26 })
    expect(line('q:recovery', 44)).toEqual([
      expect.objectContaining({
        text: 'Recovery target',
        x: card.left + INSET,
        fill: palette.text,
      }),
    ])
    expect(line('q:recovery', 90)).toEqual([
      expect.objectContaining({ text: 'Streaming replica', x: card.left + INSET }),
    ])
    // Its one open follow-up is counted on the bottom line.
    expect(line('q:recovery', MINDMAP_QUESTION_HEIGHT - 12)).toEqual([
      expect.objectContaining({ text: '1 child questions pending', x: card.left + INSET }),
    ])
    // The hit area is the card.
    expect(drawing.hits).toContainEqual({
      id: 'q:recovery',
      left: card.left,
      top: card.top,
      right: card.left + 236,
      bottom: card.top + 136,
    })
  })

  test('the maturity shares the heading row, right-aligned to the card', () => {
    const { box, line } = paint(round, READING)
    for (const [id, heading, maturity] of [
      ['q:recovery', 'Q1 · Confirmed', 'Provisional'],
      // Answered and not marked: says so, rather than staying silent.
      ['q:backups', 'Q3 · Needs confirmation', 'Unmarked'],
    ] as const) {
      const card = box(id)
      const row = line(id, 19)
      expect(row.map((item) => item.text)).toEqual([heading, maturity])
      // Its last character ends at the card's inner right edge.
      expect(row[1]!.x + maturity.length * CHAR).toBe(card.left + card.width - INSET)
      expect(row[1]!.x).toBeGreaterThan(row[0]!.x + heading.length * CHAR)
      expect(row[1]!.fill).toBe(palette.muted)
    }
  })

  test('an unanswered card shows no maturity, and a long heading takes the row for itself', () => {
    const { line } = paint(round, READING)
    expect(line('q:drill', 19).map((item) => item.text)).toEqual(['Q4 · Unanswered'])
    expect(line('q:drill', 90)).toEqual([])
    // A status wording that needs the whole row leaves no room for the maturity.
    const wordy = {
      ...labels,
      status: { ...labels.status, needs_confirmation: 'Waiting for someone to confirm it' },
    }
    const crowded = paint(round, READING, { labels: wordy })
    expect(crowded.line('q:backups', 19).map((item) => item.text)).toEqual([
      'Q3 · Waiting for someone to confirm it',
    ])
    // The answer itself is still there.
    expect(crowded.line('q:backups', 90).map((item) => item.text)).toEqual(['Nightly backup'])
  })

  test('a skipped question says so where its answer would be, and carries no maturity', () => {
    const { line, texts } = paint(round, READING)
    expect(line('q:lag', 19).map((item) => item.text)).toEqual(['Q2 · Confirmed'])
    expect(line('q:lag', 90).map((item) => item.text)).toEqual(['Not applicable'])
    expect(texts.filter((item) => item.text === 'Not applicable')).toHaveLength(1)
    // The other skip reads the same way.
    const later = round.map((node) =>
      node.id === 'q:lag' ? { ...node, decisionStatus: 'deferred' as const } : node,
    )
    const deferred = paint(later, READING)
    expect(deferred.line('q:lag', 90).map((item) => item.text)).toEqual(['Decide later'])
    expect(deferred.line('q:lag', 19).map((item) => item.text)).toEqual(['Q2 · Confirmed'])
  })

  test('title and answer take two lines each, the second one abbreviated', () => {
    const title =
      'How long may the reporting service be unavailable before the monthly close is at risk?'
    const answer =
      'Fifteen minutes at most, measured from the first failed health check, because the close cannot wait'
    const long = round.map((node) =>
      node.id === 'q:backups' ? { ...node, title, answerSummary: answer } : node,
    )
    const { line, box } = paint(long, READING)
    const room = Math.floor((box('q:backups').width - 2 * INSET) / CHAR)
    const first = line('q:backups', 44)
    const second = line('q:backups', 44 + 21)
    expect(first.map((item) => item.text)).toEqual([title.slice(0, room)])
    expect(second).toHaveLength(1)
    expect(second[0]!.text.endsWith('…')).toBe(true)
    expect(title.startsWith(first[0]!.text + second[0]!.text.slice(0, -1))).toBe(true)
    expect(second[0]!.text.length).toBeLessThanOrEqual(room)
    // No third title line: the answer starts right below.
    expect(line('q:backups', 44 + 42)).toEqual([])
    const summary = [line('q:backups', 90), line('q:backups', 90 + 17)]
    expect(summary[0]!.map((item) => item.text)).toEqual([answer.slice(0, room)])
    expect(summary[1]).toHaveLength(1)
    expect(summary[1]![0]!.text.endsWith('…')).toBe(true)
    expect(line('q:backups', 90 + 34)).toEqual([])
  })
})

describe('RFC-490 categories on the canvas (design §5.4, §6.4)', () => {
  const frame = (calls: readonly Call[], card: { left: number; top: number }) => {
    const at = calls.findIndex(
      (call) =>
        call.name === 'roundRect' && call.args[0] === card.left && call.args[1] === card.top,
    )
    return { at, rect: calls[at]!, stroke: calls.slice(at).find((call) => call.name === 'stroke')! }
  }

  test('a configured category without questions is a dashed slot that says "No questions yet"', () => {
    const { box, line, calls } = paint(round, READING)
    const empty = box(RELIABILITY)
    expect([empty.width, empty.height]).toEqual([MINDMAP_CARD_WIDTH, MINDMAP_GROUP_HEIGHT])
    const slot = frame(calls, empty)
    expect(slot.at).toBeGreaterThanOrEqual(0)
    expect(slot.rect.dash).toEqual([5, 4])
    expect(slot.stroke.dash).toEqual([5, 4])
    expect(line(RELIABILITY, 19).map((item) => item.text)).toEqual(['Reliability'])
    expect(line(RELIABILITY, MINDMAP_GROUP_HEIGHT - 16).map((item) => item.text)).toEqual([
      'No questions yet',
    ])
    // It has no status of its own: no mark where a category's status mark goes.
    const marked = (card: { left: number; top: number }) =>
      calls.some(
        (call) =>
          (call.name === 'arc' &&
            call.args[0] === card.left + INSET &&
            call.args[1] === card.top + 19) ||
          (call.name === 'moveTo' &&
            call.args[0] === card.left + INSET &&
            call.args[1] === card.top + 19 - 3.5),
      )
    expect(marked(empty)).toBe(false)
    expect(marked(box(PERFORMANCE))).toBe(true)
  })

  test('the dash belongs to that slot only; a category with questions keeps its count', () => {
    const { box, line, calls } = paint(round, READING)
    for (const id of ['root', PERFORMANCE, 'q:recovery', 'q:lag', 'q:backups', 'q:drill']) {
      const card = frame(calls, box(id))
      expect(card.at, id).toBeGreaterThanOrEqual(0)
      expect(card.rect.dash, id).toEqual([])
      expect(card.stroke.dash, id).toEqual([])
    }
    expect(line(PERFORMANCE, MINDMAP_GROUP_HEIGHT - 16).map((item) => item.text)).toEqual([
      '2 / 4 Confirmed',
    ])
    // The empty category is not counted anywhere above it.
    expect(line('root', MINDMAP_GROUP_HEIGHT - 16).map((item) => item.text)).toEqual([
      '2 / 4 Confirmed',
    ])
  })

  test('without a label for it an empty category shows no made-up count', () => {
    const { line } = paint(round, READING, { labels: null })
    expect(line(RELIABILITY, MINDMAP_GROUP_HEIGHT - 16)).toEqual([])
    expect(line(PERFORMANCE, MINDMAP_GROUP_HEIGHT - 16).map((item) => item.text)).toEqual([
      '2 / 4 confirmed',
    ])
  })
})

describe('RFC-490 overview labels (design §5.4)', () => {
  const OVERVIEW: MindmapCamera = { x: 600, y: 80, zoom: 0.5 }

  test('a question label leads with its number, drawn on its own in the muted colour', () => {
    const { texts } = paint(round, OVERVIEW)
    const numbers = texts.filter((item) => /^Q\d+ $/.test(item.text))
    expect(numbers.map((item) => item.text).sort()).toEqual(['Q1 ', 'Q2 ', 'Q3 ', 'Q4 '])
    for (const number of numbers) expect(number.fill).toBe(palette.muted)
    const after = (prefix: string) => {
      const at = texts.findIndex((item) => item.text === prefix)
      return { number: texts[at]!, title: texts[at + 1]! }
    }
    // A title that fits is written whole, right after its number on the same line.
    const short = after('Q3 ')
    expect(short.title).toMatchObject({
      text: 'Backups',
      y: short.number.y,
      x: short.number.x + 'Q3 '.length * CHAR,
      fill: palette.text,
    })
    // A longer one gives up its tail, never the number.
    const cut = after('Q1 ')
    expect(cut.title.y).toBe(cut.number.y)
    expect(cut.title.text.endsWith('…')).toBe(true)
    expect('Recovery target'.startsWith(cut.title.text.slice(0, -1))).toBe(true)
    expect(cut.title.text.length).toBeGreaterThan(1)
  })

  test('categories keep their bare names, and every node is still hit at its centre', () => {
    const { texts, drawing, layout } = paint(round, OVERVIEW)
    const names = texts.map((item) => item.text)
    for (const name of ['Reports', 'Performance', 'Reliability']) {
      expect(names).toContain(name)
      const at = names.indexOf(name)
      expect(/^Q\d+ $/.test(names[at - 1] ?? '')).toBe(false)
    }
    for (const node of layout.nodes) {
      const { x, y } = worldToScreen(node, OVERVIEW)
      expect(hitMindmap(drawing.hits, x, y), node.id).toBe(node.id)
    }
  })

  test('the label is as wide as number and title together need, within the card’s slot', () => {
    const { drawing } = paint(round, OVERVIEW)
    const width = (id: string) =>
      Math.max(...drawing.hits.filter((hit) => hit.id === id).map((hit) => hit.right - hit.left))
    // 7 characters of title + 3 of number + the label's 28 px of chrome.
    expect(width('q:backups')).toBe(('Backups'.length + 'Q3 '.length) * CHAR + 28)
    // Capped by the card width at this scale, less the 8 px between neighbours.
    expect(width('q:recovery')).toBe(MINDMAP_CARD_WIDTH * OVERVIEW.zoom - 8)
  })
})

describe('RFC-490 connectors of a wrapped block (design §5.3)', () => {
  const settled = (
    id: string,
    parentId: string | null,
    order: number,
    kind: 'group' | 'question' = 'question',
  ): MindmapNodeSummary => ({
    id,
    parentId,
    order,
    kind,
    title: id,
    // Confirmed marks are circles, so every straight segment below is a connector.
    status: 'done',
    ...(kind === 'question' ? { ownStatus: 'done' as const } : {}),
    counts: { done: 1, needs_detail: 0, needs_confirmation: 0 },
  })
  const CAMERA: MindmapCamera = { x: 500, y: 60, zoom: 1 }
  /** Straight segments and curves, rebuilt from the path calls. */
  function strokes(calls: readonly Call[]) {
    const segments: { from: [number, number]; to: [number, number]; stroke: string }[] = []
    const curves: { from: [number, number]; to: [number, number] }[] = []
    let pen: [number, number] = [0, 0]
    for (const call of calls) {
      const [a, b] = call.args as number[]
      if (call.name === 'moveTo') pen = [a!, b!]
      else if (call.name === 'lineTo') {
        segments.push({ from: pen, to: [a!, b!], stroke: call.stroke })
        pen = [a!, b!]
      } else if (call.name === 'bezierCurveTo') {
        const args = call.args as number[]
        curves.push({ from: pen, to: [args[4]!, args[5]!] })
      }
    }
    return { segments, curves }
  }

  test('one rail, one bus per row, a tap per card, and no curve to any wrapped child', () => {
    // Five children do not fit three columns: rows of three and two. The last one
    // has a child of its own, which is not wrapped.
    const nodes = [
      settled('root', null, 0, 'group'),
      ...[0, 1, 2, 3, 4].map((index) => settled(`q${index}`, 'root', index + 1)),
      settled('deep', 'q4', 6),
    ]
    const { layout, calls, positions, drawing } = paint(nodes, CAMERA)
    expect(layout.blocks).toHaveLength(1)
    const [block] = layout.blocks
    expect(block!.rows.map((row) => row.childIds)).toEqual([
      ['q0', 'q1', 'q2'],
      ['q3', 'q4'],
    ])
    const { segments, curves } = strokes(calls)
    const point = (x: number, y: number): [number, number] => {
      const at = worldToScreen({ x, y }, CAMERA)
      return [at.x, at.y]
    }
    const top = (id: string) => {
      const node = positions.get(id)!
      return point(node.x, node.y - node.height / 2)
    }
    const parent = positions.get('root')!
    const trunk = point(parent.x, parent.y + parent.height / 2)
    const railTop = point(block!.railX, block!.rows[0]!.busY)
    const railFoot = point(block!.railX, block!.rows[1]!.busY)
    // The only curve left is the ordinary one to the unwrapped grandchild.
    const q4 = positions.get('q4')!
    expect(curves).toEqual([{ from: point(q4.x, q4.y + q4.height / 2), to: top('deep') }])
    // Rail, trunk and buses are neutral …
    const neutral = segments.filter((segment) => segment.stroke === palette.muted)
    expect(neutral).toHaveLength(4)
    expect(neutral).toEqual(
      expect.arrayContaining([
        // … the parent drops onto the first bus,
        { from: trunk, to: [trunk[0], railTop[1]], stroke: palette.muted },
        // the rail joins the first bus to the last,
        { from: railTop, to: railFoot, stroke: palette.muted },
        // and each row's bus runs from the rail to its last card.
        { from: railTop, to: [top('q2')[0], railTop[1]], stroke: palette.muted },
        { from: railFoot, to: [top('q4')[0], railFoot[1]], stroke: palette.muted },
      ]),
    )
    // The first bus reaches under the parent, so the trunk always lands on it.
    expect(top('q2')[0]).toBeGreaterThanOrEqual(trunk[0])
    // Each card hangs from its row's bus by a short tap in its own status colour.
    const taps = segments.filter((segment) => segment.stroke === palette.status.done)
    expect(taps).toHaveLength(5)
    for (const [rowIndex, row] of block!.rows.entries()) {
      const busY = point(block!.railX, row.busY)[1]
      for (const id of row.childIds)
        expect(taps, `${id} in row ${rowIndex}`).toContainEqual({
          from: [top(id)[0], busY],
          to: top(id),
          stroke: palette.status.done,
        })
    }
    expect(segments).toHaveLength(9)
    // Hit testing is unchanged: every card answers at its centre.
    for (const node of layout.nodes) {
      const at = worldToScreen(node, CAMERA)
      expect(hitMindmap(drawing.hits, at.x, at.y), node.id).toBe(node.id)
    }
  })

  test('siblings that fit one row keep their curves and get no rail', () => {
    const nodes = [
      settled('root', null, 0, 'group'),
      ...[0, 1, 2].map((index) => settled(`q${index}`, 'root', index + 1)),
    ]
    const { layout, calls, positions } = paint(nodes, CAMERA)
    expect(layout.blocks).toEqual([])
    const { segments, curves } = strokes(calls)
    expect(segments).toEqual([])
    expect(curves).toHaveLength(3)
    const parent = positions.get('root')!
    const from = worldToScreen({ x: parent.x, y: parent.y + parent.height / 2 }, CAMERA)
    for (const curve of curves) expect(curve.from).toEqual([from.x, from.y])
  })
})

describe('RFC-490 "highlight pending" and gaps (design §5.4)', () => {
  test('a category without questions is never faded as if it were finished', () => {
    const done = ClarifyQuestionSchema.parse({
      id: 'q',
      title: 'Recovery target',
      kind: 'single',
      options: ['Seconds', 'Minutes'],
      mindmap: { categoryPath: ['Performance'] },
    })
    const answer: ClarifyAnswer = {
      questionId: 'q',
      selectedOptionIndices: [0],
      selectedOptionLabels: [],
      customText: '',
    }
    const nodes = projectClarifyMindmap(
      [done],
      { q: { ...answer, confirmedBasis: clarifyAnswerBasis(done, answer) } },
      new Set(),
      'Design',
      [['Performance'], ['Reliability']],
    )
    const layout = layoutMindmap(
      nodes.map(({ id, parentId, order, kind }) => ({ id, parentId, order, kind })),
      'root',
      3,
    )
    // The opacity each card's outline was drawn with, keyed by its top-left corner.
    const alphas = new Map<string, number>()
    const state: Record<string, unknown> = {
      globalAlpha: 1,
      measureText: (text: string) => ({ width: text.length * CHAR }),
      setLineDash: () => {},
      roundRect: (left: number, top: number) =>
        alphas.set(`${Math.round(left)},${Math.round(top)}`, state.globalAlpha as number),
    }
    const ctx = new Proxy(state, {
      get: (target, key: string) => (key in target ? target[key] : () => {}),
      set: (target, key: string, value) => {
        target[key] = value
        return true
      },
    }) as unknown as CanvasRenderingContext2D
    const camera: MindmapCamera = { x: 600, y: 80, zoom: 1 }
    drawMindmap({
      ctx,
      viewport,
      camera,
      layout,
      index: indexMindmapLayout(layout),
      positions: new Map(layout.nodes.map((node) => [node.id, node])),
      nodes: new Map(nodes.map((node) => [node.id, node])),
      selectedId: null,
      highlightPending: true,
      palette,
      labels,
    })
    const alphaOf = (id: string) => {
      const point = layout.nodes.find((node) => node.id === id)!
      const screen = worldToScreen(point, camera)
      return alphas.get(
        `${Math.round(screen.x - point.width / 2)},${Math.round(screen.y - point.height / 2)}`,
      )
    }
    // The confirmed question and its finished category step back; the gap does not.
    expect(alphaOf('q:q')).toBe(0.38)
    expect(alphaOf('g:["Performance"]')).toBe(0.38)
    expect(alphaOf('g:["Reliability"]')).toBe(1)
  })
})
