// Regression guard: the workgroup "## Message turn" directive built by
// composeMemberPrompt (services/workgroupRunner.ts) is agent-facing ENGLISH
// prompt text. A stray CJK char had leaked into it — the literal read
// `'... Do NOT claim or start任务 work in this turn.'` — which renders to the
// member agent as the garbled token "start[任务] work". This locks the directive
// back to plain English so any future edit that re-introduces mixed-language
// wording INTO the directive string reds immediately.
//
// Scope note: workgroupRunner.ts legitimately contains CJK in code COMMENTS
// elsewhere, so this guard keys on the specific directive substrings rather than
// scanning the whole file.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('workgroup message-turn directive stays English', () => {
  const src = readFileSync(
    resolve(import.meta.dir, '..', 'src', 'services', 'workgroupRunner.ts'),
    'utf8',
  )

  test('the message-turn directive is present and fully English', () => {
    expect(src).toContain('Do NOT claim or start task work in this turn.')
  })

  test('the pre-fix CJK-mixed spelling is gone', () => {
    expect(src).not.toContain('start任务')
  })
})
