// RFC-194 — AgentPortCard summary, contextual action names, and two-click delete.

import { createRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { AgentPortCard } from '../src/components/agent-ports/AgentPortCard'

describe('AgentPortCard', () => {
  test('input summary renders kind, description, required and repair chips', () => {
    const onEdit = vi.fn()
    const onDelete = vi.fn()
    const editButtonRef = createRef<HTMLButtonElement>()
    const { container } = render(
      <AgentPortCard
        direction="input"
        index={1}
        name="source"
        kind="list<path<md>>"
        description="Repository source"
        required
        legacy
        duplicate
        editButtonRef={editButtonRef}
        onEdit={onEdit}
        onDelete={onDelete}
      />,
    )

    expect(container.querySelector('.card.agent-port-card')).toBeTruthy()
    expect(container.querySelector('.agent-port-card__kind-code')?.textContent).toBe(
      'list<path<md>>',
    )
    expect(screen.getByText('file path')).toBeTruthy()
    expect(screen.getByText('Repository source')).toBeTruthy()
    expect(screen.getByText(/required/i)).toBeTruthy()
    expect(screen.getByText(/legacy name/i)).toBeTruthy()
    expect(screen.getByText(/duplicate name/i)).toBeTruthy()

    const edit = screen.getByRole('button', {
      name: /^Edit input port source.*2/,
    })
    const remove = screen.getByRole('button', {
      name: /^Delete input port source.*2/,
    })
    expect(editButtonRef.current).toBe(edit)
    expect(edit.textContent).toBe('Edit')
    expect(remove.textContent).toBe('Delete')
    fireEvent.click(edit)
    expect(onEdit).toHaveBeenCalledTimes(1)

    fireEvent.click(remove)
    const confirm = screen.getByRole('button', {
      name: /^Confirm delet.*input port source.*2/,
    })
    expect(confirm.textContent).toBe('Confirm delete')
    expect(onDelete).not.toHaveBeenCalled()
    fireEvent.click(confirm)
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  test('aggregator output summary renders wrapper rename; default stays same-name', () => {
    const { rerender } = render(
      <AgentPortCard
        direction="output"
        index={0}
        name="result"
        kind="markdown"
        aggregator
        wrapperPortName="merged_result"
        wrapperDuplicate
        onEdit={() => undefined}
        onDelete={() => undefined}
      />,
    )

    const mapping = screen.getByText(
      (_, element) => element?.classList.contains('agent-port-card__wrapper-map') ?? false,
    )
    expect(mapping.textContent).toContain('result')
    expect(mapping.textContent).toContain('merged_result')
    expect(screen.getByText(/duplicate promoted name/i)).toBeTruthy()

    rerender(
      <AgentPortCard
        direction="output"
        index={0}
        name="result"
        kind="markdown"
        aggregator
        onEdit={() => undefined}
        onDelete={() => undefined}
      />,
    )
    expect(screen.getByText(/same name.*result/i)).toBeTruthy()
  })

  test('normal output explains the runtime contract and exposes an inactive retained mapping', () => {
    const { rerender } = render(
      <AgentPortCard
        direction="output"
        index={0}
        name="result"
        kind="markdown"
        onEdit={() => undefined}
        onDelete={() => undefined}
      />,
    )

    expect(screen.getByText(/runtime envelope must emit this exact name/i)).toBeTruthy()
    expect(screen.queryByText(/promoted with the same name/i)).toBeNull()

    rerender(
      <AgentPortCard
        direction="output"
        index={0}
        name="result"
        kind="markdown"
        wrapperPortName="legacy_result"
        onEdit={() => undefined}
        onDelete={() => undefined}
      />,
    )
    expect(screen.getByText(/reserved promotion result.*legacy_result.*inactive/i)).toBeTruthy()
  })

  test('kind code normalizes the legacy markdown_file alias', () => {
    const { container } = render(
      <AgentPortCard
        direction="output"
        index={0}
        name="report"
        kind="markdown_file"
        onEdit={() => undefined}
        onDelete={() => undefined}
      />,
    )

    expect(container.querySelector('.agent-port-card__kind-code')?.textContent).toBe('path<md>')
    expect(screen.getByText('file path')).toBeTruthy()
  })

  test('contextual action names remain unique for duplicate names', () => {
    render(
      <>
        <AgentPortCard
          direction="output"
          index={0}
          name="result"
          kind="string"
          duplicate
          onEdit={() => undefined}
          onDelete={() => undefined}
        />
        <AgentPortCard
          direction="output"
          index={1}
          name="result"
          kind="string"
          duplicate
          onEdit={() => undefined}
          onDelete={() => undefined}
        />
      </>,
    )

    expect(screen.getByRole('button', { name: /^Edit output port result.*1/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Edit output port result.*2/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Delete output port result.*1/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Delete output port result.*2/ })).toBeTruthy()
  })

  test('an armed delete cannot carry across a refetched legacy duplicate identity', () => {
    const onDelete = vi.fn()
    const { rerender } = render(
      <AgentPortCard
        direction="input"
        index={0}
        name="duplicate_port"
        kind="string"
        description="first declaration"
        onEdit={() => undefined}
        onDelete={onDelete}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Delete input port duplicate_port/i }))
    rerender(
      <AgentPortCard
        direction="input"
        index={0}
        name="duplicate_port"
        kind="markdown"
        description="second declaration"
        required
        onEdit={() => undefined}
        onDelete={onDelete}
      />,
    )

    const freshDelete = screen.getByRole('button', { name: /Delete input port duplicate_port/i })
    expect(freshDelete.textContent).toBe('Delete')
    fireEvent.click(freshDelete)
    expect(onDelete).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole('button', { name: /Confirm deletion of input port duplicate_port/i }),
    )
    expect(onDelete).toHaveBeenCalledTimes(1)
  })
})
