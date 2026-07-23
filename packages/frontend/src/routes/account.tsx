// RFC-221 — route-backed account security center.

import { createRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { AccountOverviewPanel } from '@/components/account/AccountOverviewPanel'
import { AccountSecurityPanel } from '@/components/account/AccountSecurityPanel'
import { AccountTokensPanel } from '@/components/account/AccountTokensPanel'
import { EmptyState } from '@/components/EmptyState'
import { PageHeader } from '@/components/PageHeader'
import { PageSectionLink, PageSectionNav, type PageSectionGroup } from '@/components/PageSectionNav'
import { QueryState } from '@/components/QueryState'
import { useActor, type MeResponse } from '@/hooks/useActor'
import {
  parseAccountSection,
  validateAccountSearch,
  withAccountSection,
  type AccountSection,
} from '@/lib/account-navigation'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/account',
  validateSearch: validateAccountSearch,
  component: AccountPage,
})

function AccountPage() {
  const { t } = useTranslation()
  const actor = useActor()
  const search = Route.useSearch()
  const navigate = Route.useNavigate()
  const section = parseAccountSection(search.section)
  const groups: readonly PageSectionGroup<AccountSection>[] = [
    {
      key: 'account',
      label: t('account.sectionGroup'),
      items: [
        {
          key: 'overview',
          label: t('account.sections.overview'),
          description: t('account.sectionDescriptions.overview'),
        },
        {
          key: 'security',
          label: t('account.sections.security'),
          description: t('account.sectionDescriptions.security'),
        },
        {
          key: 'tokens',
          label: t('account.sections.tokens'),
          description: t('account.sectionDescriptions.tokens'),
        },
      ],
    },
  ]

  return (
    <div className="page account-page">
      <PageHeader title={t('account.title', { defaultValue: 'My account' })} />
      <QueryState
        query={actor}
        data={actor.data}
        isEmpty={(data) => data === null || data === undefined}
        keepDataOnError
        empty={
          <EmptyState
            title={t('account.pleaseSignIn')}
            description={t('account.pleaseSignInDescription')}
            size="compact"
          />
        }
      >
        {(me) =>
          me === null || me === undefined ? null : (
            <div className="page-section-layout account-section-layout">
              <PageSectionNav<AccountSection>
                groups={groups}
                active={section}
                presentation="rail"
                ariaLabel={t('account.sectionNavLabel')}
                idPrefix="account"
                renderDestination={(key, destination) => (
                  <PageSectionLink
                    to="/account"
                    search={(previous) => withAccountSection(previous, key)}
                    className={destination.className}
                    pageSectionCurrent={destination.ariaCurrent}
                    data-testid={`account-section-${key}`}
                  >
                    {destination.children}
                  </PageSectionLink>
                )}
                onSelectCompact={(next) => {
                  void navigate({
                    search: (previous) => withAccountSection(previous, next),
                  })
                }}
              />
              <AccountPanel section={section} me={me} />
            </div>
          )
        }
      </QueryState>
    </div>
  )
}

function AccountPanel({ section, me }: { section: AccountSection; me: MeResponse }) {
  switch (section) {
    case 'overview':
      return <AccountOverviewPanel me={me} />
    case 'security':
      return <AccountSecurityPanel me={me} />
    case 'tokens':
      return <AccountTokensPanel me={me} />
  }
}
