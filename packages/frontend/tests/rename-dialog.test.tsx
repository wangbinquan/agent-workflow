// RenameDialog — shared rename chrome for the workflow editor + workgroup
// detail page (用户 2026-07-13「把名称和描述修改收到重命名按钮内」). Locks:
//   1. Renders title + the shared name/description pair; prefix drives every
//      testid (`${prefix}-rename-{dialog,name,description,confirm}`).
//   2. Save gating: disabled while !canSave or pending; onSave fires only via
//      the confirm button; Cancel routes through onClose.
//   3. pending swaps the label to common.saving; submitError renders; hint /
//      inline name error / pattern all wire through to the shared fields.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RenameDialog, type RenameDialogProps } from '../src/components/RenameDialog'
import '../src/i18n'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function renderDialog(over: Partial<RenameDialogProps> = {}) {
  const onSave = vi.fn()
  const onClose = vi.fn()
  render(
    <RenameDialog
      open
      onClose={onClose}
      title="Rename thing"
      testidPrefix="thing"
      nameLabel="Name"
      name="old"
      onNameChange={() => {}}
      descriptionLabel="Description"
      description="blurb"
      onDescriptionChange={() => {}}
      canSave
      pending={false}
      onSave={onSave}
      {...over}
    />,
  )
  return { onSave, onClose }
}

describe('RenameDialog (shared rename chrome)', () => {
  test('renders title + seeded name/description; prefix drives every testid', () => {
    renderDialog()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Rename thing')).toBeTruthy()
    expect(screen.getByTestId('thing-rename-dialog')).toBeTruthy()
    expect((screen.getByTestId('thing-rename-name') as HTMLInputElement).value).toBe('old')
    expect((screen.getByTestId('thing-rename-description') as HTMLInputElement).value).toBe('blurb')
    expect(screen.getByTestId('thing-rename-confirm')).toBeTruthy()
  })

  test('canSave enables + fires onSave via the confirm button', () => {
    const { onSave } = renderDialog({ canSave: true })
    const confirm = screen.getByTestId('thing-rename-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(false)
    expect(confirm.textContent).toBe('Save')
    fireEvent.click(confirm)
    expect(onSave).toHaveBeenCalledTimes(1)
  })

  test('!canSave keeps Save disabled (onSave unreachable)', () => {
    const { onSave } = renderDialog({ canSave: false })
    const confirm = screen.getByTestId('thing-rename-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.click(confirm)
    expect(onSave).not.toHaveBeenCalled()
  })

  test('pending disables Save + swaps to common.saving; submitError renders', () => {
    renderDialog({ pending: true, submitError: 'server said no' })
    const confirm = screen.getByTestId('thing-rename-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    expect(confirm.textContent).toBe('Saving…')
    expect(screen.getByText('server said no')).toBeTruthy()
  })

  test('hint + pattern wire through; an inline name error supersedes the hint', () => {
    // Field renders error XOR hint (error wins), so exercise the two states
    // separately rather than asserting both at once.
    renderDialog({ nameHint: 'slug rules', namePattern: '[a-z-]+' })
    expect(screen.getByText('slug rules')).toBeTruthy()
    expect(
      (screen.getByTestId('thing-rename-name') as HTMLInputElement).getAttribute('pattern'),
    ).toBe('[a-z-]+')
    cleanup()
    renderDialog({ nameHint: 'slug rules', nameError: 'bad name' })
    expect(screen.getByText('bad name')).toBeTruthy()
    expect(screen.queryByText('slug rules')).toBeNull()
  })

  test('Cancel routes through onClose', () => {
    const { onClose } = renderDialog()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
