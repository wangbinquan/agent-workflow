// RFC-348 D1b — the two frontend consumers of the wrapper-loop exit-condition
// roster must derive from `LOOP_EXIT_CONDITION_KINDS` instead of hand-copying
// it. The inspector dropdown and both i18n help texts had silently stopped at
// four kinds while the runtime already accepted `port-inactive` (RFC-306).
// Source-level locks (repo convention for hard-to-render surfaces): the
// dropdown must map the shared roster and must not re-list kinds by hand; each
// help text must mention every roster kind.
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { LOOP_EXIT_CONDITION_KINDS } from '@agent-workflow/shared'

// Repo convention (upload-picker.test.tsx): `import.meta.dirname`, never `new URL(…, import.meta.url)` — Vite
// rewrites the latter as an asset URL and hands back `undefined` for a template path.
const src = (rel: string): string =>
  readFileSync(resolve(import.meta.dirname, '..', 'src', rel), 'utf8')

describe('RFC-348 exit-condition roster consumers', () => {
  test('WrapperGitLoopEdit maps LOOP_EXIT_CONDITION_KINDS and has no hand-typed kind list', () => {
    const inspector = src('components/canvas/inspector/WrapperGitLoopEdit.tsx')
    expect(inspector).toContain('LOOP_EXIT_CONDITION_KINDS.map(')
    expect(inspector).not.toMatch(/\{\s*value:\s*'port-empty'/)
  })

  test('both i18n exit-kind hints mention every roster kind', () => {
    for (const file of ['i18n/en-US.ts', 'i18n/zh-CN.ts']) {
      const text = src(file)
      const hint = text.match(/fieldExitConditionKindHint:\s*\n?\s*'([^']*)'/)?.[1]
      expect(hint, `${file} must define fieldExitConditionKindHint`).toBeDefined()
      for (const kind of LOOP_EXIT_CONDITION_KINDS) {
        expect(hint, `${file} hint must mention ${kind}`).toContain(kind)
      }
    }
  })
})
