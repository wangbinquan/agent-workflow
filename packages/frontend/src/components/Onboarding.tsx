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
import { DEMO_WORKFLOW_YAML } from '@/fixtures/demo-workflow'
import { getBaseUrl, getToken } from '@/stores/auth'

export interface OnboardingProbe {
  isFirstRun: boolean
  isLoading: boolean
  error: unknown
}

/**
 * Pure decision rule: true when both lists are non-empty arrays of length 0.
 * Treats loading / error states as "not first-run" so the home route doesn't
 * flash the onboarding card while data is still in flight.
 */
export function computeIsFirstRun(opts: {
  agents: Agent[] | undefined
  workflows: Workflow[] | undefined
  isLoading: boolean
  error: unknown
}): boolean {
  if (opts.isLoading) return false
  if (opts.error !== null && opts.error !== undefined) return false
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
  const isLoading = agents.isLoading || workflows.isLoading
  const error = agents.error ?? workflows.error ?? null
  return {
    isFirstRun: computeIsFirstRun({
      agents: agents.data,
      workflows: workflows.data,
      isLoading,
      error,
    }),
    isLoading,
    error,
  }
}

export function Onboarding() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const importDemo = useMutation<void, Error>({
    mutationFn: () => postDemoYaml(DEMO_WORKFLOW_YAML),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['workflows'] }),
  })

  return (
    <div className="page onboarding">
      <header className="page__header">
        <h1>{t('onboarding.title')}</h1>
        <p className="page__hint">{t('onboarding.intro')}</p>
      </header>

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
          <div className="onboarding__actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={importDemo.isPending || importDemo.isSuccess}
              onClick={() => importDemo.mutate()}
            >
              {importDemo.isPending
                ? t('onboarding.step3ImportRunning')
                : t('onboarding.step3Import')}
            </button>
            {/* Creation is a quick-create dialog on the workflows list page. */}
            <Link to="/workflows" className="btn">
              {t('onboarding.step3Manual')}
            </Link>
          </div>
          {importDemo.isSuccess && (
            <div className="info-box" role="status" aria-live="polite">
              {t('onboarding.importedHint')}
            </div>
          )}
          {importDemo.error !== null && importDemo.error !== undefined && (
            <div className="error-box" role="alert">
              {describeError(importDemo.error)}
            </div>
          )}
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
