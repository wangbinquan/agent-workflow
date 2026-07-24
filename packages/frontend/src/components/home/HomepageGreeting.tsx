// RFC-032 PR3: homepage hero. RFC-135: multi-runtime status line.
//
// Top of the dashboard: a time-of-day greeting, the runtime status line,
// and the "Start task" primary action. The status line reads the runtime
// REGISTRY (GET /api/runtimes/status — every enabled runtime probed live
// against the binary a dispatch would use) instead of the pre-registry
// single-opencode probe. Availability is version-gate free (RFC-135 D3):
// a runtime is ok iff its `--version` ran, and severity is decoupled from
// the reason — a missing DEFAULT runtime is a fault (red), a missing
// non-default one is soft (grey, muted), so an opencode-only install never
// shows a standing red dot for the unused claude-code builtin.
//
// The query key is homepage-scoped so it does not drag the Settings runtime
// list into a refetch storm.

import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  OverviewTasks,
  RuntimeStatusEntry,
  RuntimesStatusResponse,
} from '@agent-workflow/shared'
import { isExecutionIdentityFailureCode } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { NoticeBanner } from '@/components/NoticeBanner'
import { hasSeenTour } from '@/components/tour/SpotlightTour'
import { pickGreetingKey } from '@/lib/homepage'
import { describeTaskFailure } from '@/lib/task-failure'
import { PipelineHero } from './PipelineHero'
import { useOverview } from './useOverview'

export const RUNTIMES_STATUS_HOME_QUERY_KEY = ['runtimes', 'status', 'home'] as const

/**
 * RFC-211: an invitation to the guided tour for anyone who has never taken it.
 *
 * The first-run screen it complements is INSTANCE-level (it only renders while
 * the whole instance has no agents and no workflows), so the second person to
 * join a team would never have seen it. This one is keyed off the current
 * user's own tour history instead, and disappears by itself once they start a
 * track — no dismissal state to store, nothing to get stale.
 */
function FirstVisitGuidePrompt() {
  const { t } = useTranslation()
  // Show the invitation until the user has started the spotlight tour at least
  // once. The tour records that in localStorage (see SpotlightTour.tsx); this is
  // a soft nudge, so a per-browser flag is enough — no server round-trip.
  if (hasSeenTour()) return null
  return (
    <div className="stack-top--sm">
      <NoticeBanner
        tone="info"
        size="compact"
        testid="homepage-guide-prompt"
        action={
          <Link to="/onboarding" className="btn btn--sm" data-testid="homepage-guide-prompt-cta">
            {t('onboarding.startCta')}
          </Link>
        }
      >
        {t('onboarding.tracksIntro')}
      </NoticeBanner>
    </div>
  )
}

/** RFC-135 D7: dot color semantics, decoupled from the failure reason. */
type Severity = 'ok' | 'fault' | 'soft' | 'checking'

interface RuntimeItemView {
  key: string
  severity: Severity
  muted: boolean
  text: string
  failure?: RuntimeFailureView
}

interface RuntimeFailureView {
  title: string
  hint?: string
}

type RuntimesView =
  | { kind: 'single'; severity: Severity; text: string; failure?: RuntimeFailureView }
  | { kind: 'items'; items: RuntimeItemView[] }

/**
 * Above this many enabled runtimes the hero line collapses to an aggregate
 * count (single-line width budget — design D1; not a config knob).
 */
const AGGREGATE_THRESHOLD = 3

