// RFC-251 — plugins and the dependsOn closure reach the VERIFIED path's
// controlled config again.
//
// Why this test exists: RFC-224 rejected both outright (verifiedPlan.ts) on
// three claims about opencode behaviour, two of which do not match opencode
// v1.18.4 and one of which was a misreading. RFC-251 restores the features by
// assembling them into the controlled config instead. These cases lock the
// assembly AND the one failure mode that is completely silent:
//
//   OPENCODE_PURE empties `cfg.plugin_origins` before any external plugin loads
//   (opencode plugin/index.ts:177). Emitting `plugin: [...]` while that flag is
//   still set produces NO error and NO log — opencode just runs with a
//   different plugin set than the operator selected. The flag is therefore
//   derived from the config itself, and that derivation is asserted here in
//   both directions.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Plugin } from '@agent-workflow/shared'
import { ROOT_SESSION_PERMISSION_RULES } from '@/services/runtime/opencode/directApiSchemas'
import { removeSealedTree } from '@/services/runtime/opencode/sealedInputs'
import {
  buildControlledOpencodeConfig,
  buildHermeticServerEnv,
  buildStrictProviderAuth,
  prepareHermeticOpencodeLayout,
} from '@/services/runtime/opencode/hermetic'

const roots: string[] = []
function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'rfc251-controlled-'))
  roots.push(value)
  return value
}
afterEach(async () => {
  for (const path of roots.splice(0)) await removeSealedTree(path)
})

function plugin(name: string, partial: Partial<Plugin> = {}): Plugin {
  const base: Plugin = {
    id: 'p-' + name,
    name,
    spec: `${name}@1.0.0`,
    options: {},
    description: '',
    enabled: true,
    sourceKind: 'npm',
    cachedPath: `/tmp/aw-plugins/${name}`,
    resolvedVersion: '1.0.0',
    installedAt: 0,
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
  return { ...base, ...partial }
}

function controlled(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return buildControlledOpencodeConfig({
    name: 'worker',
    prompt: 'body',
    description: 'desc',
    model: 'openai/gpt-5.6',
    toolOutputPattern: '/tmp/aw/tool-output/*',
    shellPath: '/bin/bash',
    allowShell: false,
    ...overrides,
  }) as unknown as Record<string, unknown>
}

async function envFor(config: unknown): Promise<Record<string, string>> {
  const layout = await prepareHermeticOpencodeLayout(root())
  const auth = buildStrictProviderAuth('openai', {
    OPENCODE_AUTH_CONTENT: JSON.stringify({ openai: { type: 'api', key: 'k' } }),
  })
  return buildHermeticServerEnv({
    layout,
    providerID: 'openai',
    auth,
    config: config as never,
    username: 'u',
    password: 'p',
    sourceEnv: { LANG: 'C.UTF-8' },
  })
}

describe('RFC-251 — plugins in the controlled config', () => {
  test('no selection keeps the historical byte-identical `plugin: []`', () => {
    expect(controlled().plugin).toEqual([])
    expect(controlled({ plugins: [] }).plugin).toEqual([])
  })

  test('a selection is encoded with the shared file:// spec rules', () => {
    expect(controlled({ plugins: [plugin('dd')] }).plugin).toEqual(['file:///tmp/aw-plugins/dd'])
    expect(controlled({ plugins: [plugin('dd', { options: { k: 1 } })] }).plugin).toEqual([
      ['file:///tmp/aw-plugins/dd', { k: 1 }],
    ])
  })

  test('disabled rows never reach the controlled config', () => {
    expect(controlled({ plugins: [plugin('off', { enabled: false })] }).plugin).toEqual([])
  })
})

function sub(name: string, partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    prompt: `${name}-body`,
    description: `${name}-desc`,
    model: 'openai/gpt-5.6',
    allowShell: true,
    ...partial,
  }
}

function agentsOf(config: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return config.agent as Record<string, Record<string, unknown>>
}

