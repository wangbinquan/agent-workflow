// RFC-073 — locks the runner's global-permission injection that roots out the
// opencode subagent permission.asked / question.asked deadlock.
//
// Why this exists (see design/RFC-073-subagent-permission-question-deadlock/):
// a subagent (incl. allow:task nesting) that triggered a permission requiring
// `ask` (e.g. bash `cd <outside-worktree>` → external_directory) — or invoked
// opencode's `question` tool — would block forever: `opencode run`'s event loop
// only replies to the ROOT session's permission (cli/cmd/run.ts:708 skips child
// sessions) and has no question.asked handler, while the framework has no
// reverse channel in CLI mode. The fix injects a TOP-LEVEL permission
// `{"*":"allow","question":"deny"}` into OPENCODE_CONFIG_CONTENT so opencode
// folds it into config.permission → every agent + every nested subagent.
//
// These assertions lock:
//   - the injected shape ({*:allow, question:deny})
//   - the LOAD-BEARING key order (question AFTER * — Permission.disabled uses
//     findLast, so a reversed order would silently stop disabling question)
//   - the anti-revival guard (a user agent's own question:"allow" is stripped
//     before injection, on root AND dependents)
//   - orthogonality to the framework's own clarify reverse-ask, which travels
//     via the <workflow-clarify> envelope, NOT opencode's question tool

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Agent } from '@agent-workflow/shared'
import { buildInlineAgentEntry, buildInlineConfig } from '../src/services/runner'

function agent(name: string, permission: Record<string, unknown> = {}): Agent {
  return {
    id: 'agent-' + name,
    name,
    description: '',
    outputs: [],
    syncOutputsOnIterate: true,
    permission,
    skills: [],
    dependsOn: [],
    mcp: [],
    plugins: [],
    frontmatterExtra: {},
    bodyMd: '',
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe('RFC-073 buildInlineConfig global permission injection', () => {
  test('injects top-level permission = {"*":"allow","question":"deny"}', () => {
    const out = buildInlineConfig(agent('a'), new Map(), [], [])
    expect(out.permission).toEqual({ '*': 'allow', question: 'deny' })
  })

  test('permission is ALWAYS present (unlike the optional mcp/plugin keys)', () => {
    const out = buildInlineConfig(agent('a'), new Map(), [], [])
    expect('permission' in out).toBe(true)
  })

  test('LOAD-BEARING order: serialized "question" key comes AFTER "*"', () => {
    // Permission.disabled (opencode permission/index.ts) resolves a tool via
    // findLast; for `question` both {*,allow} and {question,deny} match, so the
    // last one must be deny. If a refactor reorders the object literal, this
    // breaks and question stops being disabled — re-introducing the deadlock.
    const out = buildInlineConfig(agent('a'), new Map(), [], [])
    const s = JSON.stringify(out.permission)
    expect(s.indexOf('"question"')).toBeGreaterThan(s.indexOf('"*"'))
  })

  test('anti-revival: a primary agent\'s own question:"allow" is stripped', () => {
    const entry = buildInlineAgentEntry(agent('a', { question: 'allow', bash: 'allow' }))
    const perm = entry.permission as Record<string, unknown>
    expect('question' in perm).toBe(false)
    // other keys survive verbatim
    expect(perm.bash).toBe('allow')
  })

  test('anti-revival: a dependent (subagent) entry also has question stripped', () => {
    const root = agent('root')
    const dep = agent('dep', { question: 'allow', edit: 'allow' })
    const out = buildInlineConfig(root, new Map(), [dep], [])
    const depPerm = out.agent['dep']!.permission as Record<string, unknown>
    expect('question' in depPerm).toBe(false)
    expect(depPerm.edit).toBe('allow')
  })

  test('agents without a question key are passed through untouched', () => {
    const entry = buildInlineAgentEntry(agent('a', { bash: 'allow' }))
    expect(entry.permission).toEqual({ bash: 'allow' })
  })

  test('source-code lock: AW_GLOBAL_PERMISSION declares * BEFORE question', () => {
    // Locks the WHY of the order test above at the definition site, so a reader
    // refactoring the inline-config assembly sees the constraint without running
    // the snapshot. RFC-143 PR-4: definition moved to runtime/opencode/
    // inlineConfig.ts (runner re-exports); the lock follows it.
    const src = readFileSync(
      resolve(import.meta.dir, '..', 'src', 'services', 'runtime', 'opencode', 'inlineConfig.ts'),
      'utf-8',
    )
    expect(src).toContain('AW_GLOBAL_PERMISSION')
    const starIdx = src.indexOf("'*': 'allow'")
    const questionIdx = src.indexOf("question: 'deny'")
    expect(starIdx).toBeGreaterThan(-1)
    expect(questionIdx).toBeGreaterThan(starIdx)
  })

  test('orthogonality lock: clarify reverse-ask is envelope-based, not the opencode question tool', () => {
    // Disabling opencode's `question` tool must NOT touch the framework's own
    // reverse-ask (clarify / clarify-cross-agent), which instructs the agent to
    // emit a <workflow-clarify> envelope (shared/clarify.ts) — a different
    // channel entirely. This guard fails if someone ever wires clarify onto the
    // opencode question tool.
    const src = readFileSync(
      resolve(import.meta.dir, '..', '..', 'shared', 'src', 'clarify.ts'),
      'utf-8',
    )
    expect(src).toContain('workflow-clarify')
    expect(src).toContain('parseClarifyEnvelopeBody')
  })
})
