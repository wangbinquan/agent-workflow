import { afterEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG_DIR_PROFILE, type Agent } from '@agent-workflow/shared'
import { renderClaudeManagedSkillAttachments } from '../src/services/runtime/claudeCode/config'
import { claudeCodeDriver } from '../src/services/runtime/claudeCode/driver'
import type { BusinessNodeSpawnContext } from '../src/services/runtime/types'
import type { RuntimeProfile } from '../src/services/runtimeRegistry'
import { createLogger } from '../src/util/log'

const roots: string[] = []
const log = createLogger('claude-skill-attachment-test')

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'claude-natural-skill-'))
  roots.push(root)
  return root
}

function agent(): Agent {
  return {
    id: 'agent-1',
    name: 'claude-agent',
    description: 'desc',
    outputs: ['result'],
    syncOutputsOnIterate: true,
    permission: { read: 'allow', skill: 'allow' },
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: 'BASE PERSONA',
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

function dependentAgent(name: string, bodyMd: string): Agent {
  return {
    ...agent(),
    id: `agent-${name}`,
    name,
    description: `Use the independent ${name} agent`,
    permission: { read: 'allow' },
    bodyMd,
  }
}

function profile(): RuntimeProfile {
  return {
    model: null,
    variant: null,
    temperature: null,
    steps: null,
    maxSteps: null,
    isSandbox: false,
  }
}

function makeSkill(root: string): string {
  const source = join(root, 'source-skill')
  mkdirSync(join(source, 'references'), { recursive: true })
  mkdirSync(join(source, '.claude-plugin'), { recursive: true })
  writeFileSync(join(source, 'SKILL.md'), '# PDF skill\nRead the sibling reference.')
  writeFileSync(join(source, 'references', 'format.md'), 'sibling content')
  writeFileSync(join(source, '.claude-plugin', 'plugin.json'), '{}')
  return source
}

describe('Claude natural managed-skill attachment', () => {
  test('copies the whole selected tree, exposes sibling paths, and excludes plugin metadata', () => {
    const root = tempRoot()
    const source = makeSkill(root)
    const rendered = renderClaudeManagedSkillAttachments(
      join(root, 'run'),
      [{ name: 'pdf-tools', sourceKind: 'managed', sourcePath: source }],
      log,
    )
    expect(rendered).toContain('### pdf-tools')
    expect(rendered).toContain('# PDF skill')
    expect(rendered).toContain('- references/format.md')
    expect(rendered).not.toContain('.claude-plugin')
    const copiedRoot = join(root, 'run', 'claude-managed-skill-attachments', 'skills', 'pdf-tools')
    expect(readFileSync(join(copiedRoot, 'references', 'format.md'), 'utf8')).toBe(
      'sibling content',
    )
  })

  test('driver appends selected skills and projects them without relocating Claude auth config', async () => {
    const root = tempRoot()
    const runRoot = join(root, 'run')
    const worktreePath = join(root, 'worktree')
    mkdirSync(worktreePath, { recursive: true })
    const source = makeSkill(root)
    const ctx: BusinessNodeSpawnContext = {
      agent: agent(),
      prompt: 'PROMPT',
      injectedMemoryBlock: null,
      dependents: [],
      mcps: [],
      plugins: [],
      resolvedParamsByAgent: new Map([['claude-agent', profile()]]),
      skills: [{ name: 'pdf-tools', sourceKind: 'managed', sourcePath: source }],
      worktreePath,
      taskMounts: [worktreePath],
      runRoot,
      configDir: DEFAULT_CONFIG_DIR_PROFILE['claude-code'],
      runtimeCmd: ['claude-mock'],
      wantsInventory: false,
      nodeRunId: 'nr-1',
      log,
    }
    const plan = await claudeCodeDriver.buildBusinessSpawn(ctx)
    expect(plan.env.CLAUDE_CONFIG_DIR).toBeUndefined()
    expect(plan.env.IS_SANDBOX).toBeUndefined()
    expect(plan.cmd).not.toContain('--setting-sources')
    expect(plan.cmd).not.toContain('--disable-slash-commands')
    expect(plan.cmd).not.toContain('--strict-mcp-config')
    const promptPath = plan.cmd[plan.cmd.indexOf('--append-system-prompt-file') + 1]!
    const prompt = readFileSync(promptPath, 'utf8')
    expect(prompt).toContain('BASE PERSONA')
    expect(prompt).toContain('pdf-tools')
    expect(prompt).toContain('references/format.md')
    const projectSkillRoot = join(worktreePath, '.claude', 'skills', 'pdf-tools')
    expect(readFileSync(join(projectSkillRoot, 'references', 'format.md'), 'utf8')).toBe(
      'sibling content',
    )
    expect(existsSync(join(projectSkillRoot, '.claude-plugin'))).toBe(false)

    await plan.cleanup?.()
    expect(existsSync(projectSkillRoot)).toBe(false)
    expect(existsSync(join(worktreePath, '.claude'))).toBe(false)
    // The runner owns runRoot cleanup separately; the fallback attachment stays
    // available until the process has fully exited.
    expect(
      existsSync(join(runRoot, 'claude-managed-skill-attachments', 'skills', 'pdf-tools')),
    ).toBe(true)
  })

  test('projects multiple dependents as separate agent files without merging their prompts', async () => {
    const root = tempRoot()
    const runRoot = join(root, 'run')
    const worktreePath = join(root, 'worktree')
    mkdirSync(worktreePath, { recursive: true })
    const ctx: BusinessNodeSpawnContext = {
      agent: agent(),
      prompt: 'PROMPT',
      injectedMemoryBlock: null,
      dependents: [
        dependentAgent('auditor', 'AUDITOR PERSONA ONLY'),
        dependentAgent('fixer', 'FIXER PERSONA ONLY'),
      ],
      mcps: [],
      plugins: [],
      resolvedParamsByAgent: new Map([['claude-agent', profile()]]),
      skills: [],
      worktreePath,
      taskMounts: [worktreePath],
      runRoot,
      configDir: DEFAULT_CONFIG_DIR_PROFILE['claude-code'],
      runtimeCmd: ['claude-mock'],
      wantsInventory: false,
      nodeRunId: 'nr-multi-agent',
      log,
    }

    const plan = await claudeCodeDriver.buildBusinessSpawn(ctx)
    const agentsJson = JSON.parse(plan.cmd[plan.cmd.indexOf('--agents') + 1] ?? '{}') as Record<
      string,
      { prompt?: string }
    >
    expect(Object.keys(agentsJson)).toEqual(['auditor', 'fixer'])
    expect(agentsJson.auditor?.prompt).toBe('AUDITOR PERSONA ONLY')
    expect(agentsJson.fixer?.prompt).toBe('FIXER PERSONA ONLY')
    const rootPromptPath = plan.cmd[plan.cmd.indexOf('--append-system-prompt-file') + 1]!
    const rootPrompt = readFileSync(rootPromptPath, 'utf8')
    expect(rootPrompt).toContain('BASE PERSONA')
    expect(rootPrompt).not.toContain('AUDITOR PERSONA ONLY')
    expect(rootPrompt).not.toContain('FIXER PERSONA ONLY')

    const auditorPath = join(worktreePath, '.claude', 'agents', 'auditor.md')
    const fixerPath = join(worktreePath, '.claude', 'agents', 'fixer.md')
    const auditor = readFileSync(auditorPath, 'utf8')
    const fixer = readFileSync(fixerPath, 'utf8')
    expect(auditor).toContain('name: auditor')
    expect(auditor).toContain('AUDITOR PERSONA ONLY')
    expect(auditor).not.toContain('FIXER PERSONA ONLY')
    expect(fixer).toContain('name: fixer')
    expect(fixer).toContain('FIXER PERSONA ONLY')
    expect(fixer).not.toContain('AUDITOR PERSONA ONLY')

    await plan.cleanup?.()
    expect(existsSync(auditorPath)).toBe(false)
    expect(existsSync(fixerPath)).toBe(false)
    expect(existsSync(join(worktreePath, '.claude'))).toBe(false)
  })

  test('preserves an existing same-name project agent instead of overwriting it', async () => {
    const root = tempRoot()
    const runRoot = join(root, 'run')
    const worktreePath = join(root, 'worktree')
    const existingAgent = join(worktreePath, '.claude', 'agents', 'auditor.md')
    mkdirSync(join(worktreePath, '.claude', 'agents'), { recursive: true })
    writeFileSync(existingAgent, 'project-owned agent')
    const ctx: BusinessNodeSpawnContext = {
      agent: agent(),
      prompt: 'PROMPT',
      injectedMemoryBlock: null,
      dependents: [dependentAgent('auditor', 'INJECTED AUDITOR')],
      mcps: [],
      plugins: [],
      resolvedParamsByAgent: new Map([['claude-agent', profile()]]),
      skills: [],
      worktreePath,
      taskMounts: [worktreePath],
      runRoot,
      configDir: DEFAULT_CONFIG_DIR_PROFILE['claude-code'],
      runtimeCmd: ['claude-mock'],
      wantsInventory: false,
      nodeRunId: 'nr-agent-conflict',
      log,
    }

    await expect(claudeCodeDriver.buildBusinessSpawn(ctx)).rejects.toThrow(
      'claude-worktree-agent-conflict',
    )
    expect(readFileSync(existingAgent, 'utf8')).toBe('project-owned agent')
  })

  test('preserves existing project config and fails instead of overwriting a same-name skill', async () => {
    const root = tempRoot()
    const runRoot = join(root, 'run')
    const worktreePath = join(root, 'worktree')
    const existingSkill = join(worktreePath, '.claude', 'skills', 'pdf-tools')
    mkdirSync(existingSkill, { recursive: true })
    writeFileSync(join(existingSkill, 'SKILL.md'), 'project-owned')
    const source = makeSkill(root)
    const ctx: BusinessNodeSpawnContext = {
      agent: agent(),
      prompt: 'PROMPT',
      injectedMemoryBlock: null,
      dependents: [],
      mcps: [],
      plugins: [],
      resolvedParamsByAgent: new Map([['claude-agent', profile()]]),
      skills: [{ name: 'pdf-tools', sourceKind: 'managed', sourcePath: source }],
      worktreePath,
      taskMounts: [worktreePath],
      runRoot,
      configDir: DEFAULT_CONFIG_DIR_PROFILE['claude-code'],
      runtimeCmd: ['claude-mock'],
      wantsInventory: false,
      nodeRunId: 'nr-conflict',
      log,
    }
    await expect(claudeCodeDriver.buildBusinessSpawn(ctx)).rejects.toThrow(
      'claude-worktree-skill-conflict',
    )
    expect(readFileSync(join(existingSkill, 'SKILL.md'), 'utf8')).toBe('project-owned')
  })

  test.skipIf(process.platform === 'win32')(
    'rejects a project config symlink instead of writing outside the worktree',
    async () => {
      const root = tempRoot()
      const runRoot = join(root, 'run')
      const worktreePath = join(root, 'worktree')
      const outside = join(root, 'outside-config')
      mkdirSync(worktreePath, { recursive: true })
      mkdirSync(outside, { recursive: true })
      symlinkSync(outside, join(worktreePath, '.claude'))
      const source = makeSkill(root)
      const ctx: BusinessNodeSpawnContext = {
        agent: agent(),
        prompt: 'PROMPT',
        injectedMemoryBlock: null,
        dependents: [],
        mcps: [],
        plugins: [],
        resolvedParamsByAgent: new Map([['claude-agent', profile()]]),
        skills: [{ name: 'pdf-tools', sourceKind: 'managed', sourcePath: source }],
        worktreePath,
        taskMounts: [worktreePath],
        runRoot,
        configDir: DEFAULT_CONFIG_DIR_PROFILE['claude-code'],
        runtimeCmd: ['claude-mock'],
        wantsInventory: false,
        nodeRunId: 'nr-symlink',
        log,
      }
      await expect(claudeCodeDriver.buildBusinessSpawn(ctx)).rejects.toThrow()
      expect(existsSync(join(outside, 'skills'))).toBe(false)
    },
  )
})
