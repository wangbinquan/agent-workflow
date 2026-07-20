// RFC-211 — the guided tour page.
//
// Deliberately built only from existing primitives (ChoiceCards / Stepper /
// Card / ConfirmDialog / NoticeBanner / EmptyState / Select). RFC-199 settled
// the product stance that "zero guidance" means a self-explanatory interface
// rather than a tutorial overlay, so there is no spotlight, no coachmark and no
// modal that hijacks the app — this is an ordinary page you can leave at any
// time, and the thing it produces is real, editable resources.
//
// Every step offers both paths:
//   - "build it for me" provisions a working example server-side and drops you
//     on its edit page, so the first thing you see is the real form;
//   - "I'll do it myself" links to the ordinary create form, and the adopt
//     picker below it registers whatever you built into the tour.
// Completion is never inferred from list length: another user's public resource
// (or, for an admin, literally everyone's) would tick the box for you.

import { useMemo, useState } from 'react'
import { createRoute, Link, useNavigate } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  ONBOARDING_TRACK_STEPS,
  type Agent,
  type ExampleCleanupResult,
  type ExampleInventory,
  type OnboardingRun,
  type OnboardingStep,
  type OnboardingTrack,
  type ProvisionOnboardingResult,
  type Skill,
  type Workflow,
  type Workgroup,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Route as rootRoute } from '@/routes/__root'
import { Card } from '@/components/Card'
import { ChoiceCards } from '@/components/ChoiceCards'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { NoticeBanner } from '@/components/NoticeBanner'
import { PageHeader } from '@/components/PageHeader'
import { Select } from '@/components/Select'
import { Stepper } from '@/components/Stepper'
import { useActor, useIsAdmin } from '@/hooks/useActor'

const TRACKS: readonly OnboardingTrack[] = ['agent', 'skill', 'workflow', 'workgroup']

/** i18n key suffix for a step, e.g. `agent.create` → `agentCreate`. */
function stepKey(step: OnboardingStep): string {
  const [track, action] = step.split('.')
  return `${track}${(action ?? '').charAt(0).toUpperCase()}${(action ?? '').slice(1)}`
}

/** Which resource kind a step's "I'll do it myself" path produces. */
function stepResourceType(step: OnboardingStep): 'agent' | 'skill' | 'workflow' | 'workgroup' {
  const track = step.split('.')[0] as OnboardingTrack
  // Both skill steps end up attached to an agent, but the thing the user
  // creates by hand in the skill track is the skill itself.
  return track
}

function selfServePath(step: OnboardingStep): { to: string; search?: Record<string, unknown> } {
  switch (stepResourceType(step)) {
    case 'agent':
      return { to: '/agents/new' }
    case 'skill':
      return { to: '/skills/new' }
    case 'workflow':
      // Workflows retired their /new route; creation is a quick-create dialog
      // on the list page, opened by ?create=true.
      return { to: '/workflows', search: { create: true } }
    case 'workgroup':
      return { to: '/workgroups', search: { create: true } }
  }
}

