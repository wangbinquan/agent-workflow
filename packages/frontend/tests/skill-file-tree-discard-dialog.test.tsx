// RFC-198 — replacing native confirm in SkillFileTree must keep the pending
// target stable, revalidate it before discarding, and restore keyboard focus
// even when the clicked tree row disappears while the dialog is open.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { FileNode } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { SkillFileTree } from '../src/components/SkillFileTree'
import { setBaseUrl, setToken } from '../src/stores/auth'
import '../src/i18n'

function json(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const FILES: FileNode[] = [
  { path: 'a.txt', type: 'file' },
  { path: 'b.txt', type: 'file' },
  { path: 'c.txt', type: 'file' },
]

function setup() {
  let rows = FILES
  const fileReads: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/files')) return json(rows)
    if (url.includes('/file')) {
      const path = new URL(url).searchParams.get('path')
      if (path !== null) fileReads.push(path)
      return json({ content: path === 'b.txt' ? 'beta' : path === 'c.txt' ? 'gamma' : 'alpha' })
    }
    return new Response('not found', { status: 404 })
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <SkillFileTree skillName="sk1" />
    </QueryClientProvider>,
  )
  return {
    client,
    fileReads,
    view,
    removeTarget() {
      rows = [FILES[0]!]
      act(() => client.setQueryData(['skill-files', 'sk1'], rows))
    },
  }
}

async function makeDirty() {
  fireEvent.click(await screen.findByRole('button', { name: /a\.txt/i }))
  const editor = (await screen.findByDisplayValue('alpha')) as HTMLTextAreaElement
  fireEvent.change(editor, { target: { value: 'edited alpha' } })
  return editor
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RFC-198 SkillFileTree discard confirmation', () => {
  test('cancel preserves the draft and focus; confirm switches to the snapshotted target', async () => {
    const { fileReads } = setup()
    const editor = await makeDirty()
    const target = screen.getByRole('button', { name: /b\.txt/i })

    fireEvent.click(target)
    expect(await screen.findByRole('dialog', { name: /unsaved changes/i })).toBeTruthy()
    expect(editor.value).toBe('edited alpha')

    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(target)
    expect(editor.value).toBe('edited alpha')

    fireEvent.click(target)
    const dialog = await screen.findByRole('dialog', { name: /unsaved changes/i })
    // A second tree click while the modal is open must not replace the original
    // target snapshot, even if a synthetic click reaches the inert background.
    fireEvent.click(screen.getByRole('button', { name: /c\.txt/i }))
    const confirm = within(dialog).getByRole('button', { name: /discard changes/i })
    fireEvent.click(confirm)
    fireEvent.click(confirm)

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(await screen.findByDisplayValue('beta')).toBeTruthy()
    expect(screen.queryByDisplayValue('gamma')).toBeNull()
    expect(fileReads.filter((path) => path === 'b.txt')).toHaveLength(1)
    expect(fileReads).not.toContain('c.txt')
    expect(target.classList.contains('file-tree__item--active')).toBe(true)
    expect(document.activeElement).toBe(target)
  })

  test('a vanished target is rejected and closing falls back to the focusable tree root', async () => {
    const { removeTarget, view } = setup()
    await makeDirty()
    fireEvent.click(screen.getByRole('button', { name: /b\.txt/i }))
    expect(await screen.findByRole('dialog', { name: /unsaved changes/i })).toBeTruthy()

    removeTarget()
    fireEvent.click(screen.getByRole('button', { name: /discard changes/i }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/no longer available/i)
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(view.container.querySelector('.file-tree'))
  })
})
