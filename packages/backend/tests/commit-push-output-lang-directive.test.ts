// RFC-157 — locks the output-language directive plumbing for the built-in
// commit agent (mirrors memory-distiller-output-lang-directive.test.ts).
//
// Verifies:
//   D1: lang='en-US' (and the undefined fallback) appends the English directive
//       at the END of BOTH buildCommitMessagePrompt and buildRepairPrompt, and
//       omitted lang === explicit 'en-US' byte-for-byte.
//   D2: lang='zh-CN' appends the Chinese directive at the END of both.
//   D3: both directives keep the Conventional-Commits `<type>(<scope>):` prefix
//       rule as ASCII (only the human summary/body language flips), so a
//       zh-CN commit still reads `feat(scope): 中文摘要`.
//   D4: config.commitPushLang threads through resolveLaunchRuntimeConfig onto
//       the commitPush deps (later flattened to RunTaskOptions.commitPushLang by
//       runtimeConfigOpts — locked in rfc103-launch-config-passthrough.test.ts).
//
// Placement matters: the directive is appended last so the model reads it most
// recently. This deliberately does NOT preserve the pre-RFC-157 prompt bytes on
// the default path (the en-US directive is appended even when unset) — that
// mirrors the distiller and is the accepted trade-off for "consistent with
// memory extraction" (Codex design-gate P2-2).

import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildCommitMessagePrompt,
  buildRepairPrompt,
  COMMIT_PUSH_OUTPUT_LANG_DIRECTIVE,
} from '../src/services/commitPush'
import { resolveLaunchRuntimeConfig } from './helpers/launchRuntimeConfig'

const MSG_OPTS = {
  repoName: 'demo',
  branch: 'feature/x',
  baseRef: 'main',
  stat: '1 file changed',
  diffTruncated: '@@ -1 +1 @@',
}
const REPAIR_OPTS = {
  branch: 'feature/x',
  pushStderr: 'bad message format',
  currentMessage: 'wip',
  stat: '1 file changed',
  priorAttempts: 1,
}

describe('RFC-157 commit-push prompts — output language directive', () => {
  test('D1: en-US (default) appends the English directive at the end of both prompts', () => {
    // commit-message prompt
    const msgDefault = buildCommitMessagePrompt(MSG_OPTS)
    const msgEn = buildCommitMessagePrompt({ ...MSG_OPTS, lang: 'en-US' })
    // Omitted lang === explicit 'en-US', byte-for-byte.
    expect(msgDefault).toBe(msgEn)
    expect(msgDefault.endsWith(COMMIT_PUSH_OUTPUT_LANG_DIRECTIVE['en-US'])).toBe(true)

    // repair prompt
    const repDefault = buildRepairPrompt(REPAIR_OPTS)
    const repEn = buildRepairPrompt({ ...REPAIR_OPTS, lang: 'en-US' })
    expect(repDefault).toBe(repEn)
    expect(repDefault.endsWith(COMMIT_PUSH_OUTPUT_LANG_DIRECTIVE['en-US'])).toBe(true)

    // English directive must not contain CJK characters.
    expect(/\p{Script=Han}/u.test(COMMIT_PUSH_OUTPUT_LANG_DIRECTIVE['en-US'])).toBe(false)
  })

  test('D2: zh-CN appends the Chinese directive at the end of both prompts', () => {
    const msg = buildCommitMessagePrompt({ ...MSG_OPTS, lang: 'zh-CN' })
    expect(msg.endsWith(COMMIT_PUSH_OUTPUT_LANG_DIRECTIVE['zh-CN'])).toBe(true)
    expect(msg.endsWith(COMMIT_PUSH_OUTPUT_LANG_DIRECTIVE['en-US'])).toBe(false)

    const rep = buildRepairPrompt({ ...REPAIR_OPTS, lang: 'zh-CN' })
    expect(rep.endsWith(COMMIT_PUSH_OUTPUT_LANG_DIRECTIVE['zh-CN'])).toBe(true)
    expect(rep.endsWith(COMMIT_PUSH_OUTPUT_LANG_DIRECTIVE['en-US'])).toBe(false)

    // Chinese directive must contain CJK.
    expect(/\p{Script=Han}/u.test(COMMIT_PUSH_OUTPUT_LANG_DIRECTIVE['zh-CN'])).toBe(true)
  })

  test('D2b: the directive comes AFTER the output envelope example (last thing the model reads)', () => {
    const msg = buildCommitMessagePrompt({ ...MSG_OPTS, lang: 'zh-CN' })
    const envIdx = msg.indexOf('<workflow-output>')
    const dirIdx = msg.lastIndexOf(COMMIT_PUSH_OUTPUT_LANG_DIRECTIVE['zh-CN'])
    expect(envIdx).toBeGreaterThan(-1)
    expect(dirIdx).toBeGreaterThan(envIdx)
  })

  test('D3: both directives preserve the Conventional-Commits ASCII prefix rule', () => {
    for (const lang of ['en-US', 'zh-CN'] as const) {
      const d = COMMIT_PUSH_OUTPUT_LANG_DIRECTIVE[lang]
      // The `<type>(<scope>):` structural prefix + a concrete ASCII example must
      // appear in both languages so a translated summary never localises the type.
      expect(d).toContain('<type>(<scope>):')
      expect(d).toContain('feat(auth):')
    }
  })
})

describe('RFC-157 resolveLaunchRuntimeConfig — commitPushLang passthrough', () => {
  let tmp: string
  let path: string

  test('config.commitPushLang surfaces on the commitPush deps (undefined stays absent)', () => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-rfc157-cfg-'))
    path = join(tmp, 'config.json')
    try {
      writeFileSync(path, JSON.stringify({ $schema_version: 1, commitPushLang: 'zh-CN' }))
      expect(resolveLaunchRuntimeConfig(path).commitPush?.lang).toBe('zh-CN')

      // Unset → no lang key synthesized (undefined ≡ en-US downstream).
      writeFileSync(path, JSON.stringify({ $schema_version: 1 }))
      const out = resolveLaunchRuntimeConfig(path)
      expect(out.commitPush?.lang).toBeUndefined()
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
