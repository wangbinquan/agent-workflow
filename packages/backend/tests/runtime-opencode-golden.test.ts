// RFC-111 PR-A(A2) — GOLDEN lock on the opencode spawn surface. buildOpencodeSpawn
// is the byte-for-byte argv + env the runner used to build inline; if any token
// or env key drifts here, the opencode runtime's launch contract changed under
// the abstraction (the claude driver, PR-B, deliberately produces a DIFFERENT
// cmd/env from the same raw materials — this test pins opencode's).

import { describe, expect, it } from 'bun:test'
import { buildOpencodeSpawn } from '@/services/runtime/opencode/spawn'

const isWindows = process.platform === 'win32'

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
    // Windows: prompt is piped via stdin (Bun truncates argv at '\n'), absent from cmd.
    expect(cmd).toEqual(
      isWindows
        ? ['opencode', 'run', '--agent', 'my-agent', '--format', 'json', '--thinking', '--dangerously-skip-permissions']
        : ['opencode', 'run', 'THE PROMPT', '--agent', 'my-agent', '--format', 'json', '--thinking', '--dangerously-skip-permissions'],
    )
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
    expect(cmd).toEqual(
      isWindows
        ? ['bun', 'run', '/mock.ts', 'run', '--agent', 'my-agent', '--format', 'json', '--thinking', '--dangerously-skip-permissions', '--session', 'opc_9']
        : ['bun', 'run', '/mock.ts', 'run', 'THE PROMPT', '--agent', 'my-agent', '--format', 'json', '--thinking', '--dangerously-skip-permissions', '--session', 'opc_9'],
    )
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
