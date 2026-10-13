// A trend data button inherited 16px body text above a 14px Card title.
// Exercise the actual trend with the production CSS cascade and exact totals.
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Card } from '../src/components/Card'
import { CompleteObservationTrend } from '../src/components/observability/CompleteObservationTrend'
import i18n from '../src/i18n'

const source = (file: string) => readFileSync(resolve(import.meta.dirname, '../src', file), 'utf8')
const tokens = new Map(
  Array.from(source('styles.css').matchAll(/(--font-(?:xs|sm|md|lg|xl)):\s*(\d+px)/g), (m) => [
    m[1]!,
    m[2]!,
  ]),
)
let style: HTMLStyleElement | undefined
afterEach(() => {
  cleanup()
  style?.remove()
  style = undefined
})

test('trend counts and exact Token totals use small text without inheriting the action-link body font', async () => {
  await i18n.changeLanguage('zh-CN')
  style = document.createElement('style')
  // jsdom does not resolve CSS custom properties. Resolve font roles from the
  // real foundation; retain production selectors and their relative cascade.
  const css =
    'button { font: inherit; } .btn { font-size:16px; color:blue; } .card__title { font-size:14px; }' +
    source('components/observability/ObservationTypography.css') +
    source('components/observability/ObservationAnalysis.css')
  style.textContent = css.replace(/var\((--font-[a-z]+)\)/g, (_, key: string) => tokens.get(key)!)
  document.head.appendChild(style)
  const onRange = vi.fn()
  render(
    <>
      <button className="btn">Unrelated action</button>
      <div className="observation-typography">
        <Card title="Trend">
          <CompleteObservationTrend
            onRange={onRange}
            rows={[
              {
                key: '2026-10-01',
                from: 1000,
                to: 2000,
                tasks: '100001',
                metrics: {
                  state: 'ready',
                  invocations: '10000001',
                  observedInvocations: '10000001',
                  records: '10000001',
                  tokens: {
                    input: '9007199254740993',
                    cacheRead: '0',
                    cacheWrite: '0',
                    output: '7',
                    total: '9007199254741000',
                  },
                  cost: { currency: 'CNY', state: 'complete', amount: '0.07' },
                },
              },
            ]}
          />
        </Card>
      </div>
    </>,
  )
  const column = screen.getByRole('button', { name: /100,001.*9,007,199,254,741,000/ })
  const value = column.querySelector('strong')!
  expect(getComputedStyle(column).fontSize).toBe('12px')
  expect(getComputedStyle(value).whiteSpace).toBe('nowrap')
  expect(value.textContent).toBe('9,007,199,254,741,000 Token')
  expect(getComputedStyle(column.querySelector('.observation-trend__label')!).fontSize).toBe('12px')
  expect(getComputedStyle(screen.getByRole('button', { name: 'Unrelated action' })).fontSize).toBe(
    '16px',
  )
  fireEvent.click(column)
  expect(onRange).toHaveBeenCalledWith(1000, 2000)
})

test('all observation entrances opt into the same scope without changing the global foundation', () => {
  for (const file of ['CompleteRunObservability', 'RunObservability', 'RuntimePricing']) {
    const component = source('components/observability/' + file + '.tsx')
    expect(component).toContain("import './ObservationTypography.css'")
    expect(component).toContain('observation-typography')
  }
  const css = source('components/observability/CompleteRunObservability.css')
  expect(css).toContain('grid-auto-columns: minmax(max-content, 1fr)')
})

test('observation-owned portal dialogs explicitly carry the same text scope', () => {
  const root = resolve(import.meta.dirname, '../src/components/observability')
  for (const file of readdirSync(root).filter((file) => file.endsWith('.tsx'))) {
    const component = readFileSync(resolve(root, file), 'utf8')
    const openings = [...component.matchAll(/<Dialog\s+[\s\S]*?>/g)]
    for (const opening of openings)
      expect(opening[0], file).toContain('panelClassName="observation-typography"')
  }
})
