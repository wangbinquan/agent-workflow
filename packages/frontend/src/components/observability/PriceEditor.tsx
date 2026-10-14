// RFC-371 v2 §3.3 — edit one (runtime, model) price line. Saving appends a new
// version compared against the newest one this draft was based on; on a
// conflict the draft stays and the latest version can be adopted as the base.
import { useId, useRef, useState, type RefObject } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { ObservationPrice, SaveObservationPrice } from '@agent-workflow/shared'
import { ApiError } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextInput } from '@/components/Form'
import { NoticeBanner } from '@/components/NoticeBanner'
import { UnsavedChangesGuard } from '@/components/split/UnsavedChangesGuard'
import { PRICING_QUERY, pricingApi } from './observationClient'
import {
  initialPriceDraft,
  preparePrice,
  PRICE_BUCKETS,
  type PriceDraft,
  type PriceDraftErrors,
} from './priceDraft'

export function PriceEditor(props: {
  runtime: { readonly runtimeId: string; readonly name: string }
  /** null: pricing a model that has no line yet (typed by the administrator). */
  model: string | null
  current: ObservationPrice | null
  triggerRef: RefObject<HTMLElement | null>
  onClose: () => void
}) {
  const { t, i18n } = useTranslation()
  const queryClient = useQueryClient()
  const formId = useId()
  const [initial] = useState(() => initialPriceDraft(props.model ?? '', props.current))
  const [draft, setDraft] = useState<PriceDraft>(initial)
  const [base, setBase] = useState<string | null>(props.current?.id ?? null)
  const [errors, setErrors] = useState<PriceDraftErrors>({})
  const [latest, setLatest] = useState<ObservationPrice | null>(null)
  const [reloadError, setReloadError] = useState<unknown>(null)
  const dirty = useRef<string | null>(null)
  const busy = useRef(false)
  const save = useMutation({
    mutationFn: (input: SaveObservationPrice) => pricingApi.save(props.runtime.runtimeId, input),
    onSuccess: () => {
      dirty.current = null
      void queryClient.invalidateQueries({ queryKey: PRICING_QUERY })
      props.onClose()
    },
  })
  busy.current = save.isPending
  dirty.current = JSON.stringify(draft) !== JSON.stringify(initial) ? 'observation-price' : null
  const conflict = save.error instanceof ApiError && save.error.code === 'price-conflict'
  const submit = () => {
    if (save.isPending) return
    const prepared = preparePrice(draft, base, Date.now())
    setErrors(prepared.errors)
    if (prepared.input) save.mutate(prepared.input)
  }
  const loadLatest = async () => {
    setReloadError(null)
    try {
      const history = await pricingApi.history(props.runtime.runtimeId, draft.model.trim())
      setLatest(history.items[0] ?? null)
    } catch (error) {
      setReloadError(error)
    }
  }
  const rate = (value: string | null) =>
    value === null
      ? t('observationPricing.unpriced')
      : t('observationPricing.rate', { rate: value })
  const field = (key: keyof PriceDraft, label: string, hint?: string) => (
    <Field
      key={key}
      label={label}
      labelId={`${formId}-${key}-label`}
      errorId={`${formId}-${key}-error`}
      {...(hint ? { hint } : {})}
      {...(errors[key as keyof PriceDraftErrors]
        ? { error: t(errors[key as keyof PriceDraftErrors]!) }
        : {})}
    >
      <TextInput
        value={draft[key]}
        onChange={(value) => setDraft((current) => ({ ...current, [key]: value }))}
        disabled={save.isPending || (key === 'model' && props.model !== null)}
        type={key === 'effectiveFrom' ? 'datetime-local' : 'text'}
        aria-invalid={Boolean(errors[key as keyof PriceDraftErrors])}
        aria-labelledby={`${formId}-${key}-label`}
        {...(errors[key as keyof PriceDraftErrors]
          ? { 'aria-describedby': `${formId}-${key}-error` }
          : {})}
      />
    </Field>
  )
  return (
    <>
      <UnsavedChangesGuard
        dirtyRef={dirty}
        busyRef={busy}
        onDiscard={() => {
          dirty.current = null
        }}
      />
      <Dialog
        open
        size="lg"
        title={
          props.model === null
            ? t('observationPricing.addTitle', { runtime: props.runtime.name })
            : t('observationPricing.editTitle', { runtime: props.runtime.name, model: props.model })
        }
        onClose={props.onClose}
        triggerRef={props.triggerRef}
        dismissDisabled={save.isPending}
        footer={
          <>
            <button type="button" className="btn" disabled={save.isPending} onClick={props.onClose}>
              {t('common.cancel')}
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={save.isPending}
              onClick={submit}
            >
              {save.isPending ? t('observationPricing.saving') : t('observationPricing.save')}
            </button>
          </>
        }
      >
        <div className="stack--md">
          <p className="muted">{t('observationPricing.hint')}</p>
          {conflict ? (
            <NoticeBanner tone="warning">
              <div className="stack--sm">
                <p>{t('observationPricing.conflict')}</p>
                {latest ? (
                  <>
                    <p>
                      {t('observationPricing.latest', {
                        input: rate(latest.rates.input),
                        cacheRead: rate(latest.rates.cacheRead),
                        cacheWrite: rate(latest.rates.cacheWrite),
                        output: rate(latest.rates.output),
                        time: new Date(latest.createdAt).toLocaleString(i18n.language),
                      })}
                    </p>
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => {
                        setBase(latest.id)
                        setLatest(null)
                        save.reset()
                      }}
                    >
                      {t('observationPricing.useLatest')}
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn btn--sm" onClick={() => void loadLatest()}>
                    {t('observationPricing.loadLatest')}
                  </button>
                )}
              </div>
            </NoticeBanner>
          ) : save.error ? (
            <ErrorBanner error={save.error} />
          ) : null}
          {reloadError ? <ErrorBanner error={reloadError} /> : null}
          {field('model', t('observationPricing.model'), t('observationPricing.modelHint'))}
          <div className="form-grid form-grid--cols-2">
            {PRICE_BUCKETS.map((bucket) =>
              field(bucket, t(`observationPricing.${bucket}`), t('observationPricing.rateHint')),
            )}
          </div>
          {field(
            'effectiveFrom',
            t('observationPricing.effectiveFrom'),
            t('observationPricing.effectiveFromHint'),
          )}
          {field('note', t('observationPricing.note'))}
        </div>
      </Dialog>
    </>
  )
}
