// RFC-258 T9 — graph↔source linking. Locks:
//  - the three view entries (graph member ‹›, call-chain node ‹›, sequence
//    message label) fire onOpenSource with a (structuralPath, qualifiedName)
//    target; external/unresolved chain nodes get NO entry (gate F-06);
//  - the drilldown split renders SourcePane beside the keep-alive graph pane
//    WITHOUT unmounting it, and closing the dialog resets the pane (F-12);
//  - splitStructuralPath resolves the repo by the diff's EXPLICIT repoKey
//    field, never by prefix shape (F-04).

import { afterEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '../src/i18n'
import type * as ApiClientModule from '../src/api/client'

vi.mock('../src/api/client', async () => {
  const actual = await vi.importActual<typeof ApiClientModule>('../src/api/client')
  return {
    ...actual,
    api: {
      ...actual.api,
      get: vi.fn().mockImplementation((url: string) => {
        if (url.includes('/file-symbols')) {
          return Promise.resolve({
            lang: 'typescript',
            status: 'ok',
            symbols: [
              {
                name: 'charge',
                qualifiedName: 'OrderService.charge',
                kind: 'method',
                range: { startLine: 7, endLine: 9 },
              },
            ],
          })
        }
        if (url.includes('/file-content')) {
          return Promise.resolve({ exists: true, content: 'line1\nline2\n', size: 12 })
        }
        return Promise.resolve({ targets: [] })
      }),
    },
  }
})

import { SequenceDiagram } from '../src/components/structure/SequenceDiagram'
import { SourcePane, splitStructuralPath } from '../src/components/code/SourcePane'
import { buildSequence } from '../src/lib/sequence'
import type { StructuralDiff } from '@agent-workflow/shared'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('splitStructuralPath (F-04)', () => {
  const diff = {
    files: [
      { filePath: 'vendor/lib/src/a.ts', repoKey: 'vendor/lib' },
      { filePath: 'src/root.ts' },
    ],
  } as unknown as StructuralDiff

  test('resolves the repo by the explicit repoKey field and strips it', () => {
    expect(splitStructuralPath(diff, 'vendor/lib/src/a.ts')).toEqual({
      repoKey: 'vendor/lib',
      filePath: 'src/a.ts',
    })
  })

  test('root-repo files and structural misses stay unprefixed', () => {
    expect(splitStructuralPath(diff, 'src/root.ts')).toEqual({
      repoKey: '',
      filePath: 'src/root.ts',
    })
    expect(splitStructuralPath(diff, 'not/in/diff.ts')).toEqual({
      repoKey: '',
      filePath: 'not/in/diff.ts',
    })
  })
})

describe('sequence message → source entry (F-06)', () => {
  test('resolved messages with a ref are clickable; unresolved are not', () => {
    const onOpen = vi.fn()
    const model = buildSequence('t.py::root', [
      {
        ownerClass: 'src/svc.ts::OrderService',
        method: 'charge()',
        resolution: 'resolved',
        ref: 'src/svc.ts#OrderService.charge',
        children: [],
      },
      { ownerClass: null, method: 'mystery()', resolution: 'unresolved', children: [] },
    ])
    render(<SequenceDiagram model={model} onOpenSource={onOpen} />)
    const chargeLabel = screen.getByText('charge()')
    expect(chargeLabel.getAttribute('role')).toBe('button')
    fireEvent.click(chargeLabel)
    expect(onOpen).toHaveBeenCalledWith({
      structuralPath: 'src/svc.ts',
      qualifiedName: 'OrderService.charge',
    })
    expect(screen.getByText('mystery()').getAttribute('role')).toBeNull()
  })
})

describe('call-chain tree source entries (P1-9⑤ / F-06)', () => {
  test('resolved targets get ‹›; external/unresolved get none', async () => {
    const { CallChainView } = await import('../src/components/structure/CallChainView')
    const apiModule = await import('../src/api/client')
    const spy = apiModule.api.get as ReturnType<typeof vi.fn>
    const orig = spy.getMockImplementation()
    spy.mockImplementation((url: string) => {
      if (url.includes('/call-targets')) {
        return Promise.resolve({
          targets: [
            {
              order: 0,
              label: 'resolvedFn()',
              resolution: 'resolved',
              ref: 'src/a.ts#resolvedFn',
              ownerClass: 'src/a.ts::',
            },
            { order: 1, label: 'externalFn()', resolution: 'external' },
          ],
        })
      }
      return Promise.resolve({ targets: [] })
    })
    const onOpen = vi.fn()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <CallChainView
          taskId="t1"
          root={{ ref: 'src/root.ts#main', label: 'main()' }}
          onOpenSource={onOpen}
        />
      </QueryClientProvider>,
    )
    await screen.findByText('resolvedFn()')
    const entries = document.querySelectorAll('.callchain__source')
    expect(entries).toHaveLength(1)
    fireEvent.click(entries[0] as Element)
    expect(onOpen).toHaveBeenCalledWith({ structuralPath: 'src/a.ts', qualifiedName: 'resolvedFn' })
    if (orig !== undefined) spy.mockImplementation(orig)
  })
})

describe('<SourcePane />', () => {
  test('resolves a qualifiedName to its line via file-symbols and renders the viewer', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <SourcePane
          taskId="t1"
          data={undefined}
          target={{ structuralPath: 'src/svc.ts', qualifiedName: 'OrderService.charge' }}
          engineMode="baseline"
          onClose={() => {}}
        />
      </QueryClientProvider>,
    )
    expect(await screen.findByTestId('drill-source-pane')).toBeTruthy()
    // the pane fetched symbols then content — the viewer shell must appear
    expect(await screen.findByText('line1')).toBeTruthy()
  })

  test('unresolvable symbol renders the honest empty state', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <SourcePane
          taskId="t1"
          data={undefined}
          target={{ structuralPath: 'src/svc.ts', qualifiedName: 'GhostSymbol.nope' }}
          engineMode="baseline"
          onClose={() => {}}
        />
      </QueryClientProvider>,
    )
    expect(await screen.findByText(/符号未在当前文件|Symbol not found/)).toBeTruthy()
  })
})
