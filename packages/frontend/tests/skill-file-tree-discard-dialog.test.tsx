// RFC-201 T3.2 — file selection no longer owns a lossy one-file buffer.  Every
// path is a route-owned staged scope, so switching files preserves edits and
// create/delete remain reversible until Save All.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import type { FileNode, SkillContent } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { SkillFileTree } from '../src/components/SkillFileTree'
import {
  createSkillCompositeDraft,
  editSkillFile,
  editSkillNewPath,
  receiveSkillFile,
  stageSkillFileCreate,
  stageSkillFileDelete,
  undoSkillFile,
  type SkillCompositeDraftState,
} from '../src/lib/skill-composite-draft'
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
]

const INITIAL: SkillContent = {
  name: 'sk1',
  description: 'd',
  bodyMd: 'b',
  frontmatterExtra: {},
  token: 'TOK1',
}

function Harness() {
  const [selected, setSelected] = useState<string | null>(null)
  const [state, setState] = useState<SkillCompositeDraftState>(() =>
    createSkillCompositeDraft(INITIAL),
  )
  return (
    <SkillFileTree
      skillId="skill-1"
      selected={selected}
      onSelectedChange={setSelected}
      newPath={state.newPath.draft}
      onNewPathChange={(path) => setState((current) => editSkillNewPath(current, path))}
      fileScopes={state.files}
      onFileLoaded={(path, content, epoch) =>
        setState((current) => receiveSkillFile(current, path, content, epoch))
      }
      onFileChange={(path, content) => setState((current) => editSkillFile(current, path, content))}
      onStageCreate={(path) => setState((current) => stageSkillFileCreate(current, path))}
      onStageDelete={(path) => setState((current) => stageSkillFileDelete(current, path))}
      onUndo={(path) => setState((current) => undoSkillFile(current, path))}
    />
  )
}

function setup() {
  const calls: Array<{ url: string; method: string }> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push({ url, method })
    if (url.includes('/files')) return json(FILES)
    if (url.includes('/file')) {
      const path = new URL(url).searchParams.get('path')
      return json({ content: path === 'b.txt' ? 'beta' : 'alpha' })
    }
    return new Response('not found', { status: 404 })
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  )
  return calls
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RFC-201 controlled SkillFileTree', () => {
  test('switching paths preserves every staged draft without a discard dialog', async () => {
    setup()
    fireEvent.click(await screen.findByRole('button', { name: /a\.txt/i }))
    fireEvent.change(await screen.findByDisplayValue('alpha'), {
      target: { value: 'edited alpha' },
    })

    fireEvent.click(screen.getByRole('button', { name: /b\.txt/i }))
    expect(await screen.findByDisplayValue('beta')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /a\.txt/i }))
    expect(await screen.findByDisplayValue('edited alpha')).toBeTruthy()
    expect(screen.getAllByText(/edited · pending/i).length).toBeGreaterThan(0)
  })

  test('create and delete are staged, reversible, and send no write request', async () => {
    const calls = setup()
    const pathInput = await screen.findByTestId('skill-new-path')
    fireEvent.change(pathInput, { target: { value: 'new.md' } })
    fireEvent.click(screen.getByRole('button', { name: /add to changes/i }))
    await waitFor(() => {
      const editor = document.querySelector<HTMLTextAreaElement>('.file-tree__editor textarea')
      expect(editor).not.toBeNull()
      fireEvent.change(editor!, { target: { value: 'draft' } })
    })
    expect(screen.getAllByText(/new · pending/i).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: /undo pending change/i }))
    expect(screen.queryByRole('button', { name: /new\.md/i })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /b\.txt/i }))
    await screen.findByDisplayValue('beta')
    fireEvent.click(screen.getByRole('button', { name: /mark for deletion/i }))
    expect(await screen.findByText(/marked for deletion/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /undo pending change/i }))
    expect(await screen.findByDisplayValue('beta')).toBeTruthy()

    expect(calls.every((call) => call.method === 'GET')).toBe(true)
  })
})
