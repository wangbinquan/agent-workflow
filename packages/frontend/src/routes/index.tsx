// / — home route.
//
// First-run UX (P-5-10): if no agents and no workflows exist, render the
// Onboarding card; otherwise the dashboard (`<Homepage />`) — RFC-032 PR3.
// The previous fallback redirected to /agents, which silently forced
// "Agents" to be the de-facto home page. The dashboard surfaces the
// running / waiting / recent task picture instead.

import { createRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { Onboarding, useOnboardingProbe } from '@/components/Onboarding'
import { PageHeader } from '@/components/PageHeader'
import { Homepage } from '@/components/home/Homepage'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/',
  component: IndexPage,
})

function IndexPage() {
  const { t } = useTranslation()
  const probe = useOnboardingProbe()
  const retryAction = (
    <button
      type="button"
      className="btn"
      disabled={probe.isLoading}
      aria-busy={probe.isLoading}
      onClick={probe.retry}
    >
      {t('common.retry')}
    </button>
  )

  if (!probe.hasData) {
    return (
      <div className="page" data-testid="home-probe-state">
        <PageHeader title={t('nav.home')} />
        {probe.isLoading ? (
          <LoadingState />
        ) : (
          <ErrorBanner error={probe.error} action={retryAction} />
        )}
      </div>
    )
  }

  if (probe.isFirstRun) {
    return (
      <Onboarding
        probeError={probe.error}
        onRetryProbe={probe.retry}
        probeRetrying={probe.isLoading}
      />
    )
  }

  if (probe.error === null || probe.error === undefined) return <Homepage />

  return (
    <div className="stack--md">
      <ErrorBanner error={probe.error} action={retryAction} />
      <Homepage />
    </div>
  )
}
