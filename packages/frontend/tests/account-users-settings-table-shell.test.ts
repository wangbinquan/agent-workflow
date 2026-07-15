// RFC-198 PR4/T5 — source contract for the remaining account/admin table shells.
// Render coverage in users-page-actions.test.tsx locks the live empty/error/action
// behavior; this guard keeps the heavier account/settings routes on shared UX
// primitives without entering PR5's form and confirmation migration scope.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = resolve(import.meta.dirname, '..', 'src')
const read = (path: string): string => readFileSync(resolve(SRC, path), 'utf8')

describe('RFC-198 account and admin table shells', () => {
  test('/users uses one shared page shell and responsive table/async primitives', () => {
    const source = read('routes/users.tsx')

    expect(source).toContain("import { PageHeader } from '@/components/PageHeader'")
    expect(source).toContain("import { EmptyState } from '@/components/EmptyState'")
    expect(source).toContain("import { ErrorBanner } from '@/components/ErrorBanner'")
    expect(source).toContain("title={t('users.empty')}")
    expect(source).toContain("description={t('users.emptyDescription')}")
    expect(source).toContain('icon={USER_ICON}')
    expect(source).toContain('action={newUserAction}')
    expect(source).toContain("<TableViewport label={t('users.title', { defaultValue: 'Users' })}")
    expect(source).not.toContain('<header className="page__header')
    expect(source).not.toContain('className="auth-form__error"')
  })

  test('/account keeps its cards/forms intact while wrapping all three native tables', () => {
    const source = read('routes/account.tsx')

    expect(source).toContain(
      "<PageHeader title={t('account.title', { defaultValue: 'My account' })}",
    )
    expect(source).toContain('<EmptyState title={t(\'account.pleaseSignIn\')} size="compact"')
    expect(source.match(/<TableViewport/g)).toHaveLength(3)
    expect(source.match(/<table className="account-table">/g)).toHaveLength(3)
    expect(source).toContain('function SectionShell(')
    expect(source).toContain('className="account-form"')
    expect(source).not.toContain('<header className="page__header')
  })

  test('settings Authentication list uses shared states/status/table and leaves PR5 confirm intact', () => {
    const source = read('routes/settings.tsx')
    const authentication = source.slice(
      source.indexOf('function AuthenticationTab()'),
      source.indexOf('interface OidcProviderRow'),
    )

    expect(authentication).toContain("<LoadingState label={t('settings.loading')} />")
    expect(authentication).toContain('<ErrorBanner error={list.error} action={retryAction} />')
    expect(authentication).toContain('<EmptyState')
    expect(authentication).toContain("<StatusChip kind={p.enabled ? 'success' : 'neutral'}")
    expect(authentication).toContain('<TableViewport')
    expect(authentication).toContain('<table className="account-table">')
    expect(authentication).not.toContain('className="auth-form__error"')
    expect(authentication).not.toContain('<p className="account-empty">')
    expect(authentication).toContain('window.confirm(')
  })
})
