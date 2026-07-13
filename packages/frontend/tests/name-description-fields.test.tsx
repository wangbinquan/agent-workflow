// NameDescriptionFields — the SINGLE source of the name + description input
// pair shared by every create / rename dialog (用户 2026-07-13「让重命名和新建
// 弹窗显示元素一致」). Locks:
//   1. testidPrefix drives `${prefix}-name` / `${prefix}-description`.
//   2. The name input is required + capped at 128 by default, no placeholder
//      (unified naming rules).
//   3. Hint / inline error / optional pattern / description cap all wire
//      through, and both onChange callbacks emit the raw value.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { NameDescriptionFields } from '../src/components/NameDescriptionFields'
import '../src/i18n'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('NameDescriptionFields (shared metadata field pair)', () => {
  test('prefix drives both testids; name is required + capped at 128, no placeholder', () => {
    render(
      <NameDescriptionFields
        testidPrefix="x-create"
        nameLabel="Name"
        name=""
        onNameChange={() => {}}
        descriptionLabel="Description"
        description=""
        onDescriptionChange={() => {}}
      />,
    )
    const name = screen.getByTestId('x-create-name') as HTMLInputElement
    expect(name.required).toBe(true)
    expect(name.maxLength).toBe(128)
    expect(name.getAttribute('placeholder')).toBeNull()
    expect(screen.getByTestId('x-create-description')).toBeTruthy()
  })

  test('inline error supersedes hint; pattern + description cap apply', () => {
    render(
      <NameDescriptionFields
        testidPrefix="x-rename"
        nameLabel="New name"
        nameHint="slug rules"
        name="Bad Name"
        onNameChange={() => {}}
        nameError="name invalid"
        namePattern="[a-z0-9-]+"
        descriptionLabel="Description"
        description="d"
        onDescriptionChange={() => {}}
        descriptionMaxLength={4096}
      />,
    )
    // Field renders error XOR hint — the error wins when both are supplied.
    expect(screen.getByText('name invalid')).toBeTruthy()
    expect(screen.queryByText('slug rules')).toBeNull()
    expect((screen.getByTestId('x-rename-name') as HTMLInputElement).getAttribute('pattern')).toBe(
      '[a-z0-9-]+',
    )
    expect((screen.getByTestId('x-rename-description') as HTMLInputElement).maxLength).toBe(4096)
  })

  test('name hint renders when there is no error', () => {
    render(
      <NameDescriptionFields
        testidPrefix="x"
        nameLabel="Name"
        nameHint="slug rules"
        name=""
        onNameChange={() => {}}
        descriptionLabel="Description"
        description=""
        onDescriptionChange={() => {}}
      />,
    )
    expect(screen.getByText('slug rules')).toBeTruthy()
  })

  test('both onChange callbacks emit the raw value', () => {
    const onName = vi.fn()
    const onDesc = vi.fn()
    render(
      <NameDescriptionFields
        testidPrefix="x"
        nameLabel="Name"
        name=""
        onNameChange={onName}
        descriptionLabel="Description"
        description=""
        onDescriptionChange={onDesc}
      />,
    )
    fireEvent.change(screen.getByTestId('x-name'), { target: { value: 'a' } })
    fireEvent.change(screen.getByTestId('x-description'), { target: { value: 'b' } })
    expect(onName).toHaveBeenCalledWith('a')
    expect(onDesc).toHaveBeenCalledWith('b')
  })
})