export function HomepageGreeting() {
  const { t } = useTranslation()
  // The clock ticks roughly every minute so the greeting + relative date
  // line stays current without flooding the renderer.
  const [now, setNow] = useState<Date>(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  const probe = useQuery<RuntimesStatusResponse>({
    queryKey: RUNTIMES_STATUS_HOME_QUERY_KEY,
    queryFn: ({ signal }) => api.get('/api/runtimes/status', undefined, signal),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })

  // RFC-190: task pulse line under the runtime status (shared /api/overview
  // query with CapabilityGrid; the whole line is omitted when tasks stats are
  // unavailable — no permission, still loading, or fetch failed).
  const overview = useOverview()
  const pulse = describePulse(t, overview.data?.tasks ?? null)
  const view = describeRuntimes(t, probe)
  const greetingKey = `home.greet.${pickGreetingKey(now)}` as const

  return (
    <header className="homepage__greet">
      <div className="homepage__greet-text">
        <h1 className="homepage__greet-title">{t(greetingKey)}</h1>
        <p className="homepage__greet-runtime" data-testid="homepage-runtime">
          <Link to="/settings" search={{ tab: 'runtime' }} className="homepage__runtime-link">
            {view.kind === 'single' ? (
              <>
                <Dot severity={view.severity} /> {view.text}
                <RuntimeFailure failure={view.failure} />
              </>
            ) : (
              view.items.map((item, i) => (
                <span key={item.key} className="homepage__runtime-item">
                  {i > 0 && (
                    <span className="homepage__runtime-sep" aria-hidden="true">
                      ·
                    </span>
                  )}
                  <Dot severity={item.severity} />
                  <span className={item.muted ? 'muted' : undefined}>{item.text}</span>
                  <RuntimeFailure failure={item.failure} />
                </span>
              ))
            )}
          </Link>
        </p>
        {pulse !== null && (
          <p className="homepage__pulse muted" data-testid="homepage-pulse">
            {pulse}
          </p>
        )}
        <div className="homepage__cta">
          <Link
            to="/tasks/new"
            className="btn btn--primary homepage__start-task"
            data-testid="homepage-start-task"
          >
            {t('home.startTask')}
          </Link>
          <Link
            to="/workflows"
            search={{ create: true }}
            className="btn"
            data-testid="homepage-new-workflow"
          >
            {t('home.newWorkflow')}
          </Link>
          {/* RFC-211: the guided tour is a PERMANENT entry point, not a
              first-run one. The first-run surface only appears while the whole
              instance is empty, so a second user joining a populated instance
              would otherwise never be offered it. */}
          <Link to="/onboarding" className="btn" data-testid="homepage-onboarding">
            {t('onboarding.startCta')}
          </Link>
        </div>
        <FirstVisitGuidePrompt />
      </div>
      <PipelineHero />
    </header>
  )
}

/**
 * RFC-190 — pulse copy: running / awaiting / 7d-done, with the success rate
 * appended only when the 7d window has outcomes (done+failed > 0). Returns
 * null when stats are absent so the caller can drop the whole line.
 */
function describePulse(
  t: (key: string, opts?: Record<string, unknown>) => string,
  tasks: OverviewTasks | null,
): string | null {
  if (tasks === null) return null
  const outcomes = tasks.done7d + tasks.failed7d
  if (outcomes > 0) {
    return t('home.pulse.line', {
      running: tasks.running,
      awaiting: tasks.awaiting,
      done: tasks.done7d,
      rate: Math.round((tasks.done7d / outcomes) * 100),
    })
  }
  return t('home.pulse.lineNoRate', {
    running: tasks.running,
    awaiting: tasks.awaiting,
    done: tasks.done7d,
  })
}

function Dot({ severity }: { severity: Severity }) {
  return (
    <span
      className={`homepage__runtime-dot homepage__runtime-dot--${severity}`}
      aria-hidden="true"
    />
  )
}

function RuntimeFailure({ failure }: { failure?: RuntimeFailureView }) {
  if (failure === undefined) return null
  return (
    <span className="homepage__runtime-failure">
      {' — '}
      {failure.title}
      {failure.hint !== undefined && ` ${failure.hint}`}
    </span>
  )
}

/** RFC-227 degraded is visible even though policy permits execution. */
function itemSeverity(row: Pick<RuntimeStatusEntry, 'ok' | 'isDefault' | 'state'>): Severity {
  if (row.state === 'degraded') return 'soft'
  if (row.ok) return 'ok'
  return row.isDefault ? 'fault' : 'soft'
}

function runtimeFailure(row: RuntimeStatusEntry): RuntimeFailureView | undefined {
  if (row.ok || !isExecutionIdentityFailureCode(row.failureCode)) return undefined
  const copy = describeTaskFailure({ failureCode: row.failureCode })
  return {
    title: copy.title,
    ...(copy.hint !== undefined ? { hint: copy.hint } : {}),
  }
}

function runtimeItemText(
  t: (key: string, opts?: Record<string, unknown>) => string,
  row: RuntimeStatusEntry,
): string {
  const state = row.state ?? (row.ok ? 'ready' : 'not-found')
  switch (state) {
    case 'ready':
      return row.version !== null
        ? t('home.runtime.item.ready', { name: row.name, version: row.version })
        : t('home.runtime.item.readyNoVersion', { name: row.name })
    case 'available-unverified':
      return row.version !== null
        ? t('home.runtime.item.availableUnverifiedVersion', {
            name: row.name,
            version: row.version,
          })
        : t('home.runtime.item.availableUnverified', { name: row.name })
    case 'unlaunchable':
      return t('home.runtime.item.unlaunchable', { name: row.name })
    case 'protocol-incompatible':
      return t('home.runtime.item.protocolIncompatible', { name: row.name })
    case 'containment-blocked':
      return t('home.runtime.item.containmentBlocked', { name: row.name })
    case 'degraded':
      return t('home.runtime.item.degraded', { name: row.name })
    case 'not-found':
      return t('home.runtime.item.missing', { name: row.name })
  }
}

function describeRuntimes(
  t: (key: string, opts?: Record<string, unknown>) => string,
  probe: {
    isLoading: boolean
    data?: RuntimesStatusResponse
  },
): RuntimesView {
  if (probe.isLoading || !probe.data) {
    return { kind: 'single', severity: 'checking', text: t('home.runtime.checking') }
  }
  const rows = probe.data.runtimes
  if (rows.length === 0) {
    // Every runtime disabled — not a fault per se, but nothing can dispatch.
    return { kind: 'single', severity: 'soft', text: t('home.runtime.noneEnabled') }
  }
  if (rows.length > AGGREGATE_THRESHOLD) {
    // A policy-permitted degraded runtime remains executable, but it is not
    // healthy. Counting it green in the collapsed view would hide the exact
    // cross-platform containment warning that the expanded view exposes.
    const ok = rows.filter((r) => r.ok && r.state !== 'degraded').length
    if (ok === rows.length) {
      return {
        kind: 'single',
        severity: 'ok',
        text: t('home.runtime.aggregate', { ok, total: rows.length }),
      }
    }
    // Name the WORST failure, not the first one — a soft grey row must not
    // shadow a red default-runtime fault (design D1 / Codex gate F5).
    const fault = rows.find((r) => !r.ok && r.isDefault)
    const worst = fault ?? rows.find((r) => !r.ok) ?? rows.find((r) => r.state === 'degraded')
    const failure = worst === undefined ? undefined : runtimeFailure(worst)
    return {
      kind: 'single',
      severity: fault !== undefined ? 'fault' : 'soft',
      text: t('home.runtime.aggregateWorst', {
        ok,
        total: rows.length,
        name: worst?.name ?? '',
      }),
      ...(failure !== undefined ? { failure } : {}),
    }
  }
  return {
    kind: 'items',
    items: rows.map((row) => {
      const failure = runtimeFailure(row)
      return {
        key: row.name,
        severity: itemSeverity(row),
        muted: !row.ok && !row.isDefault,
        ...(failure !== undefined ? { failure } : {}),
        text: runtimeItemText(t, row),
      }
    }),
  }
}

export const __test__ = { describeRuntimes, itemSeverity, AGGREGATE_THRESHOLD, describePulse }
