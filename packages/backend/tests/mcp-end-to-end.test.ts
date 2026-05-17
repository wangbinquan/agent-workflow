// RFC-028 T12 — end-to-end backend integration: the bytes that actually land
// in OPENCODE_CONFIG_CONTENT when a node spawns.
//
// This test is the closest thing to a Playwright e2e we can do without a
// live opencode subprocess. It threads:
//   create-mcp + create-agent → resolve closure → buildInlineConfig →
//   serialise inline JSON
// and asserts the exact wire shape opencode would see.
//
// If this is red, the contract that an agent declaring `mcp: ['x']` results
// in `mcp.x: {...}` inside the env var is broken — RFC-028 §1 fails.

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createAgent, getAgent } from '../src/services/agent'
import { createMcp } from '../src/services/mcp'
import { collectMcpNamesFromClosure, loadMcpsByNames } from '../src/services/mcpClosure'
import { resolveDependsClosure } from '../src/services/agentDeps'
import { buildInlineConfig } from '../src/services/runner'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('RFC-028 end-to-end inline injection', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('single agent + single MCP → inline JSON has mcp.{name} with opencode wire fields', async () => {
    await createMcp(db, {
      name: 'postgres-prod',
      description: 'prod DB',
      type: 'local',
      config: {
        command: ['uvx', 'postgres-mcp'],
        env: { PG_URL: 'postgresql://localhost/x' },
        timeoutMs: 7000,
      },
      enabled: true,
    })
    await createAgent(db, {
      name: 'auditor',
      description: '',
      outputs: [],
      readonly: false,
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: ['postgres-prod'],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })

    const agent = (await getAgent(db, 'auditor'))!
    const closure = await resolveDependsClosure(db, agent)
    if (closure.ok === false) throw new Error('cycle: ' + closure.cyclePath.join(' → '))
    const mcpNames = collectMcpNamesFromClosure(closure.agents)
    const mcps = await loadMcpsByNames(db, mcpNames)
    const inline = buildInlineConfig(agent, undefined, closure.agents.slice(1), mcps)

    // The env-var contents (what opencode actually sees on its stdin):
    const env = JSON.stringify(inline)

    // mcp section is present and uses opencode's wire names.
    expect(inline.mcp).toBeDefined()
    expect(inline.mcp!['postgres-prod']).toEqual({
      type: 'local',
      enabled: true,
      command: ['uvx', 'postgres-mcp'],
      environment: { PG_URL: 'postgresql://localhost/x' },
      timeout: 7000,
    })

    // No platform-side field names leak into the env-var (these would crash
    // opencode's Effect Schema validation on receive).
    expect(env).not.toContain('"timeoutMs"')
    expect(env).not.toContain('"cwd"')
    expect(env).toContain('"environment"')
    expect(env).toContain('"timeout":7000')
  })

  test('dependsOn closure merges MCPs across agents; order = root first, BFS for deps', async () => {
    await createMcp(db, {
      name: 'm-leaf',
      description: '',
      type: 'remote',
      config: { url: 'https://leaf.io/mcp' },
      enabled: true,
    })
    await createMcp(db, {
      name: 'm-mid',
      description: '',
      type: 'local',
      config: { command: ['mid-tool'] },
      enabled: true,
    })
    await createMcp(db, {
      name: 'm-root',
      description: '',
      type: 'local',
      config: { command: ['root-tool'] },
      enabled: true,
    })
    await createAgent(db, {
      name: 'leaf',
      description: '',
      outputs: [],
      readonly: false,
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: ['m-leaf'],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    await createAgent(db, {
      name: 'mid',
      description: '',
      outputs: [],
      readonly: false,
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: ['leaf'],
      mcp: ['m-mid'],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    await createAgent(db, {
      name: 'root',
      description: '',
      outputs: [],
      readonly: false,
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: ['mid'],
      mcp: ['m-root'],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })

    const agent = (await getAgent(db, 'root'))!
    const closure = await resolveDependsClosure(db, agent)
    if (closure.ok === false) throw new Error('cycle')
    const mcpNames = collectMcpNamesFromClosure(closure.agents)
    const mcps = await loadMcpsByNames(db, mcpNames)
    const inline = buildInlineConfig(agent, undefined, closure.agents.slice(1), mcps)

    // All three agents present in the inline agent map.
    expect(Object.keys(inline.agent).sort()).toEqual(['leaf', 'mid', 'root'])
    // MCP union present; BFS-first order: root → mid → leaf.
    expect(Object.keys(inline.mcp ?? {})).toEqual(['m-root', 'm-mid', 'm-leaf'])
    expect(inline.mcp!['m-leaf']!.type).toBe('remote')
    expect(inline.mcp!['m-mid']!.type).toBe('local')
  })

  test('enabled=false MCP is skipped (never appears in inline)', async () => {
    await createMcp(db, {
      name: 'on',
      description: '',
      type: 'local',
      config: { command: ['x'] },
      enabled: true,
    })
    await createMcp(db, {
      name: 'off',
      description: '',
      type: 'local',
      config: { command: ['y'] },
      enabled: false,
    })
    await createAgent(db, {
      name: 'a',
      description: '',
      outputs: [],
      readonly: false,
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: ['on', 'off'],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })

    const agent = (await getAgent(db, 'a'))!
    const closure = await resolveDependsClosure(db, agent)
    if (closure.ok === false) throw new Error('cycle')
    const mcps = await loadMcpsByNames(db, collectMcpNamesFromClosure(closure.agents))
    const inline = buildInlineConfig(agent, undefined, closure.agents.slice(1), mcps)
    expect(Object.keys(inline.mcp ?? {})).toEqual(['on'])
  })

  test('agent with empty mcp[] produces inline with no mcp key (clean baseline)', async () => {
    await createAgent(db, {
      name: 'minimal',
      description: '',
      outputs: [],
      readonly: false,
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      bodyMd: '',
    })
    const agent = (await getAgent(db, 'minimal'))!
    const closure = await resolveDependsClosure(db, agent)
    if (closure.ok === false) throw new Error('cycle')
    const mcps = await loadMcpsByNames(db, collectMcpNamesFromClosure(closure.agents))
    const inline = buildInlineConfig(agent, undefined, closure.agents.slice(1), mcps)
    expect('mcp' in inline).toBe(false)
    expect(JSON.stringify(inline)).not.toContain('"mcp"')
  })
})
