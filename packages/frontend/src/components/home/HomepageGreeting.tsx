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
import type { RuntimeStatusEntry, RuntimesStatusResponse } from '@agent-workflow/shared'
import { api } from '@/api/client'
import { pickGreetingKey } from '@/lib/homepage'

export const RUNTIMES_STATUS_HOME_QUERY_KEY = ['runtimes', 'status', 'home'] as const

/** RFC-135 D7: dot color semantics, decoupled from the failure reason. */
type Severity = 'ok' | 'fault' | 'soft' | 'checking'

interface RuntimeItemView {
  key: string
  severity: Severity
  muted: boolean
  text: string
}

type RuntimesView =
  | { kind: 'single'; severity: Severity; text: string }
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

  const view = describeRuntimes(t, probe)
  const greetingKey = `home.greet.${pickGreetingKey(now)}` as const

  return (
    <header className="homepage__greet">
      <div className="homepage__greet-text">
        <h1 className="homepage__greet-title">{t(greetingKey)}</h1>
        <p className="homepage__greet-runtime" data-testid="homepage-runtime">
          <Link to="/settings" hash="runtime" className="homepage__runtime-link">
            {view.kind === 'single' ? (
              <>
                <Dot severity={view.severity} /> {view.text}
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
                </span>
              ))
            )}
          </Link>
        </p>
      </div>
      <Link
        to="/tasks/new"
        className="btn btn--primary homepage__start-task"
        data-testid="homepage-start-task"
      >
        {t('home.startTask')}
      </Link>
    </header>
  )
}

function Dot({ severity }: { severity: Severity }) {
  return (
    <span
      className={`homepage__runtime-dot homepage__runtime-dot--${severity}`}
      aria-hidden="true"
    />
  )
}

/** ok → green; missing default → fault; missing non-default → soft (D3). */
function itemSeverity(row: Pick<RuntimeStatusEntry, 'ok' | 'isDefault'>): Severity {
  if (row.ok) return 'ok'
  return row.isDefault ? 'fault' : 'soft'
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
    const ok = rows.filter((r) => r.ok).length
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
    const worst = fault ?? rows.find((r) => !r.ok)
    return {
      kind: 'single',
      severity: fault !== undefined ? 'fault' : 'soft',
      text: t('home.runtime.aggregateWorst', {
        ok,
        total: rows.length,
        name: worst?.name ?? '',
      }),
    }
  }
  return {
    kind: 'items',
    items: rows.map((row) => ({
      key: row.name,
      severity: itemSeverity(row),
      muted: !row.ok && !row.isDefault,
      text: row.ok
        ? row.version !== null
          ? t('home.runtime.item.ready', { name: row.name, version: row.version })
          : t('home.runtime.item.readyNoVersion', { name: row.name })
        : t('home.runtime.item.missing', { name: row.name }),
    })),
  }
}

export const __test__ = { describeRuntimes, itemSeverity, AGGREGATE_THRESHOLD }