function OnboardingPage() {
  const { t } = useTranslation()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const isAdmin = useIsAdmin()
  const actor = useActor()
  const [track, setTrack] = useState<OnboardingTrack | null>(null)
  const [stepIndex, setStepIndex] = useState(0)
  const [adoptPick, setAdoptPick] = useState<string>('')
  const [cleanupOpen, setCleanupOpen] = useState(false)
  const [cleanupScope, setCleanupScope] = useState<'mine' | 'all'>('mine')
  const [cleanupResult, setCleanupResult] = useState<ExampleCleanupResult | null>(null)

  const runs = useQuery<OnboardingRun[]>({
    queryKey: ['onboarding', 'runs'],
    queryFn: ({ signal }) => api.get('/api/onboarding/runs', undefined, signal),
  })

  const run = useMemo(
    () => (track === null ? null : ((runs.data ?? []).find((r) => r.track === track) ?? null)),
    [runs.data, track],
  )

  const steps = track === null ? [] : ONBOARDING_TRACK_STEPS[track]
  const currentStep = steps[stepIndex] ?? null
  const completed = new Set(run?.completedSteps ?? [])

  const startRun = useMutation<OnboardingRun, Error, OnboardingTrack>({
    mutationFn: (t0) => api.post('/api/onboarding/runs', { track: t0 }),
    onSuccess: async (created) => {
      setTrack(created.track)
      setStepIndex(0)
      await qc.invalidateQueries({ queryKey: ['onboarding', 'runs'] })
    },
  })

  const provision = useMutation<ProvisionOnboardingResult, Error, OnboardingStep>({
    mutationFn: (step) =>
      api.post(`/api/onboarding/runs/${encodeURIComponent(run?.id ?? '')}/provision`, { step }),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ['onboarding', 'runs'] })
      // Land on the EDIT surface, not a read-only detail: seeing the real form
      // pre-filled is the part that teaches.
      if (res.resourceType === 'agent') {
        void navigate({ to: '/agents/$name', params: { name: res.resourceName } as never } as never)
      } else if (res.resourceType === 'skill') {
        void navigate({ to: '/skills/$name', params: { name: res.resourceName } as never } as never)
      } else if (res.resourceType === 'workflow') {
        void navigate({
          to: '/workflows/$id/edit',
          params: { id: res.resourceId } as never,
        } as never)
      } else if (res.resourceType === 'workgroup') {
        void navigate({
          to: '/workgroups/$name',
          params: { name: res.resourceName } as never,
        } as never)
      }
    },
  })

  const adopt = useMutation<OnboardingRun, Error, { step: OnboardingStep; key: string }>({
    mutationFn: (v) =>
      api.post(`/api/onboarding/runs/${encodeURIComponent(run?.id ?? '')}/adopt`, {
        step: v.step,
        resourceType: stepResourceType(v.step),
        resourceKey: v.key,
      }),
    onSuccess: async () => {
      setAdoptPick('')
      await qc.invalidateQueries({ queryKey: ['onboarding', 'runs'] })
    },
  })

  const inventory = useQuery<ExampleInventory>({
    queryKey: ['onboarding', 'examples', cleanupScope],
    queryFn: ({ signal }) => api.get('/api/onboarding/examples', { scope: cleanupScope }, signal),
    enabled: cleanupOpen,
  })

  const cleanup = useMutation<ExampleCleanupResult, Error, 'mine' | 'all'>({
    mutationFn: (scope) => api.delete(`/api/onboarding/examples?scope=${scope}`),
    onSuccess: async (res) => {
      setCleanupResult(res)
      setCleanupOpen(false)
      await qc.invalidateQueries({ queryKey: ['onboarding'] })
      await qc.invalidateQueries({ queryKey: ['agents'] })
      await qc.invalidateQueries({ queryKey: ['skills'] })
      await qc.invalidateQueries({ queryKey: ['workflows'] })
      await qc.invalidateQueries({ queryKey: ['workgroups'] })
      await qc.invalidateQueries({ queryKey: ['tasks'] })
    },
  })

  return (
    <div className="page onboarding">
      <PageHeader title={t('guide.title')} data-testid="guide-page">
        <p className="page__hint">{t('guide.intro')}</p>
      </PageHeader>

      <NoticeBanner tone="info" size="compact" testid="guide-sandbox-notice">
        {t('guide.sandboxNotice')}
      </NoticeBanner>

      {runs.isError && <ErrorBanner error={runs.error} />}
      {runs.isLoading && <LoadingState />}

      <section className="page__section onboarding__tracks">
        <h2>{t('guide.pickTrack')}</h2>
        <ChoiceCards<OnboardingTrack>
          // Empty (not a defaulted 'agent') until the user actually picks:
          // ChoiceCards suppresses onChange for the already-active option, so
          // pre-selecting one would make its card unclickable.
          value={track ?? ('' as OnboardingTrack)}
          options={TRACKS.map((tr) => ({
            value: tr,
            label: t(`guide.track.${tr}`),
            description: t(`guide.track.${tr}Desc`),
          }))}
          onChange={(next) => {
            setTrack(next)
            setStepIndex(0)
          }}
          ariaLabel={t('guide.pickTrack')}
          testidPrefix="guide-track"
        />
        {track !== null && run === null && (
          <div className="onboarding__actions">
            <button
              type="button"
              className="btn btn--primary"
              data-testid="guide-start"
              disabled={startRun.isPending}
              aria-busy={startRun.isPending}
              onClick={() => startRun.mutate(track)}
            >
              {t('guide.start')}
            </button>
          </div>
        )}
        {startRun.error !== null && <ErrorBanner error={startRun.error} />}
      </section>

      {run !== null && track !== null && currentStep !== null && (
        <section className="page__section" data-testid="guide-steps">
          <Stepper
            steps={steps.map((s) => ({ key: s, title: t(`guide.step.${stepKey(s)}`) }))}
            current={stepIndex}
            onNavigate={(i) => {
              setStepIndex(i)
              setAdoptPick('')
            }}
            nextEnabled={completed.has(currentStep)}
            rootTestid="guide-stepper"
          >
            <div className="stack--sm">
              <p>{t(`guide.step.${stepKey(currentStep)}Body`)}</p>

              {completed.has(currentStep) && (
                <NoticeBanner tone="success" size="compact" testid="guide-step-done">
                  {t('guide.stepDone')}
                </NoticeBanner>
              )}

              <div className="onboarding__actions">
                <button
                  type="button"
                  className="btn btn--primary"
                  data-testid="guide-provision"
                  disabled={provision.isPending}
                  aria-busy={provision.isPending}
                  onClick={() => provision.mutate(currentStep)}
                >
                  {provision.isPending ? t('guide.provisionRunning') : t('guide.provision')}
                </button>
                <Link
                  to={selfServePath(currentStep).to as never}
                  search={selfServePath(currentStep).search as never}
                  className="btn"
                  data-testid="guide-self-serve"
                >
                  {t('guide.selfServe')}
                </Link>
              </div>
              {provision.error !== null && <ErrorBanner error={provision.error} />}

              <AdoptPicker
                step={currentStep}
                value={adoptPick}
                onChange={setAdoptPick}
                onAdopt={() => adopt.mutate({ step: currentStep, key: adoptPick })}
                pending={adopt.isPending}
                ownerUserId={actor.data?.user.id ?? null}
              />
              {adopt.error !== null && <ErrorBanner error={adopt.error} />}
            </div>
          </Stepper>
        </section>
      )}

      {run !== null && (
        <section className="page__section">
          <Card header={<h2>{t('guide.artifactsTitle')}</h2>} data-testid="guide-artifacts">
            {run.artifacts.length === 0 ? (
              <EmptyState title={t('guide.artifactsEmpty')} size="compact" />
            ) : (
              <ul className="onboarding__artifacts">
                {run.artifacts.map((a) => (
                  <li key={a.id}>
                    <span className="mono">{a.resourceName}</span>{' '}
                    <span className="muted">({a.resourceType})</span>
                    {!a.alive && <span className="muted"> — {t('guide.artifactMissing')}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>
      )}

      <section className="page__section onboarding__cleanup">
        <div className="onboarding__actions">
          <button
            type="button"
            className="btn btn--danger"
            data-testid="guide-cleanup"
            onClick={() => {
              setCleanupScope('mine')
              setCleanupResult(null)
              setCleanupOpen(true)
            }}
          >
            {t('guide.cleanupCta')}
          </button>
          {isAdmin && (
            <button
              type="button"
              className="btn btn--danger"
              data-testid="guide-cleanup-all"
              onClick={() => {
                setCleanupScope('all')
                setCleanupResult(null)
                setCleanupOpen(true)
              }}
            >
              {t('guide.cleanupAdminCta')}
            </button>
          )}
        </div>
        {cleanupResult !== null && <CleanupReport result={cleanupResult} />}
      </section>

      <ConfirmDialog
        open={cleanupOpen}
        title={t('guide.cleanupTitle')}
        tone="danger"
        confirmLabel={t('guide.cleanupConfirm')}
        onClose={() => setCleanupOpen(false)}
        onConfirm={() => cleanup.mutateAsync(cleanupScope).then(() => undefined)}
        description={
          <div className="stack--sm">
            <p>
              {cleanupScope === 'all' ? t('guide.cleanupAdminWarning') : t('guide.cleanupWarning')}
            </p>
            {inventory.isLoading && <LoadingState />}
            {inventory.data !== undefined &&
              (inventory.data.entries.length === 0 ? (
                <p className="muted">{t('guide.cleanupEmpty')}</p>
              ) : (
                <ul className="onboarding__artifacts" data-testid="guide-cleanup-preview">
                  {inventory.data.entries.map((e) => (
                    <li key={`${e.resourceType}:${e.resourceId}`}>
                      <span className="mono">{e.resourceName}</span>{' '}
                      <span className="muted">({e.resourceType})</span>
                    </li>
                  ))}
                </ul>
              ))}
          </div>
        }
      />

      <div className="onboarding__skip">
        <Link to="/">{t('nav.home')}</Link>
      </div>
    </div>
  )
}

function CleanupReport(props: { result: ExampleCleanupResult }) {
  const { t } = useTranslation()
  const label = (outcome: string): string =>
    outcome === 'deleted'
      ? t('guide.outcomeDeleted')
      : outcome === 'skipped'
        ? t('guide.outcomeSkipped')
        : t('guide.outcomeFailed')
  return (
    <div className="stack--sm" data-testid="guide-cleanup-report">
      <NoticeBanner tone={props.result.complete ? 'success' : 'warning'} size="compact">
        {props.result.complete ? t('guide.cleanupDone') : t('guide.cleanupPartial')}
      </NoticeBanner>
      {!props.result.complete && (
        <ul className="onboarding__artifacts">
          {props.result.items
            .filter((i) => i.outcome !== 'deleted')
            .map((i) => (
              <li key={`${i.resourceType}:${i.resourceId}`}>
                <span className="mono">{i.resourceName}</span>{' '}
                <span className="muted">
                  ({label(i.outcome)}
                  {i.message !== undefined ? `: ${i.message}` : ''})
                </span>
              </li>
            ))}
        </ul>
      )}
    </div>
  )
}

/**
 * "I built it myself" — pick one of YOUR resources and register it with the
 * tour. The list is filtered to resources you own: adopting flips a row to
 * private and puts it in the cleanup sweep, which must never be possible for
 * somebody else's work.
 */
function AdoptPicker(props: {
  step: OnboardingStep
  value: string
  onChange: (v: string) => void
  onAdopt: () => void
  pending: boolean
  ownerUserId: string | null
}) {
  const { t } = useTranslation()
  const type = stepResourceType(props.step)
  const endpoint =
    type === 'agent'
      ? '/api/agents'
      : type === 'skill'
        ? '/api/skills'
        : type === 'workflow'
          ? '/api/workflows'
          : '/api/workgroups'

  const list = useQuery<Array<Agent | Skill | Workflow | Workgroup>>({
    queryKey: [type === 'workgroup' ? 'workgroups' : `${type}s`],
    queryFn: ({ signal }) => api.get(endpoint, undefined, signal),
  })

  const options = (list.data ?? [])
    .filter((r) => r.ownerUserId === props.ownerUserId && r.example !== true)
    .map((r) => ({
      value: type === 'workflow' ? (r as Workflow).id : r.name,
      label: r.name,
    }))

  if (options.length === 0) return null

  return (
    <div className="onboarding__actions" data-testid="guide-adopt">
      <Select
        value={props.value}
        options={options}
        onChange={props.onChange}
        placeholder={t('guide.selfServe')}
        ariaLabel={t('guide.selfServe')}
        data-testid="guide-adopt-select"
      />
      <button
        type="button"
        className="btn"
        data-testid="guide-adopt-confirm"
        disabled={props.value === '' || props.pending}
        aria-busy={props.pending}
        onClick={props.onAdopt}
      >
        {t('guide.stepDone')}
      </button>
    </div>
  )
}

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: '/onboarding',
  component: OnboardingPage,
})
