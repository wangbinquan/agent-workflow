// RFC-320 — source-level ratchet for the task wizard's account-owned Git
// identity. Component tests cover the interaction; these assertions prevent
// the retired per-task fields from quietly returning.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const ROUTE = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.new.tsx'),
  'utf-8',
)
const ZH = readFileSync(resolve(import.meta.dirname, '..', 'src', 'i18n', 'zh-CN.ts'), 'utf-8')
const EN = readFileSync(resolve(import.meta.dirname, '..', 'src', 'i18n', 'en-US.ts'), 'utf-8')

describe('tasks.new.tsx — RFC-320 account-owned Git identity', () => {
  test('reads the private actor profile and never renders retired inputs', () => {
    expect(ROUTE).toContain('actor.data?.profile.gitCommitIdentity')
    expect(ROUTE).not.toContain('setGitUserName')
    expect(ROUTE).not.toContain('setGitUserEmail')
    expect(ROUTE).not.toContain('wizard-git-user-name')
    expect(ROUTE).not.toContain('wizard-git-user-email')
    expect(ROUTE).not.toContain('launch.gitIdentity')
  })

  test('missing profile blocks launch and provides an Account repair link', () => {
    expect(ROUTE).toContain('immediateGitIdentityReady')
    expect(ROUTE).toContain('admissionGitIdentityReady')
    expect(ROUTE).toContain('wizard-git-identity-missing')
    expect(ROUTE).toContain('wizard-git-identity-fix')
    expect(ROUTE).toContain('to="/account"')
    expect(ROUTE).toContain("search={{ section: 'codePush' }}")
  })

  test('confirmation renders the source identity as read-only text', () => {
    expect(ROUTE).toContain("t('taskWizard.gitCommitIdentity')")
    expect(ROUTE).toContain('`${gitCommitIdentity.name} <${gitCommitIdentity.email}>`')
  })
})

describe('i18n — RFC-320 identity guidance', () => {
  test('both bundles contain the account-owned and missing-profile copy', () => {
    for (const source of [ZH, EN]) {
      expect(source).toContain('gitCommitIdentityMissingTitle')
      expect(source).toContain('gitCommitIdentityMissingBody')
      expect(source).toContain('gitCommitIdentityFix')
      expect(source).not.toMatch(/\n\s+gitIdentity:\s*\{/)
    }
  })
})
