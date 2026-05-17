// RFC-022: visual contract for `<DependencyTree>` + `<DependencyCycleHint>`.
// Pulls test fixtures via the helper so any change in tree-building shows
// up here too. Asserted via accessible roles + visible text — no internal
// DOM structure beyond that, so cosmetic CSS changes don't regress these.

import { render, screen, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import '@/i18n'
import { DependencyCycleHint, DependencyTree } from '../src/components/agents/DependencyTree'
import { buildDependencyTree, type DependencyTreeAgent } from '../src/lib/dependency-tree'

function mk(
  name: string,
  dependsOn: string[] = [],
  description = `desc:${name}`,
  skillCount = 0,
  readonly = false,
  // RFC-030 follow-up — default 0 (no MCP chip), explicit non-zero in the
  // dedicated MCP-chip test case below.
  mcpCount = 0,
): DependencyTreeAgent {
  return { name, description, skillCount, mcpCount, readonly, dependsOn }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('<DependencyTree>', () => {
  test('renders a single leaf for an agent with no deps', () => {
    const tree = buildDependencyTree([mk('alone')], 'alone')
    render(<DependencyTree tree={tree} />)
    const items = screen.getAllByRole('treeitem')
    expect(items).toHaveLength(1)
    expect(items[0]?.textContent ?? '').toContain('alone')
  })

  test('renders nested rows for a linear closure', () => {
    const flat = [mk('a', ['b']), mk('b', ['c']), mk('c')]
    const tree = buildDependencyTree(flat, 'a')
    render(<DependencyTree tree={tree} />)
    const items = screen.getAllByRole('treeitem').map((r) => r.getAttribute('aria-label'))
    expect(items).toEqual(['a', 'b', 'c'])
  })

  test('diamond: the second leaf sighting renders `↑ see above` and no further rows', () => {
    const flat = [mk('top', ['m1', 'm2']), mk('m1', ['leaf']), mk('m2', ['leaf']), mk('leaf')]
    const tree = buildDependencyTree(flat, 'top')
    render(<DependencyTree tree={tree} />)
    // Tree contains: top, m1, leaf, m2, leaf-dup. Five treeitems total.
    const items = screen.getAllByRole('treeitem')
    expect(items).toHaveLength(5)
    // The `↑ see above` hint only appears for the duplicate sighting.
    const hints = screen.getAllByText(/see above/i)
    expect(hints).toHaveLength(1)
  })

  // RFC-030 follow-up — closure rows that bring in MCP servers (declared on
  // the agent itself, not unioned across the closure) get a "{n} MCP(s)" chip
  // alongside the skill-count + readonly chips. Counts of 0 produce no chip.
  test('renders MCP chip when mcpCount > 0, omits it when mcpCount === 0', () => {
    const flat = [
      mk('top', ['mid']),
      mk('mid', ['leaf'], 'desc:mid', /* skillCount */ 0, /* readonly */ false, /* mcpCount */ 2),
      mk('leaf'),
    ]
    const tree = buildDependencyTree(flat, 'top')
    render(<DependencyTree tree={tree} />)
    // `mid` should render an "MCP" chip (count: 2). `top` and `leaf` should not.
    const mcpChips = screen.getAllByText(/\bMCP\b/i)
    expect(mcpChips).toHaveLength(1)
    expect(mcpChips[0]?.textContent ?? '').toMatch(/2/)
  })

  test('onNodeClick fires with the clicked agent name (only for expanded sightings)', () => {
    const flat = [mk('top', ['leaf']), mk('leaf')]
    const tree = buildDependencyTree(flat, 'top')
    const onClick = vi.fn()
    render(<DependencyTree tree={tree} onNodeClick={onClick} />)
    fireEvent.click(screen.getByRole('button', { name: /Open agent leaf/i }))
    expect(onClick).toHaveBeenCalledWith('leaf')
  })
})

describe('<DependencyCycleHint>', () => {
  test('renders the cycle path as a single ASCII arrow string', () => {
    render(<DependencyCycleHint cyclePath={['a', 'b', 'c', 'a']} />)
    const banner = screen.getByRole('alert')
    expect(banner.textContent ?? '').toContain('a → b → c → a')
  })
})
