// Regression lock — scheduler hydrates `agent.outputKinds` on the agent-load
// path that feeds runNode (services/runner.ts).
//
// Bug recap (task 01KS045BYZ9H52K3H2D10DBV6D, agent `doc`):
//   - DB row had `frontmatter_extra = {"outputKinds":{"docpath":"markdown_file"}}`.
//   - scheduler.ts carried its OWN `loadAgent` that mirrored agent.ts/rowToAgent
//     but missed the lift of `outputKinds` from frontmatter_extra to top-level.
//   - runner.ts gates `agentOutputKinds` on `opts.agent.outputKinds !== undefined`
//     — so the file-first markdown_file guidance (prompt.ts
//     `buildMarkdownFilePortGuidance`) was silently skipped, and the emitted
//     `node_runs.prompt_text` ended with bare `- docpath` instead of
//     `- docpath (markdown_file — write the file first, ...)` + the two-step
//     block.
//
// Locks:
//   1. Behavior — createAgent({ outputKinds }) round-trips through getAgentById so
//      Agent.outputKinds is at the top level (what runner.ts checks). This is
//      the same shape every consumer in the codebase expects (review, frontend
//      AgentForm, scheduler).
//   2. Source-text — scheduler.ts is wired to the canonical `getAgentById`
//      loader and does not reintroduce a local agent-loading function. A
//      future duplicate would either re-skip outputKinds (re-causing this
//      bug) or drift on the rest of the row→Agent contract.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { createInMemoryDb } from '../src/db/client'
import { createAgent, getAgentById } from '../src/services/agent'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SCHEDULER_SRC = resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts')

describe('scheduler agent-load hydrates outputKinds (regression for task 01KS045BYZ9H52K3H2D10DBV6D)', () => {
  test('createAgent({ outputKinds }) → getAgentById surfaces outputKinds at top level', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const created = await createAgent(db, {
      name: 'doc',
      description: '',
      outputs: ['docpath'],
      syncOutputsOnIterate: true,
      permission: {},
      skills: [],
      dependsOn: [],
      mcp: [],
      plugins: [],
      frontmatterExtra: {},
      outputKinds: { docpath: 'markdown_file' },
      bodyMd: '',
    })

    const loaded = await getAgentById(db, created.id)
    expect(loaded).not.toBeNull()
    expect(loaded?.outputKinds).toEqual({ docpath: 'markdown_file' })
    // outputKinds must NOT also leak back into frontmatterExtra — the runner /
    // editor read it from the lifted top-level only.
    expect((loaded?.frontmatterExtra as Record<string, unknown>).outputKinds).toBeUndefined()
  })

  // ── RFC-271 T6d 显式改判（2026-08-08）────────────────────────────────────
  // 本用例原本锚定 scheduler.ts 里对 getAgentById 的直接 import 与调用。RFC-271
  // 决策 29 把三处 agentId 裸读收口到 `services/ref/runtimeRef.ts`，那两处锚点
  // 搬到了新读取点。
  //
  // **守卫的意图不变**：仍然只有一个 canonical loader，没有 scheduler 私有的
  // agent 加载器（私有加载器要么绕过 outputKinds——就是本文件最初记录的那个
  // bug——要么在 row→Agent 契约的其余部分漂移）。锚点跟着读取点走。
  test('the canonical getAgentById loader is the only agent loader', () => {
    const src = readFileSync(SCHEDULER_SRC, 'utf8')
    const runtimeRef = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'ref', 'runtimeRef.ts'),
      'utf8',
    )

    // ① 唯一读取点用的是同一个 canonical module 的 getAgentById。
    expect(runtimeRef).toMatch(/import \{[^}]*\bgetAgentById\b[^}]*\} from '@\/services\/agent'/)
    expect(runtimeRef).toContain('await getAgentById(db,')

    // ② scheduler 不再自己查 agent 行（收口后比原来更严）。
    expect(src).not.toMatch(/await getAgentById\(db, (aid|agentIdRef)\b/)

    // ③ 两个文件都不许有本地 re-declaration —— 原意图逐条保留。
    for (const text of [src, runtimeRef]) {
      expect(text).not.toMatch(/async function loadAgent\s*\(/)
      expect(text).not.toMatch(/JSON\.parse\(row\.frontmatterExtra\)/)
    }
  })
})
