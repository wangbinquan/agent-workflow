// First-run surface (P-5-10, hero from RFC-190, rebuilt for RFC-211).
//
// Rendered by the / route when both /api/agents and /api/workflows come back
// empty. It used to hard-code four steps plus a one-click "import demo
// workflow" button — which imported a workflow referencing an agent named
// `coder` that nothing ever created, so the very first thing a new user did
// failed validation at launch. It now hands off to the guided tour, which
// creates a matched, runnable set instead.
//
// Exactly ONE `.btn--primary` lives here on purpose (locked by a test): a
// first-run screen with four equally-weighted calls to action is a screen with
// no call to action.

import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { Agent, Workflow } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { ErrorBanner } from '@/components/ErrorBanner'
import { CapabilityGrid } from '@/components/home/CapabilityGrid'
import { PipelineHero } from '@/components/home/PipelineHero'
import { PageHeader } from '@/components/PageHeader'

export interface OnboardingProbe {
  isFirstRun: boolean
  isLoading: boolean
  hasData: boolean
  error: unknown
  retry: () => void
}

/**
 * Pure decision rule: true when both list snapshots exist and are empty.
 * Loading/error flags do not discard already-rendered snapshots: a background
 * refetch failure must keep the current first-run/home surface visible while
 * the route reports that failure separately. Initial requests have undefined
 * data and therefore never flash the onboarding surface.
 */
export function computeIsFirstRun(opts: {
  agents: Agent[] | undefined
  workflows: Workflow[] | undefined
  isLoading: boolean
  error: unknown
}): boolean {
  if (opts.agents === undefined || opts.workflows === undefined) return false
  return opts.agents.length === 0 && opts.workflows.length === 0
}

export function useOnboardingProbe(): OnboardingProbe {
  const agents = useQuery<Agent[]>({
    queryKey: ['agents'],
    queryFn: ({ signal }) => api.get('/api/agents', undefined, signal),
  })
  const workflows = useQuery<Workflow[]>({
    queryKey: ['workflows'],
    queryFn: ({ signal }) => api.get('/api/workflows', undefined, signal),
  })
  const isLoading = agents.isFetching || workflows.isFetching
  const error = agents.error ?? workflows.error ?? null
  const hasData = agents.data !== undefined && workflows.data !== undefined
  return {
    isFirstRun: computeIsFirstRun({
      agents: agents.data,
      workflows: workflows.data,
      isLoading,
      error,
    }),
    isLoading,
    hasData,
    error,
    retry: () => {
      void Promise.all([agents.refetch(), workflows.refetch()])
    },
  }
}

export interface OnboardingProps {
  /** A failed background first-run probe; stale onboarding data stays visible. */
  probeError?: unknown
  onRetryProbe?: () => void
  probeRetrying?: boolean
}

export function Onboarding(props: OnboardingProps = {}) {
  const { t } = useTranslation()
  // The three learning flows the guided tour covers.
  const tracks = ['agent', 'workflow', 'workgroup'] as const

  return (
    <div className="page onboarding">
      <PageHeader title={t('onboarding.title')}>
        <p className="page__hint">{t('onboarding.intro')}</p>
        {props.probeError !== null && props.probeError !== undefined && (
          <div className="stack-top--sm">
            <ErrorBanner
              error={props.probeError}
              action={
                props.onRetryProbe !== undefined ? (
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={props.probeRetrying === true}
                    aria-busy={props.probeRetrying === true}
                    onClick={props.onRetryProbe}
                  >
                    {t('common.retry')}
                  </button>
                ) : undefined
              }
            />
          </div>
        )}
      </PageHeader>

      {/* RFC-190: first-run hero — the platform's core abstraction drawn as
          the same animated mini-pipeline the homepage uses, plus a count-less
          capability intro grid (fresh installs shouldn't see a wall of 0s). */}
      <section className="onboarding__hero" data-testid="onboarding-hero">
        <div className="onboarding__hero-text">
          <h2>{t('onboarding.heroTitle')}</h2>
          <p className="muted">{t('onboarding.heroIntro')}</p>
        </div>
        <PipelineHero />
      </section>
      <CapabilityGrid variant="intro" />

      <section className="onboarding__steps-intro">
        <p>{t('onboarding.tracksIntro')}</p>
        <ul className="onboarding__steps">
          {tracks.map((track) => (
            <li className="onboarding__step" key={track}>
              <h2>{t(`guide.track.${track}`)}</h2>
              <p>{t(`guide.track.${track}Desc`)}</p>
            </li>
          ))}
        </ul>
        <div className="onboarding__actions">
          <Link to="/onboarding" className="btn btn--primary" data-testid="onboarding-start">
            {t('onboarding.startCta')}
          </Link>
        </div>
      </section>

      <div className="onboarding__skip">
        <Link to="/agents">{t('onboarding.skipLink')}</Link>
      </div>
    </div>
  )
}