describe('RFC-251 — the dependsOn closure in the controlled config', () => {
  test('no closure keeps a single primary entry', () => {
    const agents = agentsOf(controlled())
    expect(Object.keys(agents)).toEqual(['worker'])
    expect(agents.worker!.mode).toBe('primary')
  })

  test('closure members register as subagents addressable by name', () => {
    const agents = agentsOf(controlled({ dependents: [sub('auditor'), sub('fixer')] }))
    expect(Object.keys(agents)).toEqual(['worker', 'auditor', 'fixer'])
    expect(agents.auditor!.mode).toBe('subagent')
    expect(agents.fixer!.mode).toBe('subagent')
    expect(agents.auditor!.prompt).toBe('auditor-body')
  })

  test('task is denied without a closure and allowed with one', () => {
    const alone = agentsOf(controlled()).worker!.permission as Record<string, unknown>
    expect(alone.task).toBe('deny')
    const withDeps = agentsOf(controlled({ dependents: [sub('auditor')] })).worker!
      .permission as Record<string, unknown>
    expect(withDeps.task).toBe('allow')
  })

  test('flipping task does not disturb the load-bearing deny-tail order', () => {
    // Re-assigning an existing key must not move it; the qualified Agent.Info
    // rule tail depends on this exact ordering.
    const order = (config: Record<string, unknown>): string[] =>
      Object.keys(agentsOf(config).worker!.permission as Record<string, unknown>)
    expect(order(controlled({ dependents: [sub('auditor')] }))).toEqual(order(controlled()))
  })

  test('a member never inherits the root shell setting — it carries its own', () => {
    // A member entry inherits NOTHING from the root's agent entry, so declaring
    // nothing would mean having nothing.
    const agents = agentsOf(
      controlled({ allowShell: false, dependents: [sub('auditor', { allowShell: true })] }),
    )
    expect((agents.worker!.permission as Record<string, unknown>).bash).toBe('deny')
    expect((agents.auditor!.permission as Record<string, unknown>).bash).toBe('allow')
  })

  test('the member permission surface is complete, not a partial overlay', () => {
    // Whatever the root denies, the member must state for itself — opencode
    // merges agent.permission with the SESSION ruleset, never with the parent
    // agent's entry (session/llm.ts:149).
    const agents = agentsOf(controlled({ dependents: [sub('auditor')] }))
    const root = Object.keys(agents.worker!.permission as Record<string, unknown>)
    const member = Object.keys(agents.auditor!.permission as Record<string, unknown>)
    expect(member).toEqual(root)
  })

  test('members never get task themselves (no nested delegation in v1)', () => {
    const agents = agentsOf(controlled({ dependents: [sub('a'), sub('b')] }))
    for (const name of ['a', 'b']) {
      expect((agents[name]!.permission as Record<string, unknown>).task).toBe('deny')
    }
  })

  test('a member cannot shadow the root, and duplicates collapse', () => {
    const agents = agentsOf(
      controlled({ dependents: [sub('worker'), sub('dup'), sub('dup', { prompt: 'second' })] }),
    )
    expect(Object.keys(agents)).toEqual(['worker', 'dup'])
    expect(agents.worker!.mode).toBe('primary') // root survived intact
    expect(agents.dup!.prompt).toBe('dup-body') // first wins
  })

  test('a prototype-named member is registered, not mistaken for an existing key', () => {
    const agents = agentsOf(controlled({ dependents: [sub('constructor')] }))
    expect(Object.keys(agents)).toEqual(['worker', 'constructor'])
    // Read the OWN property: a plain `.constructor` lookup would find
    // Object.prototype's, which is exactly the confusion this case guards.
    const entry = Object.getOwnPropertyDescriptor(agents, 'constructor')?.value as Record<
      string,
      unknown
    >
    expect(entry.mode).toBe('subagent')
  })

  test('a member with no model is an explicit failure, never a silent default', () => {
    expect(() => controlled({ dependents: [sub('broken', { model: '' })] })).toThrow()
  })
})

describe('RFC-251 — tool denies must never live on the root SESSION', () => {
  // The load-bearing separation behind working subagents.
  //
  // opencode derives a child session's ruleset from the PARENT SESSION's deny
  // rules (agent/subagent-permissions.ts:21-23) and then resolves each tool as
  // `merge(agent.permission, session.permission)` + `findLast`
  // (session/llm.ts:149-151) — so the session side WINS.
  //
  // The platform's long tool-deny tail lives on the AGENT ENTRY, which is not
  // inherited; the session carries only three harmless denies. If a tool-level
  // deny were ever added to the session rules instead, every subagent would
  // inherit it and silently lose that tool — presenting as "the model can't get
  // anything done", never as an error.
  test('the root session ruleset is exactly the three non-tool denies', () => {
    expect(ROOT_SESSION_PERMISSION_RULES.map((rule) => rule.permission)).toEqual([
      'question',
      'plan_enter',
      'plan_exit',
    ])
    for (const rule of ROOT_SESSION_PERMISSION_RULES) {
      expect(rule.action).toBe('deny')
    }
  })

  test('no session rule collides with a tool key on the agent entry', () => {
    const agentToolKeys = Object.keys(
      agentsOf(controlled()).worker!.permission as Record<string, unknown>,
    )
    for (const rule of ROOT_SESSION_PERMISSION_RULES) {
      expect(agentToolKeys).not.toContain(rule.permission)
    }
  })
})

describe('RFC-251 — OPENCODE_PURE is derived from the config', () => {
  test('no plugins selected → PURE stays on (unchanged from RFC-224)', async () => {
    const env = await envFor(controlled())
    expect(env.OPENCODE_PURE).toBe('1')
  })

  test('plugins selected → PURE is absent, or opencode would silently drop them', async () => {
    const env = await envFor(controlled({ plugins: [plugin('dd')] }))
    expect(env).not.toHaveProperty('OPENCODE_PURE')
  })

  test('the internal-plugin gate is a different axis and stays on either way', async () => {
    // OPENCODE_DISABLE_DEFAULT_PLUGINS gates opencode's own internalPlugins
    // (plugin/index.ts:166); it must NOT be relaxed to load operator plugins.
    for (const config of [controlled(), controlled({ plugins: [plugin('dd')] })]) {
      const env = await envFor(config)
      expect(env.OPENCODE_DISABLE_DEFAULT_PLUGINS).toBe('1')
    }
  })

  test('a well-formed but non-selecting plugin field means "no plugins" (fail-strict)', async () => {
    // Anything that is not a NON-EMPTY array must keep the strictest flag, so a
    // shape change upstream can never silently relax PURE.
    for (const value of [[], null, 'nonsense', {}, 0, false]) {
      const env = await envFor({ share: 'disabled', plugin: value })
      expect(env.OPENCODE_PURE).toBe('1')
    }
  })

  test('a non-JSON plugin field is rejected upstream, never silently downgraded', async () => {
    // `undefined` is not valid identity JSON: canonicalizeIdentity throws
    // before the PURE derivation is reached. Locking this keeps the derivation
    // from being the thing that has to defend against malformed configs.
    await expect(envFor({ share: 'disabled', plugin: undefined })).rejects.toThrow()
  })
})
