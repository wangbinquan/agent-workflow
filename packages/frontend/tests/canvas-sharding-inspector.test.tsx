// LOCKS: RFC-055 — NodeInspector agent-multi sharding strategy field.
//
// Verifies that the Inspector exposes the three shardingStrategy kinds
// (per-file / per-n-files / per-directory) via the shared <Select> +
// <NumberInput> primitives, writes back the full strategy object, and
// stays out of the way for non-agent-multi nodes. Source-level guards at
// the bottom lock in the public component contract.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { NodeInspector } from '../src/components/canvas/NodeInspector'
import '../src/i18n'

function wrap(node: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ binary: 'opencode', cached: false, models: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function makeDef(nodes: WorkflowNode[]): WorkflowDefinition {
  return { $schema_version: 3, inputs: [], nodes, edges: [] }
}

function Host({
  initial,
  onChangeSpy,
  selectedNodeId = 'm1',
}: {
  initial: WorkflowDefinition
  onChangeSpy: (def: WorkflowDefinition) => void
  selectedNodeId?: string
}) {
  const [def, setDef] = useState<WorkflowDefinition>(initial)
  return (
    <NodeInspector
      definition={def}
      selectedNodeId={selectedNodeId}
      agents={[]}
      onChange={(next) => {
        setDef(next)
        onChangeSpy(next)
      }}
      onClose={() => {}}
    />
  )
}

function getStrategyTrigger(): HTMLButtonElement {
  // The Select trigger is a button with role=combobox and aria-label matching
  // the field label. There are no other comboboxes on an agent-multi inspector
  // before this one renders (sourcePort uses two native <select>s), so we
  // can grab by role.
  const combos = document.querySelectorAll('button[role="combobox"]')
  const trigger = Array.from(combos).find(
    (b) => b.getAttribute('aria-label')?.includes('Sharding strategy') ?? false,
  ) as HTMLButtonElement | undefined
  if (!trigger) throw new Error('sharding strategy combobox not found')
  return trigger
}

function openListbox(trigger: HTMLButtonElement): HTMLUListElement {
  fireEvent.click(trigger)
  const list = document.querySelector('ul[role="listbox"]') as HTMLUListElement | null
  if (!list) throw new Error('listbox not opened')
  return list
}

function clickOption(list: HTMLUListElement, labelSubstr: string) {
  const opt = Array.from(list.querySelectorAll('li[role="option"]')).find((li) =>
    (li.textContent ?? '').includes(labelSubstr),
  )
  if (!opt) throw new Error(`option containing "${labelSubstr}" not found`)
  fireEvent.mouseDown(opt)
}

describe('NodeInspector — RFC-055 sharding strategy', () => {
  test('agent-multi node with no strategy shows the field defaulted to per-file', () => {
    const onChange = vi.fn()
    wrap(
      <Host
        initial={makeDef([{ id: 'm1', kind: 'agent-multi' } as unknown as WorkflowNode])}
        onChangeSpy={onChange}
      />,
    )
    const trigger = getStrategyTrigger()
    // The trigger label reflects the currently-selected option.
    expect(trigger.textContent ?? '').toContain('per-file')
    // Neither n nor depth secondary inputs render for per-file.
    expect(document.querySelector('[data-testid="sharding-n-input"]')).toBeNull()
    expect(document.querySelector('[data-testid="sharding-depth-input"]')).toBeNull()
  })

  test('switching to per-n-files writes {kind, n:5} and reveals the N input', () => {
    const onChange = vi.fn()
    wrap(
      <Host
        initial={makeDef([{ id: 'm1', kind: 'agent-multi' } as unknown as WorkflowNode])}
        onChangeSpy={onChange}
      />,
    )
    const trigger = getStrategyTrigger()
    const list = openListbox(trigger)
    clickOption(list, 'per-n-files')
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as WorkflowDefinition
    expect((last.nodes[0] as Record<string, unknown>).shardingStrategy).toEqual({
      kind: 'per-n-files',
      n: 5,
    })
    const nInput = document.querySelector(
      '[data-testid="sharding-n-input"]',
    ) as HTMLInputElement | null
    expect(nInput).not.toBeNull()
    expect(nInput!.value).toBe('5')
    expect(document.querySelector('[data-testid="sharding-depth-input"]')).toBeNull()
  })

  test('changing N updates the strategy with the new integer value', () => {
    const onChange = vi.fn()
    wrap(
      <Host
        initial={makeDef([
          {
            id: 'm1',
            kind: 'agent-multi',
            shardingStrategy: { kind: 'per-n-files', n: 5 },
          } as unknown as WorkflowNode,
        ])}
        onChangeSpy={onChange}
      />,
    )
    const nInput = document.querySelector('[data-testid="sharding-n-input"]') as HTMLInputElement
    fireEvent.change(nInput, { target: { value: '12' } })
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as WorkflowDefinition
    expect((last.nodes[0] as Record<string, unknown>).shardingStrategy).toEqual({
      kind: 'per-n-files',
      n: 12,
    })
  })

  test('switching to per-directory writes {kind} (no depth) and reveals empty depth input', () => {
    const onChange = vi.fn()
    wrap(
      <Host
        initial={makeDef([{ id: 'm1', kind: 'agent-multi' } as unknown as WorkflowNode])}
        onChangeSpy={onChange}
      />,
    )
    const trigger = getStrategyTrigger()
    const list = openListbox(trigger)
    clickOption(list, 'per-directory')
    const last = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as WorkflowDefinition
    expect((last.nodes[0] as Record<string, unknown>).shardingStrategy).toEqual({
      kind: 'per-directory',
    })
    const depthInput = document.querySelector(
      '[data-testid="sharding-depth-input"]',
    ) as HTMLInputElement | null
    expect(depthInput).not.toBeNull()
    expect(depthInput!.value).toBe('') // empty = backend default 1
  })

  test('typing depth=2 then clearing writes {kind, depth:2} then drops depth back to {kind}', () => {
    const onChange = vi.fn()
    wrap(
      <Host
        initial={makeDef([
          {
            id: 'm1',
            kind: 'agent-multi',
            shardingStrategy: { kind: 'per-directory' },
          } as unknown as WorkflowNode,
        ])}
        onChangeSpy={onChange}
      />,
    )
    const depthInput = document.querySelector(
      '[data-testid="sharding-depth-input"]',
    ) as HTMLInputElement
    fireEvent.change(depthInput, { target: { value: '2' } })
    let last = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as WorkflowDefinition
    expect((last.nodes[0] as Record<string, unknown>).shardingStrategy).toEqual({
      kind: 'per-directory',
      depth: 2,
    })
    fireEvent.change(depthInput, { target: { value: '' } })
    last = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as WorkflowDefinition
    expect((last.nodes[0] as Record<string, unknown>).shardingStrategy).toEqual({
      kind: 'per-directory',
    })
  })

  test('flipping per-n-files → per-file → per-n-files defaults n back to 5 (cross-kind discards stale n)', () => {
    const onChange = vi.fn()
    wrap(
      <Host
        initial={makeDef([
          {
            id: 'm1',
            kind: 'agent-multi',
            shardingStrategy: { kind: 'per-n-files', n: 12 },
          } as unknown as WorkflowNode,
        ])}
        onChangeSpy={onChange}
      />,
    )
    let trigger = getStrategyTrigger()
    let list = openListbox(trigger)
    clickOption(list, 'per-file')
    expect(
      (
        (onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as WorkflowDefinition)
          .nodes[0] as Record<string, unknown>
      ).shardingStrategy,
    ).toEqual({ kind: 'per-file' })
    trigger = getStrategyTrigger()
    list = openListbox(trigger)
    clickOption(list, 'per-n-files')
    // After per-file the previous n=12 is gone, so the default 5 kicks in.
    expect(
      (
        (onChange.mock.calls[onChange.mock.calls.length - 1]?.[0] as WorkflowDefinition)
          .nodes[0] as Record<string, unknown>
      ).shardingStrategy,
    ).toEqual({ kind: 'per-n-files', n: 5 })
  })

  test('non-agent-multi nodes do not render the sharding field', () => {
    const onChange = vi.fn()
    wrap(
      <Host
        initial={makeDef([{ id: 's1', kind: 'agent-single' } as unknown as WorkflowNode])}
        onChangeSpy={onChange}
        selectedNodeId="s1"
      />,
    )
    expect(document.querySelector('[data-testid="sharding-n-input"]')).toBeNull()
    expect(document.querySelector('[data-testid="sharding-depth-input"]')).toBeNull()
    const combos = Array.from(document.querySelectorAll('button[role="combobox"]'))
    const shardingCombo = combos.find((b) =>
      b.getAttribute('aria-label')?.includes('Sharding strategy'),
    )
    expect(shardingCombo).toBeUndefined()
  })
})

describe('RFC-055 source-level guards', () => {
  const root = resolve(__dirname, '..')

  test('NodeInspector.tsx imports ShardingStrategyField and references i18n key', () => {
    const src = readFileSync(resolve(root, 'src/components/canvas/NodeInspector.tsx'), 'utf8')
    expect(src).toContain("from './ShardingStrategyField'")
    expect(src).toContain('<ShardingStrategyField')
    expect(src).toContain('shardingStrategy')
  })

  test('ShardingStrategyField.tsx uses shared <Select> + <NumberInput> (not native chrome)', () => {
    const raw = readFileSync(
      resolve(root, 'src/components/canvas/ShardingStrategyField.tsx'),
      'utf8',
    )
    // Strip `// …` line comments so the file-top docblock's example text
    // ("<select> chrome") can't satisfy the "no native element" guards.
    const src = raw.replace(/\/\/.*$/gm, '')
    expect(raw).toContain("from '../Select'")
    expect(raw).toContain("from '../Form'")
    // No native dropdown / number element should be hand-rolled here.
    expect(src).not.toMatch(/<select[\s>]/)
    expect(src).not.toMatch(/<input[\s>]/)
    // Pure helpers are sourced from @agent-workflow/shared, not redefined here.
    expect(raw).toContain("from '@agent-workflow/shared'")
    expect(raw).toContain('normalizeShardingStrategy')
    // Required i18n key footprints land in the file.
    expect(raw).toContain('inspector.fieldShardingStrategy')
    expect(raw).toContain('inspector.shardingKind.')
  })
})
