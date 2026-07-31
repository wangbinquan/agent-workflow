// RFC-242 T1 — the frozen agent.permission → Claude tool-gate mapping.
//
// Both vocabularies are read from source, not remembered:
//  - opencode actions/keys: `packages/core/src/v1/config/permission.ts`
//    (ask|allow|deny; read/edit/glob/grep/list/bash/task/external_directory/
//    todowrite/question/webfetch/websearch/lsp/doom_loop/skill; Rule may be an
//    Action or Record<pattern, Action>; a bare action means `{'*': action}`).
//  - claude 2.1.220 built-ins: from a live `--tools default` init event.
//
// The table is a CONTRACT: every row is asserted, so widening it is a visible
// diff and never an accident.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeCodeDriver } from '../src/services/runtime/claudeCode/driver'
import {
  claudeToolsValue,
  mapAgentPermissionToClaudeTools,
} from '../src/services/runtime/claudeCode/permissionMap'

const gate = (permission: Record<string, unknown>) =>
  mapAgentPermissionToClaudeTools(permission as never)

describe('RFC-242 permission mapping — per-key contract', () => {
  test('each known key grants exactly its documented tools', () => {
    const rows: Array<[string, string[]]> = [
      ['read', ['Read']],
      ['glob', ['Glob']],
      ['grep', ['Grep']],
      // `edit` is the WRITE action class: leaving Write/NotebookEdit ungoverned
      // would let an `edit: deny` agent still create files.
      ['edit', ['Edit', 'Write', 'NotebookEdit']],
      ['bash', ['Bash']],
      ['task', ['Task']],
      ['webfetch', ['WebFetch']],
      ['websearch', ['WebSearch']],
      ['skill', ['Skill']],
    ]
    for (const [key, expected] of rows) {
      const result = gate({ [key]: 'allow' })
      expect([...result.tools].sort()).toEqual([...expected].sort() as never)
      expect(result.warnings).toEqual([])
    }
  })

  test('keys with no claude counterpart grant nothing but are NOT warnings', () => {
    for (const key of ['list', 'external_directory', 'todowrite', 'question', 'lsp', 'doom_loop']) {
      const result = gate({ [key]: 'allow' })
      expect(result.tools).toEqual([])
      expect(result.warnings).toEqual([])
    }
  })
})

describe('RFC-242 permission mapping — actions and baselines', () => {
  test('no wildcard ⇒ deny baseline (a claude node is granted, never assumed)', () => {
    expect(gate({}).tools).toEqual([])
  })

  test('wildcard allow grants the full grantable set; explicit deny then subtracts', () => {
    const all = gate({ '*': 'allow' })
    expect(all.tools).toContain('Bash')
    expect(all.tools).toContain('Read')
    const noBash = gate({ '*': 'allow', bash: 'deny' })
    expect(noBash.tools).not.toContain('Bash')
    expect(noBash.tools).toContain('Read')
    // …and an explicit allow re-adds on top of a deny baseline.
    expect(gate({ '*': 'deny', read: 'allow' }).tools).toEqual(['Read'])
  })

  test("'ask' is denied in headless mode and always warns (never silent)", () => {
    const single = gate({ bash: 'ask' })
    expect(single.tools).toEqual([])
    expect(single.warnings.join(' ')).toContain('headless')
    const wildcard = gate({ '*': 'ask' })
    expect(wildcard.tools).toEqual([])
    expect(wildcard.warnings.join(' ')).toContain('headless')
  })

  test('unknown keys fail closed WITH a warning (never widen)', () => {
    const result = gate({ '*': 'deny', not_a_real_key: 'allow' })
    expect(result.tools).toEqual([])
    expect(result.warnings.join(' ')).toContain('unknown key')
  })

  test('unrecognized values are denied with a warning', () => {
    const result = gate({ '*': 'allow', bash: 42 })
    expect(result.tools).not.toContain('Bash')
    expect(result.warnings.join(' ')).toContain('unrecognized value')
  })

  test('pattern rules collapse conservatively and disclose the lost granularity', () => {
    // opencode: bash: {'git *': 'allow', '*': 'deny'} — Claude's load set has
    // no per-pattern axis, so the tool loads as a whole and we say so.
    const someAllow = gate({ bash: { 'git *': 'allow', '*': 'deny' } })
    expect(someAllow.tools).toEqual(['Bash'])
    expect(someAllow.warnings.join(' ')).toContain('per-pattern')
    const noneAllow = gate({ '*': 'allow', bash: { 'rm *': 'deny' } })
    expect(noneAllow.tools).not.toContain('Bash')
    expect(noneAllow.warnings.join(' ')).toContain('per-pattern')
  })

  test('argv value is deterministic table order; empty set ⇒ empty string', () => {
    expect(claudeToolsValue(gate({ bash: 'allow', read: 'allow' }))).toBe('Read,Bash')
    expect(claudeToolsValue(gate({}))).toBe('')
  })
})

// RFC-242 §2 end-to-end: the mapping actually reaches the business argv, and
// the user's "existing agents must not break" decision is enforced.
describe('RFC-242 §2 — business spawn honors the gate; undeclared stays unconstrained', () => {
  const businessCtx = (permission: Record<string, unknown>) =>
    ({
      agent: { name: 'a', bodyMd: 'persona', permission } as never,
      prompt: 'p',
      injectedMemoryBlock: null,
      dependents: [],
      mcps: [],
      plugins: [],
      resolvedParamsByAgent: new Map(),
      skills: [],
      worktreePath: '/wt',
      runRoot: mkdtempSync(join(tmpdir(), 'rfc242-biz-')),
      configDir: { env: 'CLAUDE_CONFIG_DIR', name: '.claude' },
      wantsInventory: false,
      nodeRunId: 'nr1',
      runtimeCmd: ['bun', 'run', 'mock'],
      log: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
    }) as never

  test('a declared permission produces the mapped load set (no bypass)', async () => {
    const plan = await claudeCodeDriver.buildBusinessSpawn(
      businessCtx({ read: 'allow', grep: 'allow', bash: 'deny' }),
    )
    expect(plan.cmd).not.toContain('bypassPermissions')
    const toolsAt = plan.cmd.indexOf('--tools')
    expect(plan.cmd[toolsAt + 1]).toBe('Read,Grep')
    expect(plan.cmd).toContain('dontAsk')
  })

  test('an UNDECLARED permission keeps the historical unconstrained shape', async () => {
    const plan = await claudeCodeDriver.buildBusinessSpawn(businessCtx({}))
    expect(plan.cmd).toContain('bypassPermissions')
    expect(plan.cmd).not.toContain('--tools')
  })

  test('a fully-denied agent loads no built-ins at all', async () => {
    const plan = await claudeCodeDriver.buildBusinessSpawn(businessCtx({ '*': 'deny' }))
    const toolsAt = plan.cmd.indexOf('--tools')
    expect(toolsAt).toBeGreaterThan(-1)
    expect(plan.cmd[toolsAt + 1]).toBe('')
  })
})
