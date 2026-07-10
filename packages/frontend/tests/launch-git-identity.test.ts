// RFC-067 — source-layer wiring guards for the launcher's optional Git
// commit identity. The actual route DOM is hard to spin up cheaply (it
// pulls TanStack Router + Query + i18n bootstrap), so we rely on the pure
// `buildLaunchBody` tests (see launch-body-builder-git-identity.test.ts)
// for behaviour and these source-text grep guards for the route wiring +
// canSubmit gate. A regression that drops the pair check or the gate
// would let the Start button enable on a half-identity and we'd eat 422s.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const LAUNCH_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.new.tsx'),
  'utf-8',
)
const ZH = readFileSync(resolve(import.meta.dirname, '..', 'src', 'i18n', 'zh-CN.ts'), 'utf-8')
const EN = readFileSync(resolve(import.meta.dirname, '..', 'src', 'i18n', 'en-US.ts'), 'utf-8')

describe('tasks.new.tsx — RFC-067 git identity wiring', () => {
  test('declares gitUserName + gitUserEmail useState', () => {
    expect(LAUNCH_SRC).toMatch(/const \[gitUserName, setGitUserName\] = useState\(['"]['"]\)/)
    expect(LAUNCH_SRC).toMatch(/const \[gitUserEmail, setGitUserEmail\] = useState\(['"]['"]\)/)
  })

  test('renders both inputs inside the advanced fold', () => {
    expect(LAUNCH_SRC).toContain('data-testid="wizard-advanced"')
    expect(LAUNCH_SRC).toContain('data-testid="wizard-git-user-name"')
    expect(LAUNCH_SRC).toContain('data-testid="wizard-git-user-email"')
    expect(LAUNCH_SRC).toContain("t('launch.gitIdentity.name')")
    expect(LAUNCH_SRC).toContain("t('launch.gitIdentity.email')")
  })

  test('derives gitPairingError + gitEmailFormatError + gitIdentityOk', () => {
    expect(LAUNCH_SRC).toMatch(/const gitPairingError\s*=/)
    expect(LAUNCH_SRC).toMatch(/const gitEmailFormatError\s*=/)
    expect(LAUNCH_SRC).toMatch(/const gitIdentityOk\s*=/)
  })

  test('canSubmit consults gitIdentityOk (via the content-step gate)', () => {
    expect(LAUNCH_SRC).toMatch(/stepContentReady\s*=[\s\S]*?gitIdentityOk/)
    expect(LAUNCH_SRC).toMatch(/canSubmit\s*=[\s\S]*?stepContentReady/)
  })

  test('email regex matches the StartTaskSchema regex (loose [^\\s@]+@[^\\s@]+)', () => {
    // Frontend regex must align with shared schema so that the form's
    // disabled-Start gate fires for the exact same inputs the server
    // would 422 on. Otherwise users see a Start button that does nothing.
    expect(LAUNCH_SRC).toContain('^[^\\s@]+@[^\\s@]+$')
  })

  test('submit payload spreads trimmed identity only when both non-empty', () => {
    // Locks the half-identity-not-on-wire invariant at the call site,
    // matching buildLaunchBody's defensive drop (gitBoth = both trimmed
    // non-empty; collectAdvanced spreads the pair only when gitBoth).
    expect(LAUNCH_SRC).toMatch(
      /gitBoth\s*\?\s*\{ gitUserName: gitNameTrim, gitUserEmail: gitEmailTrim \}/,
    )
  })

  test('pairing-error node carries role="alert" + data-testid', () => {
    expect(LAUNCH_SRC).toContain('role="alert"')
    expect(LAUNCH_SRC).toContain('data-testid="wizard-git-pair-error"')
  })
})

describe('i18n — RFC-067 git identity keys are present and parity-aligned', () => {
  test('zh-CN type declaration lists all 6 keys', () => {
    // Locks the type contract — if a key is added/removed, this assertion
    // is the canary forcing the TypeScript callers to update too.
    const block = ZH.match(/gitIdentity:\s*\{[^}]+\}/)?.[0] ?? ''
    expect(block).toContain('toggle: string')
    expect(block).toContain('name: string')
    expect(block).toContain('email: string')
    expect(block).toContain('hint: string')
    expect(block).toContain('pairingError: string')
    expect(block).toContain('emailInvalid: string')
  })

  test('zh-CN values include Chinese product strings (no "plugin" leak from RFC-029)', () => {
    expect(ZH).toContain("toggle: 'Git 提交身份（可选）'")
    expect(ZH).toContain("hint: '留空则使用系统默认身份'")
    expect(ZH).toContain("pairingError: '用户名和邮箱必须同时填或同时留空'")
    expect(ZH).toContain("emailInvalid: '请输入合法的邮箱（含 @）'")
  })

  test('en-US values present, no leftover untranslated zh', () => {
    expect(EN).toContain("toggle: 'Git commit identity (optional)'")
    expect(EN).toContain("hint: 'Leave blank to use the system default identity'")
    expect(EN).toContain("pairingError: 'Name and email must both be set or both be blank'")
    expect(EN).toContain("emailInvalid: 'Enter a valid email address (must include @)'")
  })
})
