import { useEffect, useId, useRef, useState, type RefObject } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { ObservationPricingRuntime, SaveObservationPrice } from '@agent-workflow/shared'
import { ApiError } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextInput } from '@/components/Form'
import { UnsavedChangesGuard } from '@/components/split/UnsavedChangesGuard'
import {
  initialPriceDraft,
  preparePriceRequest,
  PRICE_BUCKETS,
  type SubmittedPrice,
} from './priceDraft'
import { PRICING_QUERY, runtimePrices } from './priceClient'

export function PriceEditor(props: {
  runtime: ObservationPricingRuntime
  open: boolean
  triggerRef: RefObject<HTMLElement | null>
  onClose: () => void
  onSaved: () => void
  onClear: () => void
  onDirty: (dirty: boolean) => void
}) {
  const { t } = useTranslation(),
    qc = useQueryClient()
  const formId = useId()
  const [runtime, setRuntime] = useState(props.runtime),
    [initial] = useState(() => initialPriceDraft(runtime, Date.now()))
  const [draft, setDraft] = useState(initial),
    [revision, setRevision] = useState(runtime.pricingRevision)
  const [errors, setErrors] = useState<Readonly<Record<string, string>>>({}),
    [latest, setLatest] = useState<ObservationPricingRuntime>()
  const [reloadError, setReloadError] = useState<unknown>(null)
  const receipt = useRef<SubmittedPrice | undefined>(undefined),
    busy = useRef(false),
    dirty = useRef<string | null>(null),
    busySince = useRef<number | null>(null)
  const save = useMutation({
    mutationFn: (input: SaveObservationPrice) => runtimePrices.save(runtime.registrationId, input),
    onSuccess: () => {
      dirty.current = null
      props.onSaved()
      void qc.invalidateQueries({ queryKey: PRICING_QUERY })
    },
  })
  const isDirty = JSON.stringify(initial) !== JSON.stringify(draft)
  dirty.current = isDirty || save.isPending ? 'runtime-token-price' : null
  const onDirty = props.onDirty
  useEffect(() => {
    onDirty(isDirty || save.isPending)
    return () => onDirty(false)
  }, [isDirty, save.isPending, onDirty])
  const submit = async () => {
    if (busy.current) return
    const prepared = preparePriceRequest(
      draft,
      runtime,
      revision,
      receipt.current,
      Date.now(),
      () => crypto.randomUUID(),
    )
    setErrors(prepared.errors)
    if (!prepared.receipt) return
    receipt.current = prepared.receipt
    busy.current = true
    busySince.current = Date.now()
    try {
      await save.mutateAsync(prepared.receipt.input)
    } catch {
      /* mutation error is visible */
    } finally {
      busy.current = false
      busySince.current = null
    }
  }
  const compare = async () => {
    setLatest(undefined)
    setReloadError(null)
    try {
      const [directory, history] = await Promise.all([
        runtimePrices.directory(),
        runtimePrices.history(runtime.registrationId),
      ])
      const current = directory.runtimes.find(
        (row) => row.registrationId === runtime.registrationId,
      )
      if (!current) throw new Error(t('observationPricing.reloadFailed'))
      setLatest({ ...current, pricingRevision: history.revision })
    } catch (error) {
      setReloadError(error)
    }
  }
  const canCompare =
    save.error instanceof ApiError &&
    ['price-conflict', 'runtime-changed'].includes(save.error.code)
  return (
    <>
      <UnsavedChangesGuard
        dirtyRef={dirty}
        busyRef={busy}
        busySinceRef={busySince}
        onDiscard={() => {
          dirty.current = null
          props.onClear()
        }}
      />
      <Dialog
        open={props.open}
        title={t('observationPricing.editTitle', { name: runtime.name })}
        onClose={props.onClose}
        triggerRef={props.triggerRef}
        dismissDisabled={save.isPending}
        size="lg"
        footer={
          <>
            <button className="btn" disabled={save.isPending} onClick={props.onClear}>
              {t('observationPricing.clear')}
            </button>
            <button className="btn" disabled={save.isPending} onClick={props.onClose}>
              {t('common.close')}
            </button>
            <button
              className="btn btn--primary"
              disabled={save.isPending}
              onClick={() => void submit()}
            >
              {t('observationPricing.save')}
            </button>
          </>
        }
      >
        <div className="stack--md">
          <p>
            {t('observationPricing.versionHint', {
              revision,
              configurationRevision: runtime.configurationRevision,
            })}
          </p>
          {save.error ? <ErrorBanner error={save.error} /> : null}
          {canCompare ? (
            <button className="btn" onClick={() => void compare()}>
              {t('observationPricing.compare')}
            </button>
          ) : null}
          {reloadError ? (
            <ErrorBanner error={reloadError} message={t('observationPricing.reloadFailed')} />
          ) : null}
          {latest ? (
            <>
              <p>
                {t('observationPricing.latest', {
                  ...latest,
                  revision: latest.pricingRevision,
                  model: latest.model ?? '—',
                })}
              </p>
              <button
                className="btn"
                onClick={() => {
                  setRuntime(latest)
                  setRevision(latest.pricingRevision)
                  setLatest(undefined)
                  receipt.current = undefined
                  save.reset()
                }}
              >
                {t('observationPricing.useLatest')}
              </button>
            </>
          ) : null}
          <div className="form-grid form-grid--cols-2">
            {(
              [
                'provider',
                'model',
                'condition',
                'effectiveFrom',
                ...PRICE_BUCKETS,
                'sourceNote',
              ] as const
            ).map((key) => (
              <Field
                key={key}
                label={t('observationPricing.' + key)}
                labelId={formId + '-' + key + '-label'}
                errorId={formId + '-' + key + '-error'}
                {...(errors[key] ? { error: t(errors[key]!) } : {})}
                {...(PRICE_BUCKETS.includes(key as (typeof PRICE_BUCKETS)[number])
                  ? { hint: t('observationPricing.rateHint') }
                  : {})}
              >
                <TextInput
                  value={draft[key]}
                  onChange={(value) => setDraft((current) => ({ ...current, [key]: value }))}
                  disabled={save.isPending}
                  type={key === 'effectiveFrom' ? 'datetime-local' : 'text'}
                  aria-invalid={Boolean(errors[key])}
                  aria-labelledby={formId + '-' + key + '-label'}
                  {...(errors[key] ? { 'aria-describedby': formId + '-' + key + '-error' } : {})}
                />
              </Field>
            ))}
          </div>
        </div>
      </Dialog>
    </>
  )
}
