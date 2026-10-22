// RFC-111 PR-A(A2) — GOLDEN lock on the opencode spawn surface. buildOpencodeSpawn
// is the byte-for-byte argv + env the runner used to build inline; if any token
// or env key drifts here, the opencode runtime's launch contract changed under
// the abstraction (the claude driver, PR-B, deliberately produces a DIFFERENT
// cmd/env from the same raw materials — this test pins opencode's).

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  // The prompt is a TRAILING positional after a `--` end-of-options separator —
  // NOT a bare positional after `run`. opencode's parser is `.strict()`, so a
  // prompt starting with `-` (e.g. the RFC-200 `---` injection boundary) would be
  // scanned as an unknown option → usage dump + exit 1. See spawn.ts buildCommand.
  it('default argv: run/--agent/--format json/--thinking/--auto/-- <prompt>', () => {
    const { cmd } = buildOpencodeSpawn({ ...BASE })
    expect(cmd).toEqual([
      'opencode',
      'run',
      '--agent',
      'my-agent',
      '--format',
      'json',
      '--thinking',
      '--auto',
      '--',
      'THE PROMPT',
    ])
  })

  it('honors opencodeCmd head + --session; --auto is unconditional for an unprobed current CLI', () => {
    // flag-audit W0（§3 假旋钮）：`dangerouslySkipPermissions?: boolean` 参数已删——
    // 生产端从未有人传值，且 CLI 模式没有 permission 应答通道，非跳过运行会在第一个
    // tool 提示上挂死（假旋钮）。flag 现在无条件出现。
    // `--session <id>` precedes the `--`/prompt tail (a flag, must stay in the
    // parsed region), so the prompt remains the very last token.
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
      '--agent',
      'my-agent',
      '--format',
      'json',
      '--thinking',
      '--auto',
      '--session',
      'opc_9',
      '--',
      'THE PROMPT',
    ])
  })

  it('binaryVersion ≥1.18 spells the auto-approve flag --auto (2026-07-21 incident lock)', () => {
    // opencode 1.18.0 REMOVED --dangerously-skip-permissions (renamed --auto,
    // identical describe). On 1.18.3 the legacy spelling is an unknown argument:
    // the strict parser's .fail() swallows the error line and prints the bare
    // `run` usage before exit 1 — every spawn on the machine died that way.
    // The two goldens above pass NO binaryVersion and therefore use the current
    // spelling. A positively identified older binary still receives the legacy
    // spelling for compatibility.
    const { cmd } = buildOpencodeSpawn({ ...BASE, binaryVersion: '1.18.3' })
    expect(cmd).toEqual([
      'opencode',
      'run',
      '--agent',
      'my-agent',
      '--format',
      'json',
      '--thinking',
      '--auto',
      '--',
      'THE PROMPT',
    ])
    // Below the rename boundary the legacy spelling is preserved.
    const legacy = buildOpencodeSpawn({ ...BASE, binaryVersion: '1.17.8' })
    expect(legacy.cmd).toContain('--dangerously-skip-permissions')
    expect(legacy.cmd).not.toContain('--auto')
  })

  it('empty resumeSessionId is treated as absent (no --session)', () => {
    const { cmd } = buildOpencodeSpawn({ ...BASE, resumeSessionId: '' })
    expect(cmd).not.toContain('--session')
  })

  it('prompt is the last token, right after the `--` separator (dash-leading safe)', () => {
    // Regression lock for the workgroup outage: the RFC-200 wrapper makes every
    // untrusted-input prompt start with `---`. buildCommand MUST keep it behind
    // `--` so opencode's strict parser never treats it as a flag.
    const dashLeading = '---\n**Untrusted input boundary.** blah'
    const { cmd } = buildOpencodeSpawn({ ...BASE, prompt: dashLeading })
    const sep = cmd.lastIndexOf('--')
    expect(sep).toBeGreaterThan(-1)
    expect(cmd.slice(sep + 1)).toEqual([dashLeading])
    expect(cmd[cmd.length - 1]).toBe(dashLeading)
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

  it('scrubs inherited OPENCODE_PERMISSION before spawning the child (RFC-223 PR-6)', () => {
    const previous = process.env.OPENCODE_PERMISSION
    process.env.OPENCODE_PERMISSION = '{"edit":"allow"}'
    try {
      const { env } = buildOpencodeSpawn({ ...BASE })
      expect(env.OPENCODE_PERMISSION).toBeUndefined()
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_PERMISSION
      else process.env.OPENCODE_PERMISSION = previous
    }
  })

  it('fails closed on a legacy runtime that used OPENCODE_PERMISSION as its config-dir key', () => {
    expect(() => buildOpencodeSpawn({ ...BASE, configDirEnv: 'OPENCODE_PERMISSION' })).toThrow(
      'runtime-config-dir-env-reserved',
    )
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

// RFC-396 real review failed before spawn with a 322 KB frozen basis. Preserve
// the argv-only guard, but the production spawn plan must transport all bytes.
describe('RFC-396 large OpenCode prompt transport', () => {
  it('keeps the exact boundary positional and pipes one byte more without losing resume flags', () => {
    expect(
      buildOpencodeSpawn({ ...BASE, prompt: 'x'.repeat(MAX_OPENCODE_PROMPT_BYTES) }, 'linux').stdin,
    ).toBeUndefined()
    const prompt = 'x'.repeat(MAX_OPENCODE_PROMPT_BYTES + 1)
    const plan = buildOpencodeSpawn({ ...BASE, prompt, resumeSessionId: 'same-session' })
    expect(plan.stdin).toEqual({ mode: 'pipe', data: prompt })
    expect(plan.cmd.slice(-2)).toEqual(['--session', 'same-session'])
    expect(plan.cmd).not.toContain(prompt)
  })

  // Windows CI 39763563985 / 39767238898: all graph review journeys failed
  // before the native review with ENAMETOOLONG, below Linux's byte limit.
  it('pipes a medium Windows review while retaining small argv and POSIX compatibility', () => {
    const prompt = 'frozen review "basis" \\ path\n'.repeat(2000)
    expect(Buffer.byteLength(prompt)).toBeLessThan(MAX_OPENCODE_PROMPT_BYTES)
    const win = buildOpencodeSpawn({ ...BASE, prompt, resumeSessionId: 'review-session' }, 'win32')
    expect(win.stdin).toEqual({ mode: 'pipe', data: prompt })
    expect(win.cmd.slice(-2)).toEqual(['--session', 'review-session'])
    expect(win.cmd).not.toContain(prompt)
    expect(buildOpencodeSpawn({ ...BASE }, 'win32').cmd.slice(-2)).toEqual(['--', BASE.prompt])
    for (const platform of ['linux', 'darwin'] as const) {
      const posix = buildOpencodeSpawn({ ...BASE, prompt }, platform)
      expect(posix.stdin).toBeUndefined()
      expect(posix.cmd.slice(-2)).toEqual(['--', prompt])
    }
  })

  it('includes runtime head, agent, resume flags and UTF-16 units in the Windows budget', () => {
    const prompt = 'x'.repeat(14_000)
    expect(buildOpencodeSpawn({ ...BASE, prompt }, 'win32').stdin).toBeUndefined()
    const longHead = ['C:\\' + 'runtime\\'.repeat(160) + 'opencode.exe']
    expect(buildOpencodeSpawn({ ...BASE, prompt, opencodeCmd: longHead }, 'win32').stdin).toEqual({
      mode: 'pipe',
      data: prompt,
    })
    expect(
      buildOpencodeSpawn({ ...BASE, prompt, resumeSessionId: 's'.repeat(1200) }, 'win32').stdin,
    ).toEqual({ mode: 'pipe', data: prompt })
    expect(buildOpencodeSpawn({ ...BASE, prompt: '🙂'.repeat(8000) }, 'win32').stdin?.data).toBe(
      '🙂'.repeat(8000),
    )
  })

  it('sends a sub-Linux-limit Windows review intact to an actual child process', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc396-win-review-'))
    try {
      const receiver = join(root, 'receiver.ts')
      writeFileSync(
        receiver,
        'const s=await Bun.stdin.text();console.log(JSON.stringify({s,args:Bun.argv.slice(2)}))',
      )
      const prompt = '"frozen\\basis"\n'.repeat(3000) + 'END_OF_REVIEW'
      expect(Buffer.byteLength(prompt)).toBeLessThan(MAX_OPENCODE_PROMPT_BYTES)
      const plan = buildOpencodeSpawn(
        { ...BASE, prompt, opencodeCmd: [process.execPath, receiver], resumeSessionId: 'review' },
        'win32',
      )
      expect(plan.stdin?.mode).toBe('pipe')
      const proc = Bun.spawn(plan.cmd, {
        stdin: new Blob([plan.stdin!.data]),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const received = (await new Response(proc.stdout).json()) as { s: string; args: string[] }
      expect(await proc.exited).toBe(0)
      expect(received.s).toBe(prompt)
      expect(received.args).toEqual(plan.cmd.slice(2))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('delivers a CJK multiline input and its final sentinel intact to an actual subprocess', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rfc396-prompt-'))
    try {
      const receiver = join(root, 'receiver.ts')
      writeFileSync(
        receiver,
        'const s=await Bun.stdin.text();console.log(JSON.stringify({s,args:Bun.argv.slice(2)}))',
      )
      const prompt = '---\n' + '完整冻结材料🙂\n'.repeat(24000) + '\nFINAL_SENTINEL'
      const plan = buildOpencodeSpawn({
        ...BASE,
        prompt,
        opencodeCmd: [process.execPath, receiver],
      })
      expect(plan.stdin?.mode).toBe('pipe')
      const proc = Bun.spawn(plan.cmd, {
        stdin: new Blob([plan.stdin!.data]),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const received = (await new Response(proc.stdout).json()) as { s: string; args: string[] }
      expect(await proc.exited).toBe(0)
      expect(received.s).toBe(prompt)
      expect(received.args).toEqual(plan.cmd.slice(2))
      expect(plan.cmd.every((arg) => Buffer.byteLength(arg) < 128 * 1024)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
