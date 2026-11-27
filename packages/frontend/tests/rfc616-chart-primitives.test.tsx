// RFC-616 §11.2 (design/RFC-616-process-metrics/design.md) — the six shared
// chart primitives: MetricTile / MetricGrid, SegmentedBar (+ legend), MeterBar,
// ColumnChart, TrendChart, HeatScale.
//
// What is locked: a number is never shown by colour alone (every mark has its
// value in text, a legend or a table twin; hover and keyboard focus show the
// same readout); "no sample" is a dash and never a zero; a share label is
// printed inside a bar part only when it fits; colours come from the chart
// tokens only; and the run observation overview uses the shared tile.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { ColumnChart } from '../src/components/ColumnChart'
import { HEAT_LEVELS, HeatScale, heatClassName } from '../src/components/HeatScale'
import { MeterBar } from '../src/components/MeterBar'
import { MetricGrid, MetricTile } from '../src/components/MetricTile'
import {
  SegmentedBar,
  SegmentedBarLegend,
  segmentLabelFits,
  segmentValueText,
  segmentedBarShares,
  type SegmentedBarPart,
} from '../src/components/SegmentedBar'
import {
  TrendChart,
  trendFrame,
  trendLabelPx,
  trendRuns,
  trendTickIndexes,
} from '../src/components/TrendChart'
import { niceAxis } from '../src/components/chartAxis'
import { useMeasuredWidth } from '../src/hooks/useMeasuredWidth'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = (relative: string) => readFileSync(path.resolve(here, relative), 'utf8')

afterEach(cleanup)

const parts: SegmentedBarPart[] = [
  { key: 'auto', label: '自动执行', amount: 280, valueText: '4 小时 40 分', fill: 'cat-1' },
  { key: 'review', label: '等待评审', amount: 410, valueText: '6 小时 50 分', fill: 'cat-2' },
  { key: 'clarify', label: '等待反问回答', amount: 230, valueText: '3 小时 50 分', fill: 'cat-3' },
  { key: 'other', label: '排队与中断', amount: 80, valueText: '1 小时 20 分', fill: 'other' },
]

describe('MetricTile', () => {
  test('shows the label, the value and every explanation line', () => {
    render(
      <MetricGrid testid="grid">
        <MetricTile
          label="每任务 Token"
          value="2.9M"
          detail={['均值；成本 ¥41.20', null, false, '', '另有一行']}
        />
      </MetricGrid>,
    )
    const grid = screen.getByTestId('grid')
    expect(grid.className).toBe('metric-grid')
    expect(within(grid).getByText('每任务 Token').className).toBe('metric-tile__label')
    expect(within(grid).getByText('2.9M').className).toBe('metric-tile__value')
    expect(
      [...grid.querySelectorAll('.metric-tile__detail')].map((line) => line.textContent),
    ).toEqual(['均值；成本 ¥41.20', '另有一行'])
    expect(grid.querySelector('.metric-tile__delta')).toBeNull()
  })

  test('a change says its direction with an arrow and its judgement in words, not only in colour', () => {
    render(
      <MetricGrid compact testid="grid">
        <MetricTile
          label="总历时"
          value="9 小时 40 分"
          delta={{ direction: 'down', tone: 'good', text: '降 14% · 较上一时段（变好）' }}
        />
        <MetricTile
          label="任务"
          value="48"
          delta={{ direction: 'up', tone: 'neutral', text: '升 9% · 较上一时段' }}
        />
      </MetricGrid>,
    )
    expect(screen.getByTestId('grid').className).toBe('metric-grid metric-grid--compact')
    const [good, neutral] = [...document.querySelectorAll('.metric-tile__delta')]
    expect(good!.className).toContain('metric-tile__delta--good')
    expect(good!.textContent).toBe('▼ 降 14% · 较上一时段（变好）')
    expect(neutral!.className).toContain('metric-tile__delta--neutral')
    expect(neutral!.textContent).toBe('▲ 升 9% · 较上一时段')
  })

  test('the run observation overview and task page use the shared tile', () => {
    for (const file of [
      '../src/components/observability/ObservationOverview.tsx',
      '../src/components/observability/ObservationTaskDetail.tsx',
    ]) {
      expect(source(file)).toContain('<MetricTile')
      expect(source(file)).not.toContain('observability__metric')
    }
  })
})

