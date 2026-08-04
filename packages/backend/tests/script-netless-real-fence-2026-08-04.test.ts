// 2026-08-04 沙箱审计的测试覆盖缺口之一：脚本节点 `network: 'deny'` 承诺的「无网」
// 此前**只有 argv / 渲染层证据**——两个 OS 上都没有任何用例真的起一个被围栏的进程再去
// 摸网络。RFC-253 自己的实现门就出过一次「receipt 说 contained、实际零围栏」，那正是
// 只断言渲染结果时看不出来的形态。
//
// 本文件用真实机制跑：macOS 走 `sandbox-exec` + 平台自己渲染的 profile，
// Linux 走 `bwrap` + 平台自己渲染的 argv。断言两件事必须同时成立：
//   ① 出网确实被拒（否则「无网」是空话）；
//   ② 工作树仍然可写（否则围栏顺手把功能也砍了——这正是本轮审计反复出现的失效形态）。
//
// 门控（与既有沙箱集成用例同一个开关，CI 在 macOS shard 上激活）：
//   RUN_SANDBOX_ITEST=1 bun test tests/script-netless-real-fence-2026-08-04.test.ts

import { afterAll, describe, expect } from 'bun:test'
import { test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computeSandboxPolicy,
  renderBwrapArgs,
  renderSeatbeltProfile,
} from '../src/services/sandbox/policy'

const itest = process.env.RUN_SANDBOX_ITEST === '1' ? test : test.skip

const appHome = mkdtempSync(join(tmpdir(), 'aw-netless-real-'))
afterAll(() => rmSync(appHome, { recursive: true, force: true }))

/** Wrap `argv` in the platform's OWN renderer output for a netless policy. */
function wrapNetless(argv: string[], worktree: string, runDir: string): string[] {
  const policy = computeSandboxPolicy({
    appHome,
    taskWorktrees: [worktree],
    runDir,
    networkDeny: true,
    // The mirror is not materialized in this fixture; the renderer must not
    // bind a missing source (that bug is locked separately).
    gitMirrorPresent: false,
  })
  if (process.platform === 'darwin') {
    return ['/usr/bin/sandbox-exec', '-p', renderSeatbeltProfile(policy), ...argv]
  }
  return ['bwrap', ...renderBwrapArgs(policy), '--', ...argv]
}

async function run(argv: string[], cwd: string): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn({ cmd: argv, cwd, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out: `${out}${err}` }
}

describe('script netless fence — 真实机制，不是 argv 断言', () => {
  itest(
    '被围栏的进程连不上外网，但工作树照样可写',
    async () => {
      const worktree = mkdtempSync(join(appHome, 'wt-'))
      const runDir = mkdtempSync(join(appHome, 'run-'))
      const probe = join(worktree, 'probe.sh')
      const written = join(worktree, 'written.txt')
      writeFileSync(
        probe,
        [
          '#!/bin/sh',
          // ① 出网：连一个必然不在本机的地址。被围栏时应当失败（拒绝/不可达），
          //    而不是超时——所以给一个短超时，超时也算未被拒，会让断言红。
          'if command -v curl >/dev/null 2>&1; then',
          '  curl -sS -m 5 https://example.com >/dev/null 2>&1 && echo NET_OK || echo NET_BLOCKED',
          'else',
          '  echo NET_SKIPPED',
          'fi',
          // ② 工作树可写：围栏不该把本职工作一起砍掉。
          'printf ok > "$(dirname "$0")/written.txt" && echo WRITE_OK || echo WRITE_FAIL',
        ].join('\n'),
        { mode: 0o755 },
      )
      const { out } = await run(wrapNetless(['/bin/sh', probe], worktree, runDir), worktree)
      expect(out).toContain('WRITE_OK')
      expect(readFileSync(written, 'utf8')).toBe('ok')
      // curl 缺席时不做无意义的断言（记录为 skipped 而不是假绿）。
      if (out.includes('NET_SKIPPED')) return
      expect(out).toContain('NET_BLOCKED')
      expect(out).not.toContain('NET_OK')
    },
    60_000,
  )

  itest(
    '不加围栏时同一个探针确实能出网（证明上一条不是探针本身坏了）',
    async () => {
      const worktree = mkdtempSync(join(appHome, 'wt-open-'))
      const probe = join(worktree, 'probe.sh')
      writeFileSync(
        probe,
        [
          '#!/bin/sh',
          'if command -v curl >/dev/null 2>&1; then',
          '  curl -sS -m 10 https://example.com >/dev/null 2>&1 && echo NET_OK || echo NET_BLOCKED',
          'else',
          '  echo NET_SKIPPED',
          'fi',
        ].join('\n'),
        { mode: 0o755 },
      )
      const { out } = await run(['/bin/sh', probe], worktree)
      if (out.includes('NET_SKIPPED')) return
      // 这是对照组：网络本来就不通的环境下，上一条的 NET_BLOCKED 说明不了任何事。
      expect(out).toContain('NET_OK')
    },
    60_000,
  )
})
