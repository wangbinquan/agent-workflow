// Regression lock for the Windows OpenCode version-probe failure reported on
// 2026-08-27: Bun.which("opencode") resolves npm's opencode.cmd wrapper, and
// Bun.spawn({ detached: true, stdout: "pipe" }) loses that wrapper's output on
// Windows even though the process exits 0. The real-kernel case below must stay
// in windows-platform CI.

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { probeOpencode } from '../src/services/runtime/opencode/util'

describe('Windows .cmd version probe stdout', () => {
  test.skipIf(process.platform !== 'win32')(
    'Bun.which-resolved opencode.cmd preserves --version stdout',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'aw-opencode-cmd-probe-'))
      try {
        const wrapper = join(root, 'opencode.cmd')
        writeFileSync(wrapper, '@echo off\r\n@echo opencode version 9.8.7\r\n')

        const resolved = Bun.which('opencode', { PATH: root })
        expect(resolved).not.toBeNull()
        expect(resolved!.toLowerCase().endsWith('opencode.cmd')).toBe(true)

        const probe = await probeOpencode(resolved!, { quiet: true, timeoutMs: 5_000 })
        expect(probe).toMatchObject({
          ran: true,
          compatible: true,
          version: '9.8.7',
        })
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
  )
})
