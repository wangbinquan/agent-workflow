// RFC-198 + RFC-221 — source contract for account/admin responsive shells.
// Render coverage in users-page-actions.test.tsx locks the live empty/error/action
// behavior; this guard keeps the heavier account/settings routes on shared UX
// primitives without entering PR5's form and confirmation migration scope.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = resolve(import.meta.dirname, '..', 'src')
const read = (path: string): string => readFileSync(resolve(SRC, path), 'utf8')

describe('account and admin responsive shells', () => {
  test('/users uses one shared page shell, query continuity, and a semantic directory', () => {
    const source = read('routes/users.tsx')
    const directory = read('components/users/UserDirectory.tsx')

    expect(source).toContain("import { PageHeader } from '@/components/PageHeader'")
    expect(source).toContain("import { EmptyState } from '@/components/EmptyState'")
    expect(source).toContain("import { ErrorBanner } from '@/components/ErrorBanner'")
    expect(source).toContain('<QueryState')
    expect(source).toContain('keepDataOnError')
    expect(source).toContain('<UserDirectory')
    expect(directory).toContain("title={t('users.empty')}")
    expect(directory).toContain("description={t('users.emptyDescription')}")
    expect(directory).toContain('icon={USER_ICON}')
    expect(directory).toContain('<ul className="user-directory__list"')
    expect(directory).toContain('<li className="user-directory__item"')
    expect(directory).toContain('<SystemPrincipal')
    expect(source).not.toContain('TableViewport')
    expect(directory).not.toContain('<table')
    expect(source).not.toContain('<header className="page__header')
    expect(source).not.toContain('className="auth-form__error"')
  })

  test('/account is route-backed and removes PAT creation and identity unlink surfaces', () => {
    const source = read('routes/account.tsx')
    const overview = read('components/account/AccountOverviewPanel.tsx')
    const security = read('components/account/AccountSecurityPanel.tsx')
    const tokens = read('components/account/AccountTokensPanel.tsx')

    expect(source).toContain(
      "<PageHeader title={t('account.title', { defaultValue: 'My account' })}",
    )
    expect(source).toContain('<PageSectionNav<AccountSection>')
    expect(source).toContain('withAccountSection(previous, key)')
    expect(source).toContain('<QueryState')
    expect(source).toContain('keepDataOnError')
    expect(overview).toContain('me.linkedIdentities.map')
    expect(overview).not.toContain('api.delete(')
    expect(overview).not.toContain('Unlink')
    expect(security).toContain('setToken(result.sessionToken)')
    expect(security).toContain('<ConfirmDialog')
    expect(tokens).toContain('<ConfirmDialog')
    expect(tokens).toContain('api.delete(`/api/auth/pats/${revokeId}`)')
    expect(tokens).not.toContain('TextInput')
    expect(tokens).not.toContain("api.post('/api/auth/pats'")
    expect(tokens).not.toContain('PAT_SCOPE_GROUPS')
    expect(source).not.toContain('/api/auth/identities')
    expect(source).not.toContain('/api/auth/pats')
    expect(source).not.toContain('<header className="page__header')
  })

  test('Auth and Users forms cannot regrow hand-rolled text controls', () => {
    const auth = read('routes/auth.tsx')
    const createUser = read('components/users/CreateUserDialog.tsx')
    const editUser = read('components/users/EditUserDialog.tsx')
    const resetUser = read('components/users/ResetUserPasswordDialog.tsx')
    const userDirectory = read('components/users/UserDirectory.tsx')
    const users = [createUser, editUser, resetUser, userDirectory].join('\n')

    expect(auth).toContain("import { Field, TextInput } from '@/components/Form'")
    expect(auth).toContain("import { TabBar, type TabDef } from '@/components/TabBar'")
    expect(auth).toContain('idPrefix="auth-method"')
    expect(auth).not.toMatch(/<input\b/)
    expect(auth).not.toContain('auth-tabs__tab')
    expect(auth).not.toContain('className="auth-form"')
    expect(auth).not.toMatch(/role="tab(list|panel)?"/)

    expect(createUser).toContain("import { Field, TextInput } from '@/components/Form'")
    expect(createUser).toContain('initialFocusRef={usernameRef}')
    expect(editUser).toContain('<ChoiceCards<Role>')
    expect(resetUser).toContain("import { Field, Switch, TextInput } from '@/components/Form'")
    expect(users).not.toContain('className="users-create-form"')
    expect(users).not.toMatch(/<input\b/)
    expect(users).not.toContain('<label className="form-field">')
  })

  test('settings Authentication list uses shared states/status/table and shared confirmation', () => {
    const source = read('routes/settings.tsx')
    const authentication = source.slice(
      source.indexOf('function AuthenticationTab()'),
      source.indexOf('interface OidcProviderRow'),
    )

    expect(authentication).toContain("<LoadingState label={t('settings.loading')} />")
    // RFC-214: retry收编到 ErrorBanner.onRetry (was a hand-written retryAction button).
    expect(authentication).toContain(
      '<ErrorBanner error={list.error} onRetry={() => void list.refetch()} />',
    )
    expect(authentication).toContain('<EmptyState')
    expect(authentication).toContain("<StatusChip kind={p.enabled ? 'success' : 'neutral'}")
    expect(authentication).toContain('<TableViewport')
    expect(authentication).toContain('<table className="account-table">')
    expect(authentication).not.toContain('className="auth-form__error"')
    expect(authentication).not.toContain('<p className="account-empty">')
    expect(authentication).toContain('<ConfirmDialog')
    expect(authentication).toContain("api.put('/api/oidc/login-policy'")
    expect(authentication).toContain('data-testid="password-login-switch"')
    expect(authentication).toContain('remove.mutateAsync')
    expect(authentication).toContain('force: false')
    expect(authentication).not.toContain('window.confirm(')
  })
})
