// QuickCreateDialog — shared chrome for the workflows / workgroups list-page
// quick-create dialogs (extracted 2026-07-10, 用户拍板「这个弹窗组件应该是
// 公共弹窗组件」). Locks:
//   1. Chrome renders title / name hint / inline name error / footer submit
//      error — the pieces both pages must show identically.
//   2. The name input is required and capped at 128 (unified naming rules are
//      baked into the component, not configurable per caller).
//   3. Confirm gating: disabled while !canCreate or pending; onCreate fires
//      only via the confirm button; Cancel routes through onClose.
//   4. testidPrefix drives all four testids (same pattern as ChipsInput).

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QuickCreateDialog, type QuickCreateDialogProps } from '../src/components/QuickCreateDialog'
import '../src/i18n'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function renderDialog(over: Partial<QuickCreateDialogProps> = {}) {
  const onCreate = vi.fn()
  const onClose = vi.fn()
  render(
    <QuickCreateDialog
      open
      onClose={onClose}
      title="New thing"
      createLabel="Create thing"
      nameLabel="Name"
      nameHint="naming rules go here"
      descriptionLabel="Description"
      name=""
      onNameChange={() => {}}
      description=""
      onDescriptionChange={() => {}}
      canCreate={false}
      pending={false}
      onCreate={onCreate}
      testidPrefix="thing"
      {...over}
    />,
  )
  return { onCreate, onClose }
}

describe('QuickCreateDialog (shared quick-create chrome)', () => {
  test('renders title + hint, and the prefix drives every testid', () => {
    renderDialog()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('New thing')).toBeTruthy()
    expect(screen.getByText('naming rules go here')).toBeTruthy()
    expect(screen.getByTestId('thing-create-dialog')).toBeTruthy()
    expect(screen.getByTestId('thing-create-name')).toBeTruthy()
    expect(screen.getByTestId('thing-create-description')).toBeTruthy()
    expect(screen.getByTestId('thing-create-confirm')).toBeTruthy()
  })

  test('name input carries the unified rules: required + maxLength 128', () => {
    renderDialog()
    const name = screen.getByTestId('thing-create-name') as HTMLInputElement
    expect(name.required).toBe(true)
    expect(name.maxLength).toBe(128)
    expect(name.getAttribute('placeholder')).toBeNull()
  })

  test('confirm gating: !canCreate disables; canCreate enables and fires onCreate', () => {
    const { onCreate } = renderDialog({ canCreate: true, name: 'ok-name' })
    const confirm = screen.getByTestId('thing-create-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(false)
    expect(confirm.textContent).toBe('Create thing')
    fireEvent.click(confirm)
    expect(onCreate).toHaveBeenCalledTimes(1)
  })

  test('!canCreate keeps confirm disabled (onCreate unreachable)', () => {
    const { onCreate } = renderDialog({ canCreate: false })
    const confirm = screen.getByTestId('thing-create-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    expect(onCreate).not.toHaveBeenCalled()
  })

  test('pending disables confirm and swaps the label to common.creating', () => {
    renderDialog({
      canCreate: true,
      pending: true,
      alternativeAction: {
        label: 'Import package',
        description: 'Create from an exported package',
        testid: 'thing-create-package',
        onSelect: () => {},
      },
    })
    const confirm = screen.getByTestId('thing-create-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(confirm.textContent).toBe('Creating…')
    expect((screen.getByTestId('thing-create-package') as HTMLButtonElement).disabled).toBe(true)
  })

  test('inline name error and footer submit error both render', () => {
    renderDialog({ nameError: 'bad name here', submitError: 'server said no' })
    expect(screen.getByText('bad name here')).toBeTruthy()
    expect(screen.getByText('server said no')).toBeTruthy()
  })

  test('Cancel routes through onClose', () => {
    const { onClose } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  test('optional alternative is a unified creation method and stays absent by default', () => {
    const onSelect = vi.fn()
    const first = renderDialog()
    expect(screen.queryByTestId('thing-create-package')).toBeNull()
    cleanup()

    renderDialog({
      alternativeAction: {
        label: 'Import package',
        description: 'Create from an exported package',
        testid: 'thing-create-package',
        onSelect,
      },
    })
    const alternative = screen.getByTestId('thing-create-package')
    expect(alternative.classList.contains('resource-action-list__item')).toBe(true)
    fireEvent.click(alternative)
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(first.onClose).not.toHaveBeenCalled()
  })
})
