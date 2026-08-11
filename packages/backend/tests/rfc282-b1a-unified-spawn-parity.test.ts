// RFC-282 — LIVE parity suite for the unified `buildSpawn` facade vs the
// driver-internal assembly bodies (the former contract trio, now named
// functions). Every plan field the launcher consumes (cmd/env/stdin) must be
// byte-identical between
//   facade: driver.buildSpawn(AgentSpawnContext)              — ONE call
//   bodies: assemble*BusinessSpawn/Persona + render*Injection — the internals
// and `declared` must equal the standalone render. Red here = the facade
// drifted from its own assembly, which §0 (功能不受影响) forbids.
//
// §7-1b positive lock included: a persona-only claude spawn stays
// UNCONSTRAINED (declared.tools === null, no --tools argv) — injecting a
// permission would silently shrink four system agents' tool surface
// (2026-07-31 user ruling, 决策 23).

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_CONFIG_DIR_PROFILE,
  type Agent,
  type Mcp,
  type Plugin,
} from '@agent-workflow/shared'
import { getRuntimeDriver } from '../src/services/runtime'
import type {
  AgentSpawnContext,
  BusinessNodeSpawnContext,
  SystemAgentSpawnContext,
} from '../src/services/runtime/types'
import { createLogger } from '../src/util/log'
import type { RuntimeProfile } from '../src/services/runtimeRegistry'
import {
  assembleOpencodeBusinessSpawn,
  assembleOpencodePersonaSpawn,
  renderOpencodeInjection,
} from '../src/services/runtime/opencode/driver'
import {
  assembleClaudeBusinessSpawn,
  assembleClaudePersonaSpawn,
  renderClaudeInjection,
} from '../src/services/runtime/claudeCode/driver'

const log = createLogger('rfc282-b1a')

function mkAgent(name: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-' + name,
    name,
    description: 'desc-' + name,
    outputs: ['result'],
    syncOutputsOnIterate: true,
    permission: { bash: 'allow' },
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: `## body of ${name}`,
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as Agent
}

function localMcp(name: string, enabled = true): Mcp {
  return {
    id: 'mcp-' + name,
    name,
    description: '',
    type: 'local',
    config: { command: ['uvx', name + '-mcp'], env: { TOKEN: 't-' + name } },
    enabled,
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  } as Mcp
}

function mkPlugin(name: string, enabled = true): Plugin {
  return {
    id: 'p-' + name,
    name,
    spec: `${name}@1.0.0`,
    options: { key: 'v-' + name },
    description: '',
    enabled,
    sourceKind: 'npm',
    cachedPath: `/tmp/aw-plugins/${name}/node_modules/${name}`,
    resolvedVersion: '1.0.0',
    installedAt: 0,
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  } as Plugin
}

const PROFILES = new Map<string, RuntimeProfile>([
  [
    'root-agent',
    { model: 'opus', variant: 'v1', temperature: 0.3, steps: null, maxSteps: 40, isSandbox: true },
  ],
  [
    'helper-agent',
    { model: 'mini', variant: null, temperature: null, steps: 5, maxSteps: null, isSandbox: false },
  ],
  [
    'sys-persona',
    {
      model: 'opus',
      variant: null,
      temperature: null,
      steps: null,
      maxSteps: null,
      isSandbox: false,
    },
  ],
])

interface BizPair {
  legacy: BusinessNodeSpawnContext
  unified: AgentSpawnContext
}

