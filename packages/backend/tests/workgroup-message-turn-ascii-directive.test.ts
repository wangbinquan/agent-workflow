// Regression guard: the workgroup "## Message turn" directive built by
// composeMemberPrompt (RFC-359 W4-D19c 起住在 application/workgroups/workgroupTurnPrompts.ts) is
// agent-facing ENGLISH prompt text. A stray CJK char had leaked into it — the
// literal read `'... Do NOT claim or start任务 work in this turn.'` — which
// renders to the member agent as the garbled token "start[任务] work". This
// locks the directive back to plain English so any future edit that
// re-introduces mixed-language wording INTO the directive string reds
// immediately.
//
// Scope note: the workgroup modules legitimately contain CJK in code COMMENTS
// elsewhere, so this guard keys on the specific directive substrings rather
// than scanning the whole file.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('workgroup message-turn directive stays English', () => {
  // RFC-359 W4-D19c-tail：legacy 工作组引擎岛已退役，提示词组装与回合驱动合成了两个 provider
  // 共用的一份；指令文案随之只有这两个文件可能承载。
  const app = (name: string): string =>
    readFileSync(
      resolve(
        import.meta.dir,
        '..',
        'src',
        'modules',
        'resource-catalog',
        'application',
        'workgroups',
        name,
      ),
      'utf8',
    )
  const src = app('workgroupTurnPrompts.ts').concat(app('workgroupTurnsDriver.ts'))

  test('the message-turn directive is present and fully English', () => {
    expect(src).toContain('Do NOT claim or start task work in this turn.')
  })

  test('the pre-fix CJK-mixed spelling is gone', () => {
    expect(src).not.toContain('start任务')
  })
})