describe('SegmentedBar', () => {
  test('shares are fractions of the whole; a whole of zero has none', () => {
    expect(segmentedBarShares(parts).map((part) => [part.key, part.shareText])).toEqual([
      ['auto', '28%'],
      ['review', '41%'],
      ['clarify', '23%'],
      ['other', '8%'],
    ])
    expect(
      segmentedBarShares(parts.map((part) => ({ ...part, amount: 0 }))).map((part) => part.share),
    ).toEqual([0, 0, 0, 0])
    expect(segmentValueText(segmentedBarShares(parts)[0]!)).toBe('4 小时 40 分 · 28%')
    // A part whose value already is its share is not printed twice.
    expect(
      segmentValueText(
        segmentedBarShares([
          { ...parts[0]!, valueText: '100%' },
          { ...parts[1]!, amount: 0 },
        ])[0]!,
      ),
    ).toBe('100%')
  })

  test('a share label is printed only where it fits', () => {
    // 600px bar: a 28% part is 168px wide, an 8% part 48px, a 3% part 18px.
    expect(segmentLabelFits(0.28, 600, '28%')).toBe(true)
    expect(segmentLabelFits(0.08, 600, '8%')).toBe(true)
    expect(segmentLabelFits(0.03, 600, '3%')).toBe(false)
    // The same 8% part on a phone-width bar no longer fits.
    expect(segmentLabelFits(0.08, 300, '8%')).toBe(false)
  })

  test('every part is focusable and names its value; hover and focus show the same readout', () => {
    render(<SegmentedBar parts={parts} label="时间花在哪里" testid="bar" />)
    const group = screen.getByRole('group', { name: '时间花在哪里' })
    const buttons = within(group).getAllByRole('button')
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      '自动执行: 4 小时 40 分 · 28%',
      '等待评审: 6 小时 50 分 · 41%',
      '等待反问回答: 3 小时 50 分 · 23%',
      '排队与中断: 1 小时 20 分 · 8%',
    ])
    expect(buttons.map((button) => button.className)).toEqual([
      'segbar__seg viz-fill--cat-1',
      'segbar__seg viz-fill--cat-2',
      'segbar__seg viz-fill--cat-3',
      'segbar__seg viz-fill--other',
    ])
    const readout = screen.getByTestId('bar').querySelector('.viz-readout')!
    expect(readout.getAttribute('aria-live')).toBe('polite')
    expect(readout.textContent).toBe('')
    fireEvent.mouseEnter(buttons[1]!)
    expect(readout.textContent).toBe('等待评审: 6 小时 50 分 · 41%')
    fireEvent.mouseLeave(buttons[1]!)
    expect(readout.textContent).toBe('')
    fireEvent.focus(buttons[3]!)
    expect(readout.textContent).toBe('排队与中断: 1 小时 20 分 · 8%')
    fireEvent.blur(buttons[3]!)
    expect(readout.textContent).toBe('')
  })

  test('where layout cannot be measured only clearly wide parts are labelled', () => {
    render(<SegmentedBar parts={parts} label="时间" />)
    const buttons = screen.getAllByRole('button')
    expect(buttons.map((button) => button.textContent)).toEqual(['28%', '41%', '23%', ''])
    expect(buttons[3]!.getAttribute('data-tight')).toBe('true')
    expect(buttons[0]!.hasAttribute('data-tight')).toBe(false)
  })

  test('parts without an amount are not drawn; a bar with nothing to show is not rendered', () => {
    render(<SegmentedBar parts={[parts[0]!, { ...parts[1]!, amount: 0 }]} label="时间" />)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    cleanup()
    const { container } = render(
      <SegmentedBar parts={parts.map((part) => ({ ...part, amount: 0 }))} label="时间" />,
    )
    expect(container.firstChild).toBeNull()
  })

  test('the thin form is one image with every share in its name', () => {
    render(<SegmentedBar variant="thin" parts={parts} label="时间构成" />)
    const image = screen.getByRole('img')
    expect(image.getAttribute('aria-label')).toBe(
      '时间构成: 自动执行 28%, 等待评审 41%, 等待反问回答 23%, 排队与中断 8%',
    )
    expect(image.className).toBe('segbar segbar--thin')
    expect(screen.queryAllByRole('button')).toEqual([])
  })

  test('the legend lists every part with its value and share; the row form only names the fills', () => {
    render(<SegmentedBarLegend parts={parts} testid="stack" />)
    const stack = screen.getByTestId('stack')
    expect(stack.className).toBe('viz-legend viz-legend--stack')
    expect([...stack.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      '自动执行4 小时 40 分 · 28%',
      '等待评审6 小时 50 分 · 41%',
      '等待反问回答3 小时 50 分 · 23%',
      '排队与中断1 小时 20 分 · 8%',
    ])
    expect(stack.querySelector('.viz-legend__swatch')!.getAttribute('aria-hidden')).toBe('true')
    cleanup()
    render(<SegmentedBarLegend parts={parts} layout="row" testid="row" />)
    expect(screen.getByTestId('row').className).toBe('viz-legend')
    expect(screen.getByTestId('row').querySelector('.viz-legend__value')).toBeNull()
  })
})

