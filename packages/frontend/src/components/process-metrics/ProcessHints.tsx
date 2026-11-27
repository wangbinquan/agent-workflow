// RFC-616 §8 — improvement hints. The server decides which rule fired and
// sends its numbers; the sentence is written here, in the reader's language.
// No model is involved in any of this.
import { useTranslation } from 'react-i18next'
import type {
  ProcessGateKind,
  ProcessHint,
  ProcessHintSeverity,
  ProcessSubjectSummary,
} from '@agent-workflow/shared'
import { Card } from '@/components/Card'
import { EmptyState } from '@/components/EmptyState'
import { StatusChip, type StatusChipKind } from '@/components/StatusChip'
import { decimal, duration, percent, pricedCost, tokens, type Translate } from './processFormat'
import { stageNamesOf } from './processNames'
import { viewOfHintTarget, type ProcessView } from './processSearch'

const SEVERITY_CHIP: Readonly<Record<ProcessHintSeverity, StatusChipKind>> = {
  high: 'danger',
  mid: 'warn',
  info: 'info',
}

const numberOf = (value: string | number | null | undefined): number | null =>
  typeof value === 'number' ? value : null

/** The numbers and names of a hint, formatted for its sentence. */
export function hintValues(
  hint: ProcessHint,
  summary: ProcessSubjectSummary,
  t: Translate,
  language: string,
): Record<string, string> {
  const { params } = hint
  const names = stageNamesOf(summary, t, language)
  const share = (key: string) => percent(numberOf(params[key]))
  const time = (key: string) => duration(numberOf(params[key]), t)
  const gate = params.gate as ProcessGateKind | null | undefined
  const stageKey = typeof params.stageKey === 'string' ? params.stageKey : null
  return {
    unit: t(`processMetrics.unit.${summary.kind}`),
    stage: stageKey === null ? '—' : (names.get(stageKey) ?? stageKey),
    gate: gate ? t(`processMetrics.wait.${gate}`) : '',
    share: share('share'),
    gateShare: share('gateShare'),
    rate: share('rate'),
    codeShare: share('codeShare'),
    failureRate: share('failureRate'),
    p50: time('p50'),
    p90: time('p90'),
    rounds: decimal(numberOf(params.rounds)),
    extraRounds: decimal(numberOf(params.extraRounds)),
    answered: String(params.answered ?? '—'),
    units: String(params.units ?? '—'),
    current: String(params.current ?? 0),
    tokens: tokens(numberOf(params.tokens)),
    cost: pricedCost(numberOf(params.costNano), summary.note.unpriced, t),
    code: typeof params.code === 'string' ? params.code : '',
  }
}

/** Which of a hint's alternative sentences applies, from what its numbers contain. */
function bodyKey(hint: ProcessHint): string {
  if (hint.id === 'wait-dominant') return hint.params.gate ? 'body' : 'bodyPlain'
  if (hint.id === 'auto-retry-high') return hint.params.code ? 'body' : 'bodyPlain'
  return 'body'
}

export function ProcessHints(props: {
  summary: ProcessSubjectSummary
  /** Show only the first few and a link to the rest. */
  limit?: number
  onView: (view: ProcessView) => void
}) {
  const { t, i18n } = useTranslation()
  const { summary } = props
  const hints = props.limit === undefined ? summary.hints : summary.hints.slice(0, props.limit)
  return (
    <Card
      title={t('processMetrics.hints.title')}
      header={
        <p className="muted process-metrics__note">
          {t(
            props.limit !== undefined && summary.hints.length > props.limit
              ? 'processMetrics.hints.subtitleTop'
              : 'processMetrics.hints.subtitle',
            { count: props.limit },
          )}
        </p>
      }
    >
      {hints.length === 0 ? (
        <EmptyState
          size="compact"
          title={t('processMetrics.hints.empty')}
          description={t('processMetrics.hints.emptyHint')}
        />
      ) : (
        <ul className="process-hints">
          {hints.map((hint) => {
            const values = hintValues(hint, summary, t, i18n.language)
            const view = viewOfHintTarget(summary.kind, hint.target)
            return (
              <li key={hint.id} className="process-hint" data-hint={hint.id}>
                <StatusChip kind={SEVERITY_CHIP[hint.severity]}>
                  {t(`processMetrics.hints.severity.${hint.severity}`)}
                </StatusChip>
                <p className="process-hint__title">
                  {t(`processMetrics.hint.${hint.id}.title`, values)}
                </p>
                <p className="process-hint__body">
                  {t(`processMetrics.hint.${hint.id}.${bodyKey(hint)}`, values)}
                </p>
                {view === 'overview' ? null : (
                  <p className="process-hint__go">
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm"
                      onClick={() => props.onView(view)}
                    >
                      {t('processMetrics.hints.go', {
                        view: t(
                          view === 'units'
                            ? `processMetrics.view.units.${summary.kind}`
                            : `processMetrics.view.${view}`,
                        ),
                      })}
                    </button>
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {props.limit !== undefined ? (
        <p>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => props.onView('insights')}
          >
            {t('processMetrics.hints.all')}
          </button>
        </p>
      ) : null}
    </Card>
  )
}
