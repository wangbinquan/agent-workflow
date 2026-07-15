// RFC-198 — shared PageHeader semantic/slot contract.

import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'vitest'
import { PageHeader } from '../src/components/PageHeader'

describe('<PageHeader />', () => {
  test('renders the standard DOM shape and defaults to one h1', () => {
    const { container } = render(
      <PageHeader
        title={
          <>
            Agent <code>writer</code>
          </>
        }
        back={<a href="/agents">Back to agents</a>}
        meta={<span>v3</span>}
        actions={<button type="button">Save</button>}
        className="agent-detail__header"
        data-testid="agent-header"
      >
        <span data-testid="save-state">Unsaved</span>
      </PageHeader>,
    )

    const header = screen.getByTestId('agent-header')
    expect(header.tagName).toBe('HEADER')
    expect(header.className).toBe('page__header page__header--row agent-detail__header')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Agent writer')
    expect(container.querySelectorAll('h1')).toHaveLength(1)
    expect(container.querySelector('h2')).toBeNull()
    expect(container.querySelector('.page__heading')).not.toBeNull()
    expect(container.querySelector('.page__meta')?.textContent).toBe('v3')
    expect(screen.getByTestId('save-state').parentElement).toBe(
      container.querySelector('.page__heading'),
    )
    expect(screen.getByRole('button', { name: 'Save' }).parentElement?.className).toBe(
      'page__actions',
    )

    const back = screen.getByRole('link', { name: 'Back to agents' })
    const heading = screen.getByRole('heading', { level: 1 })
    expect(back.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  test('headingLevel=2 preserves the surrounding page h1 outline', () => {
    render(
      <main>
        <h1>Agents</h1>
        <PageHeader headingLevel={2} title="Writer details" />
      </main>,
    )

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Agents')
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1)
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Writer details')
  })

  test('does not render empty optional wrappers', () => {
    const { container } = render(
      <PageHeader title="Tasks" meta={null} back={false} actions={false}>
        {null}
      </PageHeader>,
    )

    expect(container.querySelector('.page__heading')).not.toBeNull()
    expect(container.querySelector('.page__meta')).toBeNull()
    expect(container.querySelector('.page__actions')).toBeNull()
    expect(container.querySelector('.page__heading')?.children).toHaveLength(1)
  })
})