describe('MeterBar', () => {
  test('the number is text and the bar is decoration', () => {
    render(<MeterBar share={0.22} testid="meter" />)
    const meter = screen.getByTestId('meter')
    expect(meter.querySelector('.meter__value')!.textContent).toBe('22%')
    expect(meter.querySelector('.meter__track')!.getAttribute('aria-hidden')).toBe('true')
    expect((meter.querySelector('.meter__bar') as HTMLElement).style.width).toBe('22%')
  })

  test('no sample is a dash, never an empty bar; out-of-range shares are clamped', () => {
    render(<MeterBar share={null} testid="none" />)
    expect(screen.getByTestId('none').textContent).toBe('—')
    expect(screen.getByTestId('none').querySelector('.meter__bar')).toBeNull()
    cleanup()
    render(<MeterBar share={1.4} valueText="14 张" testid="over" />)
    const over = screen.getByTestId('over')
    expect((over.querySelector('.meter__bar') as HTMLElement).style.width).toBe('100%')
    expect(over.querySelector('.meter__value')!.textContent).toBe('14 张')
    cleanup()
    render(<MeterBar share={0} testid="zero" />)
    // A real zero still shows its number, with a sliver so the row is not mistaken for missing.
    expect(screen.getByTestId('zero').querySelector('.meter__value')!.textContent).toBe('0%')
  })
})

describe('ColumnChart', () => {
  const items = [
    { key: '1', label: '第 1 轮', value: 6.4, valueText: '6.4 条', note: '48 轮评审' },
    { key: '2', label: '第 2 轮', value: 2.7, valueText: '2.7 条' },
    { key: '3', label: '第 3 轮', value: 0, valueText: '0 条' },
  ]

  test('every column prints its value and names it; the readout adds the note', () => {
    render(<ColumnChart items={items} label="各轮平均意见数" testid="chart" />)
    const columns = within(screen.getByRole('group', { name: '各轮平均意见数' })).getAllByRole(
      'button',
    )
    expect(columns.map((column) => column.getAttribute('aria-label'))).toEqual([
      '第 1 轮: 6.4 条 · 48 轮评审',
      '第 2 轮: 2.7 条',
      '第 3 轮: 0 条',
    ])
    expect(
      [...document.querySelectorAll('.column-chart__value')].map((value) => value.textContent),
    ).toEqual(['6.4 条', '2.7 条', '0 条'])
    const readout = screen.getByTestId('chart').querySelector('.viz-readout')!
    fireEvent.focus(columns[0]!)
    expect(readout.textContent).toBe('第 1 轮: 6.4 条 · 48 轮评审')
    fireEvent.blur(columns[0]!)
    fireEvent.mouseEnter(columns[1]!)
    expect(readout.textContent).toBe('第 2 轮: 2.7 条')
  })

  test('bars are scaled against a readable axis top, not against the largest value', () => {
    render(<ColumnChart items={items} label="意见" />)
    const ratios = [...document.querySelectorAll<HTMLElement>('.column-chart__bar')].map((bar) =>
      Number(bar.style.getPropertyValue('--ratio')),
    )
    // The axis of 6.4 ends at 8.
    expect(ratios[0]).toBeCloseTo(0.8)
    expect(ratios[1]).toBeCloseTo(2.7 / 8)
    expect(ratios[2]).toBe(0)
  })

  test('nothing to show renders nothing', () => {
    const { container } = render(<ColumnChart items={[]} label="意见" />)
    expect(container.firstChild).toBeNull()
  })
})

