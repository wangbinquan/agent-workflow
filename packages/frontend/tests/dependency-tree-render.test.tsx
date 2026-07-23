// RFC-022: visual contract for `<DependencyTree>` + `<DependencyCycleHint>`.
// Pulls test fixtures via the helper so any change in tree-building shows
// up here too. Asserted via accessible roles + visible text — no internal
// DOM structure beyond that, so cosmetic CSS changes don't regress these.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { DependencyCycleHint, DependencyTree } from '../src/components/agents/DependencyTree'
import { buildDependencyTree, type DependencyTreeAgent } from '../src/lib/dependency-tree'
import { setBaseUrl, setToken } from '../src/stores/auth'

function mk(
  name: string,
  dependsOn: string[] = [],
  description = `desc:${name}`,
  skills: readonly string[] = [],
  // RFC-030 follow-up — default [] (no MCP chip), explicit names in the
  // dedicated MCP-chip test case below.
  mcps: readonly string[] = [],
  plugins: readonly string[] = [],
): DependencyTreeAgent {
  return { id: name, name, description, skills, mcps, plugins, dependsOn }
}

function renderTree(
  tree: ReturnType<typeof buildDependencyTree>,
  onNodeClick?: (id: string) => void,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <DependencyTree tree={tree} onNodeClick={onNodeClick} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('<DependencyTree>', () => {
  test('renders a single leaf for an agent with no deps', () => {
    const tree = buildDependencyTree([mk('alone')], 'alone')
    renderTree(tree)
    const items = screen.getAllByRole('treeitem')
    expect(items).toHaveLength(1)
    expect(items[0]?.textContent ?? '').toContain('alone')
  })

  test('renders nested rows for a linear closure', () => {
    const flat = [mk('a', ['b']), mk('b', ['c']), mk('c')]
    const tree = buildDependencyTree(flat, 'a')
    renderTree(tree)
    const items = screen.getAllByRole('treeitem').map((r) => r.getAttribute('aria-label'))
    expect(items).toEqual(['a', 'b', 'c'])
  })

  test('diamond: the second leaf sighting renders `↑ see above` and no further rows', () => {
    const flat = [mk('top', ['m1', 'm2']), mk('m1', ['leaf']), mk('m2', ['leaf']), mk('leaf')]
    const tree = buildDependencyTree(flat, 'top')
    renderTree(tree)
    // Tree contains: top, m1, leaf, m2, leaf-dup. Five treeitems total.
    const items = screen.getAllByRole('treeitem')
    expect(items).toHaveLength(5)
    // The `↑ see above` hint only appears for the duplicate sighting.
    const hints = screen.getAllByText(/see above/i)
    expect(hints).toHaveLength(1)
  })

  // RFC-030 follow-up — closure rows that bring in MCP servers (declared on
  // the agent itself, not unioned across the closure) get an "MCPs:" chip
  // alongside the skill + readonly chips. Empty arrays produce no chip.
  test('renders MCP chip with names when mcps non-empty, omits it when empty', () => {
    const flat = [
      mk('top', ['mid']),
      mk('mid', ['leaf'], 'desc:mid', /* skills */ [], /* mcps */ ['m-a', 'm-b']),
      mk('leaf'),
    ]
    const tree = buildDependencyTree(flat, 'top')
    renderTree(tree)
    // `mid` should render an "MCPs:" chip listing the names. `top` / `leaf` should not.
    const mcpChips = screen.getAllByText(/\bMCPs?\b/i)
    expect(mcpChips).toHaveLength(1)
    const text = mcpChips[0]?.textContent ?? ''
    expect(text).toContain('m-a')
    expect(text).toContain('m-b')
  })

  // RFC-046 follow-up — closure preview now renders skill / plugin names
  // (not counts), and omits the chip entirely when the list is empty so the
  // row stays uncluttered for agents with no skills/plugins.
  test('renders Skills chip with names when skills non-empty, omits it when empty', () => {
    const flat = [
      mk('top', ['mid']),
      mk('mid', [], 'desc:mid', /* skills */ ['skill-a', 'skill-b']),
    ]
    const tree = buildDependencyTree(flat, 'top')
    renderTree(tree)
    const skillChips = screen.getAllByText(/Skills?/)
    expect(skillChips).toHaveLength(1)
    const text = skillChips[0]?.textContent ?? ''
    expect(text).toContain('skill-a')
    expect(text).toContain('skill-b')
  })

  test('renders Plugins chip with names when plugins non-empty, omits it when empty', () => {
    const flat = [
      mk('top', ['mid']),
      mk('mid', [], 'desc:mid', /* skills */ [], /* mcps */ [], /* plugins */ ['plug-x']),
    ]
    const tree = buildDependencyTree(flat, 'top')
    renderTree(tree)
    const pluginChips = screen.getAllByText(/Plugins?/)
    expect(pluginChips).toHaveLength(1)
    expect(pluginChips[0]?.textContent ?? '').toContain('plug-x')
  })

  test('duplicate names render owner cues and onNodeClick emits immutable id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([{ id: 'owner-leaf', displayName: 'Alice' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const flat: DependencyTreeAgent[] = [
      {
        id: 'agent-top',
        name: 'reviewer',
        description: 'top',
        skills: [],
        mcps: [],
        plugins: [],
        dependsOn: ['agent-leaf'],
      },
      {
        id: 'agent-leaf',
        name: 'reviewer',
        ownerUserId: 'owner-leaf',
        description: 'leaf',
        skills: [],
        mcps: [],
        plugins: [],
        dependsOn: [],
      },
    ]
    const tree = buildDependencyTree(flat, 'agent-top')
    const onClick = vi.fn()
    renderTree(tree, onClick)
    const button = await screen.findByRole('button', { name: /Open agent reviewer · Alice/i })
    fireEvent.click(button)
    expect(onClick).toHaveBeenCalledWith('agent-leaf')
  })
})

describe('<DependencyCycleHint>', () => {
  test('renders the cycle path as a single ASCII arrow string', () => {
    render(<DependencyCycleHint cyclePath={['a', 'b', 'c', 'a']} />)
    const banner = screen.getByRole('alert')
    expect(banner.textContent ?? '').toContain('a → b → c → a')
  })
})
