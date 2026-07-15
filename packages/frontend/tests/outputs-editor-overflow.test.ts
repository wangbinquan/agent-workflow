// RFC-194 overflow regression: JSDOM cannot calculate geometry, so bind the
// responsive CSS contract to classes that are proven to exist on the rendered
// card DOM. This replaces the old test of dead `.outputs-editor__*` selectors.

import { createElement } from 'react'
import { render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { OutputsEditor } from '../src/components/OutputsEditor'

const STYLES = readFileSync(join(__dirname, '..', 'src', 'styles.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
)

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = STYLES.match(new RegExp(`${escaped}[^{}]*\\{([^}]*)\\}`))
  if (match === null) throw new Error(`rule ${selector} not found in styles.css`)
  return match[1] ?? ''
}

describe('OutputsEditor card overflow contract', () => {
  test('long path/list output renders through the constrained live card classes', () => {
    const longName = `artifact_${'very_long_segment_'.repeat(12)}result`
    render(
      createElement(OutputsEditor, {
        outputs: [longName],
        outputKinds: { [longName]: 'list<path<md>>' },
        onChange: () => undefined,
      }),
    )

    const list = screen.getByTestId('agent-output-port-list')
    const card = screen.getByTestId('agent-port-card-output-0')
    const name = card.querySelector('.agent-port-card__name')
    const kind = card.querySelector('.agent-port-card__kind-code')
    const summary = card.querySelector('.agent-port-card__output-summary')

    expect(list.classList.contains('agent-port-list')).toBe(true)
    expect(card.classList.contains('agent-port-card')).toBe(true)
    expect(name?.textContent).toBe(longName)
    expect(kind?.textContent).toBe('list<path<md>>')
    expect(summary).toBeTruthy()
  })

  test('the rendered list/card/name/kind classes all carry a shrink or wrap boundary', () => {
    const list = ruleBody('.agent-port-list')
    expect(list).toMatch(/grid-template-columns:\s*repeat\(auto-fit,/)
    expect(list).toMatch(/min-width:\s*0/)

    const card = ruleBody('.agent-port-card')
    expect(card).toMatch(/min-width:\s*0/)
    expect(card).toMatch(/overflow:\s*hidden/)

    for (const selector of ['.agent-port-card__name', '.agent-port-card__kind-code']) {
      const body = ruleBody(selector)
      expect(body).toMatch(/min-width:\s*0/)
      expect(body).toMatch(/overflow:\s*hidden/)
      expect(body).toMatch(/text-overflow:\s*ellipsis/)
    }

    expect(ruleBody('.agent-port-card__wrapper-default')).toMatch(/overflow-wrap:\s*anywhere/)
  })

  test('the narrow breakpoint makes the live card list a single shrinkable column', () => {
    expect(STYLES).toMatch(
      /@media\s*\(max-width:\s*720px\)[\s\S]*?\.agent-port-list\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    )
  })

  test('warning containers use the repository warning tokens', () => {
    const validation = ruleBody('.agent-port-validation')
    expect(validation).toMatch(/border:\s*1px\s+solid\s+var\(--warn\)/)
    expect(validation).toMatch(/background:\s*var\(--warn-bg\)/)
    expect(validation).not.toContain('var(--warning)')
  })
})