describe('niceAxis', () => {
  test('about four steps of 1, 2 or 5 times a power of ten, ending at or above the maximum', () => {
    expect(niceAxis(6.4)).toEqual({ top: 8, ticks: [0, 2, 4, 6, 8] })
    expect(niceAxis(12.9)).toEqual({ top: 15, ticks: [0, 5, 10, 15] })
    expect(niceAxis(100)).toEqual({ top: 100, ticks: [0, 50, 100] })
    expect(niceAxis(0.31).ticks).toEqual([0, 0.1, 0.2, 0.3, 0.4])
    expect(niceAxis(3_100_000).top).toBe(4_000_000)
  })

  test('zero, negative and non-finite maxima still give an axis', () => {
    for (const max of [0, -5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(niceAxis(max)).toEqual({ top: 1, ticks: [0, 1] })
  })
})

describe('TrendChart', () => {
  const points = [
    { key: 'w1', label: '10-05', value: 12.4, valueText: '12 小时 24 分' },
    { key: 'w2', label: '10-12', value: 11.8, valueText: '11 小时 48 分' },
    { key: 'w3', label: '10-19', value: null, valueText: '—' },
    { key: 'w4', label: '10-26', value: 9.7, valueText: '9 小时 42 分' },
  ]
  const chart = (
    <TrendChart
      points={points}
      label="总历时中位数的周趋势"
      formatTick={(value) => `${value} 小时`}
      table={{ summary: '查看数据表', period: '周（起始日）', value: '总历时中位数' }}
      testid="trend"
    />
  )

  test('a period without a sample is a gap in the line, never a zero', () => {
    expect(trendRuns([1, 2, null, 4])).toEqual([[0, 1], [3]])
    expect(trendRuns([null, null])).toEqual([])
    expect(trendRuns([null, 5, 6, 7, null])).toEqual([[1, 2, 3]])
    render(chart)
    const svg = screen.getByRole('group', { name: '总历时中位数的周趋势' })
    // One line for the first two weeks; the lone last week is a dot of its own.
    expect(svg.querySelectorAll('.trend-chart__line')).toHaveLength(1)
    expect(svg.querySelectorAll('.trend-chart__area')).toHaveLength(1)
  })

  test('every period is focusable with its value; hover and focus show the same readout and a crosshair', () => {
    render(chart)
    const hits = screen.getAllByRole('img')
    expect(hits.map((hit) => hit.getAttribute('aria-label'))).toEqual([
      '10-05: 12 小时 24 分',
      '10-12: 11 小时 48 分',
      '10-19: —',
      '10-26: 9 小时 42 分',
    ])
    expect(hits.every((hit) => hit.getAttribute('tabindex') === '0')).toBe(true)
    const block = screen.getByTestId('trend')
    const readout = block.querySelector('.viz-readout')!
    expect(block.querySelector('.trend-chart__cross')).toBeNull()
    fireEvent.focus(hits[1]!)
    expect(readout.textContent).toBe('10-12: 11 小时 48 分')
    expect(block.querySelector('.trend-chart__cross')).not.toBeNull()
    fireEvent.blur(hits[1]!)
    expect(readout.textContent).toBe('')
    fireEvent.mouseEnter(hits[3]!)
    expect(readout.textContent).toBe('10-26: 9 小时 42 分')
  })

  test('the last measured point is labelled directly and the axis starts at zero', () => {
    render(chart)
    const svg = screen.getByRole('group', { name: '总历时中位数的周趋势' })
    expect(svg.querySelector('.trend-chart__end')!.textContent).toBe('9 小时 42 分')
    const ticks = [...svg.querySelectorAll('text')].map((text) => text.textContent)
    expect(ticks).toContain('0 小时')
    expect(ticks).toContain('15 小时')
  })

  test('the label of the last point stays inside the drawing', () => {
    // Regression: "9 小时 42 分" beside the last point ran about 22 px past the right edge and
    // was cut off. A label that does not fit the margin goes above the point, right-aligned.
    render(chart)
    const long = screen
      .getByRole('group', { name: '总历时中位数的周趋势' })
      .querySelector('.trend-chart__end')!
    expect(long.getAttribute('text-anchor')).toBe('end')
    const width = Number(long.closest('svg')!.getAttribute('width'))
    expect(Number(long.getAttribute('x'))).toBeLessThanOrEqual(width)
    expect(Number(long.getAttribute('x')) - trendLabelPx('9 小时 42 分')).toBeGreaterThan(0)
    cleanup()
    // A short label fits the margin and stays beside the point.
    render(
      <TrendChart
        points={points.map((point) => ({
          ...point,
          valueText: point.value === null ? '—' : '31%',
        }))}
        label="一次通过率的周趋势"
        formatTick={(value) => `${value}%`}
        table={{ summary: '查看数据表', period: '周', value: '一次通过率' }}
      />,
    )
    const short = screen
      .getByRole('group', { name: '一次通过率的周趋势' })
      .querySelector('.trend-chart__end')!
    expect(short.getAttribute('text-anchor')).toBe('start')
    expect(Number(short.getAttribute('x')) + trendLabelPx('31%')).toBeLessThanOrEqual(
      Number(short.closest('svg')!.getAttribute('width')),
    )
    // Square glyphs count double.
    expect(trendLabelPx('小时')).toBe(24)
    expect(trendLabelPx('42')).toBeCloseTo(13.2)
  })

  test('on a phone the drawing fits its card instead of scrolling the last point out of view', () => {
    // Regression: the drawing was never narrower than 440 px. In the 332 px a card leaves on a
    // 390 px screen, the last point, its value and its period label sat outside the visible part.
    expect(trendFrame(332)).toEqual({ width: 332, right: 24 })
    expect(trendFrame(479)).toEqual({ width: 479, right: 24 })
    expect(trendFrame(480)).toEqual({ width: 480, right: 64 })
    expect(trendFrame(200)).toEqual({ width: 280, right: 24 })
    expect(trendFrame(4000)).toEqual({ width: 1100, right: 64 })
    expect(trendFrame(null)).toEqual({ width: 640, right: 64 })
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ width: 332 } as DOMRect)
    render(chart)
    const svg = screen.getByRole('group', { name: '总历时中位数的周趋势' })
    expect(svg.getAttribute('width')).toBe('332')
    // The last point sits inside the drawing, with room for half of its period label.
    const dots = [...svg.querySelectorAll('circle.trend-chart__dot')]
    const last = Number(dots[dots.length - 1]!.getAttribute('cx'))
    expect(last).toBe(332 - 24)
    expect(last + trendLabelPx('10-26') / 2).toBeLessThanOrEqual(332)
    // Its value is above it, ending at the point: all of it is inside the drawing.
    const end = svg.querySelector('.trend-chart__end')!
    expect(end.getAttribute('text-anchor')).toBe('end')
    expect(Number(end.getAttribute('x'))).toBe(last)
    expect(last - trendLabelPx('9 小时 42 分')).toBeGreaterThan(0)
    // The grid stops at the plot edge, not at the wide margin.
    expect(svg.querySelector('.trend-chart__axis')!.getAttribute('x2')).toBe(String(332 - 24))
    rect.mockRestore()
  })

  test('the last period is always named under the axis, and the tick before it gives way', () => {
    // Regression: with a label every third period, periods 21 and 22 of 23 were both labelled,
    // one on top of the other.
    expect(trendTickIndexes(23, 3)).toEqual([0, 3, 6, 9, 12, 15, 18, 22])
    expect(trendTickIndexes(22, 3)).toEqual([0, 3, 6, 9, 12, 15, 18, 21])
    expect(trendTickIndexes(4, 1)).toEqual([0, 1, 2, 3])
    expect(trendTickIndexes(1, 1)).toEqual([0])
    expect(trendTickIndexes(0, 1)).toEqual([])
    const many = Array.from({ length: 23 }, (_, index) => ({
      key: `w${index}`,
      label: `w${index}`,
      value: index + 1,
      valueText: String(index + 1),
    }))
    render(
      <TrendChart
        points={many}
        label="很多周"
        formatTick={String}
        table={{ summary: '查看数据表', period: '周', value: '值' }}
      />,
    )
    const labels = [...screen.getByRole('group', { name: '很多周' }).querySelectorAll('text')]
      .map((text) => text.textContent)
      .filter((text) => text!.startsWith('w'))
    expect(labels).toEqual(['w0', 'w3', 'w6', 'w9', 'w12', 'w15', 'w18', 'w22'])
  })

  test('the same numbers are in a data table, including the period without a sample', () => {
    render(chart)
    const table = screen.getByRole('table', { name: '总历时中位数的周趋势' })
    expect(
      within(table)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual([
      '周（起始日）总历时中位数',
      '10-0512 小时 24 分',
      '10-1211 小时 48 分',
      '10-19—',
      '10-269 小时 42 分',
    ])
    expect(screen.getByText('查看数据表').tagName).toBe('SUMMARY')
  })

  test('no measured period at all renders nothing; one period is drawn as a single point', () => {
    const { container } = render(
      <TrendChart
        points={points.map((point) => ({ ...point, value: null }))}
        label="趋势"
        formatTick={String}
        table={{ summary: '表', period: '周', value: '值' }}
      />,
    )
    expect(container.firstChild).toBeNull()
    cleanup()
    render(
      <TrendChart
        points={[points[0]!]}
        label="趋势"
        formatTick={String}
        table={{ summary: '表', period: '周', value: '值' }}
      />,
    )
    const svg = screen.getByRole('group', { name: '趋势' })
    expect(svg.querySelectorAll('.trend-chart__line')).toHaveLength(0)
    expect(svg.querySelectorAll('.trend-chart__dot').length).toBeGreaterThanOrEqual(1)
  })
})

describe('useMeasuredWidth', () => {
  test('an element that appears on a later render is still measured', () => {
    // Regression (latent): the element was looked up once, when the component mounted. A chart
    // that first rendered with nothing to draw never learned its width afterwards.
    const rect = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue({ width: 512 } as DOMRect)
    function Probe({ show }: { show: boolean }) {
      const [ref, width] = useMeasuredWidth<HTMLDivElement>()
      return show ? <div ref={ref} data-testid="probe" data-width={String(width)} /> : null
    }
    const view = render(<Probe show={false} />)
    expect(screen.queryByTestId('probe')).toBeNull()
    view.rerender(<Probe show />)
    expect(screen.getByTestId('probe').getAttribute('data-width')).toBe('512')
    rect.mockRestore()
  })
})

describe('HeatScale', () => {
  test('five steps with the lowest and highest value named in text', () => {
    render(<HeatScale lowLabel="低 3 分" highLabel="高 46 分" note="按数值分五档" testid="scale" />)
    const scale = screen.getByTestId('scale')
    expect(scale.textContent).toBe('低 3 分高 46 分按数值分五档')
    const steps = scale.querySelector('.heat-scale__steps')!
    expect(steps.getAttribute('aria-hidden')).toBe('true')
    expect([...steps.children].map((step) => step.className)).toEqual(
      HEAT_LEVELS.map((level) => `viz-heat--${level}`),
    )
  })

  test('a level outside one to five has no fill', () => {
    expect(HEAT_LEVELS.map(heatClassName)).toEqual([
      'viz-heat--1',
      'viz-heat--2',
      'viz-heat--3',
      'viz-heat--4',
      'viz-heat--5',
    ])
    for (const level of [0, 6, null, undefined, 2.5]) expect(heatClassName(level)).toBe('')
  })
})

describe('chart styles', () => {
  const css = source('../src/styles.css').replace(/\/\*[\s\S]*?\*\//g, '')
  const section = css.slice(css.indexOf('.viz-fill--cat-1 {'))

  test('chart tokens exist for the light theme, the dark theme and the system-dark fallback', () => {
    const tokens = [
      ...[1, 2, 3, 4, 5].flatMap((step) => [`--viz-cat-${step}`, `--viz-cat-${step}-ink`]),
      '--viz-other',
      '--viz-other-ink',
      ...[1, 2, 3].flatMap((step) => [`--viz-ord-${step}`, `--viz-ord-${step}-ink`]),
      ...[1, 2, 3, 4, 5].flatMap((step) => [`--viz-heat-${step}`, `--viz-heat-${step}-ink`]),
      '--viz-grid',
      '--viz-axis',
    ]
    for (const token of tokens) {
      const declarations = css.match(new RegExp(`${token}:\\s*#[0-9a-f]{6};`, 'g')) ?? []
      expect([token, declarations.length]).toEqual([token, 3])
    }
  })

  test('every fill is paired with an ink that reads on it at 4.5:1, in all three themes', () => {
    // Regression: the share printed inside a blue, orange or green part of a bar was white on
    // the fill — 2.5:1 to 4.1:1 — and the dark-theme heat ramp kept its ink right only by luck.
    const channel = (value: number) =>
      value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    const luminance = (hex: string) => {
      const [red, green, blue] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16) / 255)
      return 0.2126 * channel(red!) + 0.7152 * channel(green!) + 0.0722 * channel(blue!)
    }
    const contrast = (a: string, b: string) => {
      const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return (high! + 0.05) / (low! + 0.05)
    }
    const declared = (token: string) =>
      [...css.matchAll(new RegExp(`${token}:\\s*(#[0-9a-f]{6});`, 'g'))].map((match) => match[1]!)
    const fills = [
      ...[1, 2, 3, 4, 5].map((step) => `--viz-cat-${step}`),
      '--viz-other',
      ...[1, 2, 3].map((step) => `--viz-ord-${step}`),
      ...[1, 2, 3, 4, 5].map((step) => `--viz-heat-${step}`),
    ]
    const failing: string[] = []
    for (const fill of fills) {
      const colours = declared(fill)
      const inks = declared(`${fill}-ink`)
      expect([fill, colours.length, inks.length]).toEqual([fill, 3, 3])
      colours.forEach((colour, theme) => {
        const ratio = contrast(colour, inks[theme]!)
        if (ratio < 4.5)
          failing.push(`${fill} #${theme}: ${colour} / ${inks[theme]} = ${ratio.toFixed(2)}`)
      })
    }
    expect(failing).toEqual([])
  })

  test('the chart primitives carry no colour literal of their own', () => {
    const end = section.indexOf('.process-metrics__row')
    expect(end).toBeGreaterThan(0)
    const chartRules = section.slice(0, end)
    expect(chartRules.length).toBeGreaterThan(2_000)
    expect(chartRules.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) ?? []).toEqual([])
    for (const component of [
      'MetricTile',
      'SegmentedBar',
      'MeterBar',
      'ColumnChart',
      'TrendChart',
      'HeatScale',
    ]) {
      const text = source(`../src/components/${component}.tsx`)
      expect([component, /#[0-9a-fA-F]{6}\b|rgba?\(/.test(text)]).toEqual([component, false])
    }
  })
})