function mkBusinessPair(runRoot: string, kind: 'opencode' | 'claude-code'): BizPair {
  const worktreePath = join(runRoot, 'worktree')
  mkdirSync(worktreePath, { recursive: true })
  const agent = mkAgent('root-agent')
  const dep = mkAgent('helper-agent')
  const mcps = [localMcp('search'), localMcp('disabled-mcp', false)]
  const plugins = [mkPlugin('tracer'), mkPlugin('disabled-plugin', false)]
  const configDir =
    kind === 'opencode'
      ? DEFAULT_CONFIG_DIR_PROFILE.opencode
      : DEFAULT_CONFIG_DIR_PROFILE['claude-code']
  const shared = {
    prompt: 'THE BUSINESS PROMPT',
    injectedMemoryBlock: '## Injected memory\n- fact A',
    resolvedParamsByAgent: PROFILES,
    runRoot,
    configDir,
    gitUserName: 'Ada',
    gitUserEmail: 'ada@x.io',
    wantsInventory: false,
    nodeRunId: 'nr-1',
    log,
  }
  const legacy: BusinessNodeSpawnContext = {
    ...shared,
    agent,
    dependents: [dep],
    mcps,
    plugins,
    skills: [],
    resumeSessionId: 'ses_42',
    worktreePath,
    taskMounts: [worktreePath],
    ...(kind === 'opencode'
      ? { opencodeCmd: ['/mock/opencode'] }
      : { runtimeCmd: ['/mock/claude'] }),
  }
  const unified: AgentSpawnContext = {
    ...shared,
    injection: { mcps, agent, dependents: [dep], plugins, skills: [] },
    agentName: agent.name,
    systemPrompt: agent.bodyMd,
    cwd: worktreePath,
    taskMounts: [worktreePath],
    resumeSessionId: 'ses_42',
    binaryOverride: kind === 'opencode' ? ['/mock/opencode'] : ['/mock/claude'],
  }
  return { legacy, unified }
}

function stripVolatile(plan: { cmd: string[]; env: Record<string, string> }): {
  cmd: string[]
  env: Record<string, string>
} {
  return { cmd: plan.cmd, env: plan.env }
}

