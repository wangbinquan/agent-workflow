// RFC-111 PR-A(A2) — GOLDEN lock on the opencode spawn surface. buildOpencodeSpawn
// is the byte-for-byte argv + env the runner used to build inline; if any token
// or env key drifts here, the opencode runtime's launch contract changed under
// the abstraction (the claude driver, PR-B, deliberately produces a DIFFERENT
// cmd/env from the same raw materials — this test pins opencode's).

import { describe, expect, it } from 'bun:test'
import {
  buildCommand,
  buildOpencodeSpawn,
  MAX_OPENCODE_PROMPT_BYTES,
} from '@/services/runtime/opencode/spawn'

const BASE = {
  agentName: 'my-agent',
  prompt: 'THE PROMPT',
  worktreePath: '/wt',
  runDir: '/runs/t/n/.opencode',
  inlineConfigSerialized: '{"agent":{"my-agent":{}}}',
} as const

describe('buildOpencodeSpawn — argv golden (RFC-111 A2)', () => {
  it('default argv: run/prompt/--agent/--format json/--thinking/--dangerously-skip-permissions', () => {
    const { cmd } = buildOpencodeSpawn({ ...BASE })
    expect(cmd).toEqual([
      'opencode',
      'run',
      'THE PROMPT',
      '--agent',
      'my-agent',
      '--format',
      'json',
      '--thinking',
      '--dangerously-skip-permissions',
    ])
  })

  it('honors opencodeCmd head + --session; --dangerously-skip-permissions is UNCONDITIONAL', () => {
    // flag-audit W0（§3 假旋钮）：`dangerouslySkipPermissions?: boolean` 参数已删——
    // 生产端从未有人传值，且 CLI 模式没有 permission 应答通道，非跳过运行会在第一个
    // tool 提示上挂死（假旋钮）。flag 现在无条件出现。
    const { cmd } = buildOpencodeSpawn({
      ...BASE,
      opencodeCmd: ['bun', 'run', '/mock.ts'],
      resumeSessionId: 'opc_9',
    })
    expect(cmd).toEqual([
      'bun',
      'run',
      '/mock.ts',
      'run',
      'THE PROMPT',
      '--agent',
      'my-agent',
      '--format',
      'json',
      '--thinking',
      '--dangerously-skip-permissions',
      '--session',
      'opc_9',
    ])
  })

  it('empty resumeSessionId is treated as absent (no --session)', () => {
    const { cmd } = buildOpencodeSpawn({ ...BASE, resumeSessionId: '' })
    expect(cmd).not.toContain('--session')
  })
})

describe('buildOpencodeSpawn — env golden (RFC-111 A2)', () => {
  it('sets PWD / OPENCODE_CONFIG_DIR / OPENCODE_CONFIG_CONTENT; no inventory/git by default', () => {
    const { env } = buildOpencodeSpawn({ ...BASE })
    expect(env.PWD).toBe('/wt')
    expect(env.OPENCODE_CONFIG_DIR).toBe('/runs/t/n/.opencode')
    expect(env.OPENCODE_CONFIG_CONTENT).toBe('{"agent":{"my-agent":{}}}')
    expect(env.OPENCODE_AW_INVENTORY_OUT).toBeUndefined()
    expect(env.GIT_AUTHOR_NAME).toBeUndefined()
    // inherits the daemon env baseline
    expect('PATH' in env).toBe(true)
  })

  it('sets OPENCODE_AW_INVENTORY_OUT only when provided', () => {
    const { env } = buildOpencodeSpawn({ ...BASE, inventoryOutPath: '/runs/t/n/inventory.json' })
    expect(env.OPENCODE_AW_INVENTORY_OUT).toBe('/runs/t/n/inventory.json')
  })

  it('injects all four GIT_* only when BOTH name and email are non-empty (RFC-067)', () => {
    const both = buildOpencodeSpawn({ ...BASE, gitUserName: 'Ada', gitUserEmail: 'ada@x.io' }).env
    expect(both.GIT_AUTHOR_NAME).toBe('Ada')
    expect(both.GIT_AUTHOR_EMAIL).toBe('ada@x.io')
    expect(both.GIT_COMMITTER_NAME).toBe('Ada')
    expect(both.GIT_COMMITTER_EMAIL).toBe('ada@x.io')

    // half-set → none (defensive XOR guard)
    const half = buildOpencodeSpawn({ ...BASE, gitUserName: 'Ada', gitUserEmail: '' }).env
    expect(half.GIT_AUTHOR_NAME).toBeUndefined()
    const nullEmail = buildOpencodeSpawn({ ...BASE, gitUserName: 'Ada', gitUserEmail: null }).env
    expect(nullEmail.GIT_AUTHOR_NAME).toBeUndefined()
  })
})

// design/test-guard-audit-2026-07-21 gap B4-runtime-5 (Top-14) — a prompt that
// overflows Linux's 128 KiB per-argv-element limit must fail READABLY at spawn
// assembly (the runner turns a buildCommand throw into the node's errorMessage),
// not with a raw E2BIG kernel error once execve is attempted.
describe('opencode prompt argv size guard (B4-runtime-5)', () => {
  const OPTS = { agent: { name: 'a' } } as const

  it('accepts a prompt right at the limit', () => {
    const prompt = 'x'.repeat(MAX_OPENCODE_PROMPT_BYTES)
    expect(() => buildCommand(OPTS, prompt)).not.toThrow()
  })

  it('rejects a prompt one byte over the limit with an actionable message', () => {
    const prompt = 'x'.repeat(MAX_OPENCODE_PROMPT_BYTES + 1)
    expect(() => buildCommand(OPTS, prompt)).toThrow(/prompt-too-large/)
  })

  it('measures BYTES not code units — a CJK prompt overflows below the .length limit', () => {
    // '字' is 3 UTF-8 bytes. A string of MAX/3 + 1 chars is under the char count
    // but over the byte limit, and must still be refused.
    const chars = Math.floor(MAX_OPENCODE_PROMPT_BYTES / 3) + 1
    const prompt = '字'.repeat(chars)
    expect(prompt.length).toBeLessThan(MAX_OPENCODE_PROMPT_BYTES)
    expect(Buffer.byteLength(prompt, 'utf8')).toBeGreaterThan(MAX_OPENCODE_PROMPT_BYTES)
    expect(() => buildCommand(OPTS, prompt)).toThrow(/prompt-too-large/)
  })

  it('the limit leaves headroom under the 128 KiB kernel cap', () => {
    // argv also carries the other flags and shares ARG_MAX with the ~128 KiB
    // env block; the guard must sit strictly below 128 KiB.
    expect(MAX_OPENCODE_PROMPT_BYTES).toBeLessThan(128 * 1024)
  })
})
