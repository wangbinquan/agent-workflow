// RFC-201 B4 — Memory UI must consume the server-returned `canManage` bit
// exactly. Missing/false annotations fail closed; actor role and scope owner
// are never reconstructed by All / By-scope / Scoped / Fuse surfaces.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import type { MemorySummary } from '@agent-workflow/shared'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type * as ApiClientModule from '../src/api/client'

vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('../src/api/client')
  return {
    ...actual,
    api: { ...actual.api, get: vi.fn() },
  }
})

import { api } from '../src/api/client'
import { MemoryByScopeBrowser } from '../src/components/memory/MemoryByScopeBrowser'
import { MemoryScopedList } from '../src/components/memory/MemoryScopedList'
import '../src/i18n'

const mockedGet = vi.mocked(api.get)

function memory(overrides: Partial<MemorySummary> = {}): MemorySummary {
  return {
    id: 'mem-1',
    scopeType: 'workflow',
    scopeId: 'workflow-1',
    title: 'Server ACL oracle',
    status: 'approved',
    tags: [],
    approvedAt: 1,
    version: 1,
    distillAction: null,
    ...overrides,
  }
}

function renderWithClient(node: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Memory canManage server oracle', () => {
  test.each([
    ['missing', memory()],
    ['false', memory({ canManage: false })],
  ])('By-scope hides Edit when canManage is %s', async (_label, row) => {
    mockedGet.mockResolvedValue({ items: [row] })
    renderWithClient(<MemoryByScopeBrowser />)
    expect(await screen.findByTestId('memory-row-mem-1')).toBeTruthy()
    expect(screen.queryByTestId('memory-row-mem-1-edit')).toBeNull()
  })

  test('By-scope shows Edit only for canManage=true', async () => {
    mockedGet.mockResolvedValue({ items: [memory({ canManage: true })] })
    renderWithClient(<MemoryByScopeBrowser />)
    expect(await screen.findByTestId('memory-row-mem-1-edit')).toBeTruthy()
  })

  test.each([
    ['missing', memory()],
    ['false', memory({ canManage: false })],
  ])('Scoped list hides Edit when canManage is %s', async (_label, row) => {
    mockedGet.mockResolvedValue({ items: [row] })
    renderWithClient(<MemoryScopedList scopeType="workflow" scopeId="workflow-1" />)
    expect(await screen.findByTestId('memory-row-mem-1')).toBeTruthy()
    expect(screen.queryByTestId('memory-row-mem-1-edit')).toBeNull()
  })

  test('Scoped list shows Edit only for canManage=true', async () => {
    mockedGet.mockResolvedValue({ items: [memory({ canManage: true })] })
    renderWithClient(<MemoryScopedList scopeType="workflow" scopeId="workflow-1" />)
    expect(await screen.findByTestId('memory-row-mem-1-edit')).toBeTruthy()
  })
})