describe('RFC-282 B1a — business-path parity (facade vs legacy, live while both exist)', () => {
  for (const kind of ['opencode', 'claude-code'] as const) {
    test(`${kind}: cmd/env/stdin byte-identical; declared equals legacy renderInjection`, async () => {
      const driver = getRuntimeDriver(kind)
      const assembleBusiness =
        kind === 'opencode' ? assembleOpencodeBusinessSpawn : assembleClaudeBusinessSpawn
      const renderInjection = kind === 'opencode' ? renderOpencodeInjection : renderClaudeInjection
      const root = mkdtempSync(join(tmpdir(), 'rfc282-b1a-'))
      try {
        const pair = mkBusinessPair(root, kind)
        const legacyPlan = await assembleBusiness(pair.legacy)
        const legacyDeclared = renderInjection({
          mcps: pair.legacy.mcps,
          agent: pair.legacy.agent,
          dependents: pair.legacy.dependents,
          plugins: pair.legacy.plugins,
          skills: pair.legacy.skills,
          profile: PROFILES.get('root-agent')!,
        }).declared
        const legacySnapshot = {
          shape: stripVolatile(legacyPlan),
          stdin: legacyPlan.stdin,
        }
        // claude's assembly projects worktree agents/skills on disk and
        // refuses to overwrite live projections — release the legacy run's
        // side effects before the facade assembles the same worktree.
        await legacyPlan.cleanup?.()
        const unifiedPlan = await driver.buildSpawn({
          ...pair.unified,
          injection: { ...pair.unified.injection, profile: PROFILES.get('root-agent')! },
        })
        expect(stripVolatile(unifiedPlan)).toEqual(legacySnapshot.shape)
        expect(unifiedPlan.stdin).toEqual(legacySnapshot.stdin)
        expect(unifiedPlan.declared).toEqual(legacyDeclared)
        await unifiedPlan.cleanup?.()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  }
})

describe('RFC-282 B1a — persona-only (system) parity', () => {
  test('opencode: facade equals legacy system buildSpawn byte-for-byte', async () => {
    const driver = getRuntimeDriver('opencode')
    const root = mkdtempSync(join(tmpdir(), 'rfc282-b1a-sys-'))
    try {
      const legacyCtx: SystemAgentSpawnContext = {
        agentName: 'sys-persona',
        systemPrompt: '## persona body',
        prompt: 'SYSTEM PROMPT',
        model: 'opus',
        worktreePath: join(root, 'scratch'),
        runDir: join(root, 'run'),
        opencodeCmd: ['/mock/opencode'],
        configDirName: DEFAULT_CONFIG_DIR_PROFILE.opencode.name,
        configDirEnv: DEFAULT_CONFIG_DIR_PROFILE.opencode.env,
        log,
      }
      mkdirSync(legacyCtx.worktreePath, { recursive: true })
      const legacyPlan = await assembleOpencodePersonaSpawn(legacyCtx)
      const unifiedPlan = await driver.buildSpawn({
        injection: { mcps: [] },
        prompt: 'SYSTEM PROMPT',
        agentName: 'sys-persona',
        systemPrompt: '## persona body',
        resolvedParamsByAgent: PROFILES,
        cwd: legacyCtx.worktreePath,
        runRoot: legacyCtx.runDir,
        configDir: DEFAULT_CONFIG_DIR_PROFILE.opencode,
        wantsInventory: false,
        binaryOverride: ['/mock/opencode'],
        nodeRunId: 'nr-sys',
        log,
      })
      expect(stripVolatile(unifiedPlan)).toEqual(stripVolatile(legacyPlan))
      expect(unifiedPlan.stdin).toEqual(legacyPlan.stdin)
      // persona-only: empty spec ⇒ empty manifest faces
      expect(unifiedPlan.declared.mcpServers).toEqual([])
      expect(unifiedPlan.declared.subagents).toEqual([])
      await legacyPlan.cleanup?.()
      await unifiedPlan.cleanup?.()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('claude: facade equals legacy; §7-1b — persona stays UNCONSTRAINED (no permission injected)', async () => {
    const driver = getRuntimeDriver('claude-code')
    const root = mkdtempSync(join(tmpdir(), 'rfc282-b1a-sysc-'))
    try {
      const scratch = join(root, 'scratch')
      mkdirSync(scratch, { recursive: true })
      const legacyCtx: SystemAgentSpawnContext = {
        agentName: 'sys-persona',
        systemPrompt: '## persona body',
        prompt: 'SYSTEM PROMPT',
        model: 'opus',
        worktreePath: scratch,
        runDir: join(root, 'run'),
        runtimeCmd: ['/mock/claude'],
        configDirName: DEFAULT_CONFIG_DIR_PROFILE['claude-code'].name,
        configDirEnv: DEFAULT_CONFIG_DIR_PROFILE['claude-code'].env,
        log,
      }
      const legacyPlan = await assembleClaudePersonaSpawn(legacyCtx)
      const unifiedPlan = await driver.buildSpawn({
        injection: { mcps: [] },
        prompt: 'SYSTEM PROMPT',
        agentName: 'sys-persona',
        systemPrompt: '## persona body',
        resolvedParamsByAgent: PROFILES,
        cwd: scratch,
        runRoot: legacyCtx.runDir,
        configDir: DEFAULT_CONFIG_DIR_PROFILE['claude-code'],
        wantsInventory: false,
        binaryOverride: ['/mock/claude'],
        nodeRunId: 'nr-sysc',
        log,
      })
      expect(stripVolatile(unifiedPlan)).toEqual(stripVolatile(legacyPlan))
      expect(unifiedPlan.stdin).toEqual(legacyPlan.stdin)
      // §7-1b positive lock — unconstrained persona: no tool gate declared,
      // no --tools flag on argv (claude without a permission = full surface).
      expect(unifiedPlan.declared.tools).toBeNull()
      expect(unifiedPlan.cmd.join(' ')).not.toContain('--tools')
      await legacyPlan.cleanup?.()
      await unifiedPlan.cleanup?.()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
