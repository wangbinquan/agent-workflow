// First-run onboarding card (P-5-10).
//
// Rendered by the / route when both /api/agents and /api/workflows come
// back empty. Shows a four-step walkthrough plus a one-click "import demo
// workflow" button that POSTs a bundled YAML fixture.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import type { Agent, Workflow } from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { ErrorBanner } from '@/components/ErrorBanner'
import { CapabilityGrid } from '@/components/home/CapabilityGrid'
import { PipelineHero } from '@/components/home/PipelineHero'
import { NoticeBanner } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { DEMO_WORKFLOW_YAML } from '@/fixtures/demo-workflow'
import { getBaseUrl, getToken } from '@/stores/auth'

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
  const qc = useQueryClient()
  const importDemo = useMutation<void, Error>({
    mutationFn: () => postDemoYaml(DEMO_WORKFLOW_YAML),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflows'] }),
  })

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
                    className="btn"
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

      <ol className="onboarding__steps">
        <li className="onboarding__step">
          <h2>{t('onboarding.step1Title')}</h2>
          <p>{t('onboarding.step1Body')}</p>
          <Link to="/agents/new" className="btn btn--primary">
            {t('onboarding.step1Cta')}
          </Link>
        </li>

        <li className="onboarding__step">
          <h2>{t('onboarding.step2Title')}</h2>
          <p>{t('onboarding.step2Body')}</p>
          <Link to="/skills" className="btn">
            {t('onboarding.step2Cta')}
          </Link>
        </li>

        <li className="onboarding__step">
          <h2>{t('onboarding.step3Title')}</h2>
          <p>{t('onboarding.step3Body')}</p>
          <div className="stack--sm">
            <div className="onboarding__actions">
              <button
                type="button"
                className="btn"
                disabled={importDemo.isPending || importDemo.isSuccess}
                aria-busy={importDemo.isPending}
                onClick={() => importDemo.mutate()}
              >
                {importDemo.isPending
                  ? t('onboarding.step3ImportRunning')
                  : importDemo.error !== null
                    ? t('common.retry')
                    : t('onboarding.step3Import')}
              </button>
              {/* Creation is a quick-create dialog on the workflows list page. */}
              <Link to="/workflows" className="btn">
                {t('onboarding.step3Manual')}
              </Link>
            </div>
            {importDemo.isSuccess && (
              <NoticeBanner tone="success" size="compact">
                {t('onboarding.importedHint')}
              </NoticeBanner>
            )}
            {importDemo.error !== null && importDemo.error !== undefined && (
              <ErrorBanner error={importDemo.error} message={describeError(importDemo.error)} />
            )}
          </div>
        </li>

        <li className="onboarding__step">
          <h2>{t('onboarding.step4Title')}</h2>
          <p>{t('onboarding.step4Body')}</p>
          <Link to="/workflows" className="btn">
            {t('onboarding.step4Cta')}
          </Link>
        </li>
      </ol>

      <div className="onboarding__skip">
        <Link to="/agents">{t('onboarding.skipLink')}</Link>
      </div>
    </div>
  )
}

async function postDemoYaml(yamlText: string): Promise<void> {
  const url = new URL('/api/workflows/import', getBaseUrl())
  url.searchParams.set('onConflict', 'new')
  const headers: Record<string, string> = { 'content-type': 'text/yaml' }
  const token = getToken()
  if (token !== null) headers.Authorization = `Bearer ${token}`
  const res = await fetch(url.toString(), { method: 'POST', headers, body: yamlText })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as {
      error?: { code: string; message: string }
    } | null
    const err = body?.error ?? {
      code: `http-${res.status}`,
      message: res.statusText || 'request failed',
    }
    throw new ApiError(res.status, err.code, err.message)
  }
}

function describeError(e: unknown): string {
  if (e instanceof ApiError) return `${e.code}: ${e.message}`
  if (e instanceof Error) return e.message
  return String(e)
}
