// RFC-080 PR-B — KindSelect: the single shared control for editing an
// output-port kind. Reused by the agent form (OutputsEditor) and the canvas
// wrapper-fanout inspector (NodeInspector), replacing the bespoke 3-option
// <select> and the raw <TextInput>.
//
// The base dropdown enumerates OUTPUT_KIND_UI (shared catalog) — adding a new
// base kind there makes it appear here automatically. Guided mode covers the
// common grammar (base / path<ext> / list<base> / list<path<ext>>); nested or
// hand-edited kinds fall to an advanced raw-text field that validates live via
// the shared grammar and never silently rewrites the user's input.

import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  tryParseKind,
  parseKind,
  stringifyKind,
  isRegisteredKindString,
  listSelectableKinds,
  listSelectablePathExts,
  isSelectablePathExt,
  type ParsedKind,
} from '@agent-workflow/shared'
import { Select } from './Select'
import { Switch, TextInput } from './Form'

export interface KindSelectProps {
  /** Canonical kind string; '' / 'string' are treated as base string. */
  value: string
  /** Always called with a canonical `stringifyKind(...)` form. */
  onChange: (kind: string) => void
  ariaLabel?: string
  disabled?: boolean
  testidPrefix?: string
  /** Extra classes appended to the real outer `.kind-select` wrapper. */
  className?: string
  /** Reports whether the current guided/advanced value can be committed. */
  onValidityChange?: (valid: boolean) => void
  /** Distinguishes repeated controls in accessible names (for example a port name). */
  contextLabel?: string
  /** Additional schema-level error when the generic kind grammar still parses. */
  validationError?: string
  /** Whether the rendered error is a live alert. Defaults to true. */
  errorLive?: boolean
  /** Called when the user edits the advanced raw value. */
  onEdit?: () => void
}

type Guided = { mode: 'guided'; listWrap: boolean; leafId: string; ext: string }
type Decomposed = Guided | { mode: 'advanced' }

const SELECTABLE = listSelectableKinds()
const SELECTABLE_IDS = new Set(SELECTABLE.map((d) => d.id))
const PATH_EXTS = listSelectablePathExts()

/** Break a canonical kind string into the guided controls, or 'advanced'. */
export function decompose(value: string): Decomposed {
  const parsed = tryParseKind(value === '' ? 'string' : value)
  if (parsed === null) return { mode: 'advanced' }
  let listWrap = false
  let leaf: ParsedKind = parsed
  if (parsed.kind === 'list') {
    listWrap = true
    leaf = parsed.item
  }
  if (leaf.kind === 'base') {
    // Only the selectable base kinds (string/markdown/signal) are guided.
    if (!SELECTABLE_IDS.has(leaf.name)) return { mode: 'advanced' }
    return { mode: 'guided', listWrap, leafId: leaf.name, ext: '*' }
  }
  if (leaf.kind === 'path') {
    // Only the built-in PATH_EXT_UI extensions are guided; an ad-hoc ext
    // (e.g. path<xml>) round-trips through the advanced raw-text field until
    // it's promoted into the catalog. Mirrors the unknown-base-kind fallback.
    if (!isSelectablePathExt(leaf.ext)) return { mode: 'advanced' }
    return { mode: 'guided', listWrap, leafId: 'path', ext: leaf.ext }
  }
  // Nested list<list<…>> or any other shape → advanced.
  return { mode: 'advanced' }
}

export function recompose(listWrap: boolean, leafId: string, ext: string): string {
  const leaf: ParsedKind =
    leafId === 'path'
      ? { kind: 'path', ext: ext === '' ? '*' : ext }
      : { kind: 'base', name: leafId }
  const full: ParsedKind = listWrap ? { kind: 'list', item: leaf } : leaf
  return stringifyKind(full)
}

export function KindSelect({
  value,
  onChange,
  ariaLabel,
  disabled,
  testidPrefix,
  className,
  onValidityChange,
  contextLabel,
  validationError,
  errorLive = true,
  onEdit,
}: KindSelectProps) {
  const { t } = useTranslation()
  const decomposed = decompose(value)
  const [forceAdvanced, setForceAdvanced] = useState(false)
  const [advRaw, setAdvRaw] = useState(value)
  const advancedErrorId = useId()

  // Keep the advanced buffer in sync when the value changes from outside.
  useEffect(() => {
    setAdvRaw(value)
  }, [value])

  const isAdvanced = forceAdvanced || decomposed.mode === 'advanced'
  const advValid = isRegisteredKindString(advRaw)
  // `onValidityChange` reports the generic grammar only. Callers can layer a
  // stricter schema through `validationError` without creating a feedback
  // loop between their validity state and this callback.
  const valid = !isAdvanced || advValid
  const validityCallbackRef = useRef(onValidityChange)
  validityCallbackRef.current = onValidityChange

  // Depend only on the boolean value: callers commonly pass an inline state
  // setter wrapper, and depending on its identity would report every render
  // (or loop when that callback updates parent state).
  useEffect(() => {
    validityCallbackRef.current?.(valid)
  }, [valid])

  const tid = (s: string) => (testidPrefix !== undefined ? `${testidPrefix}-${s}` : undefined)
  const contextualize = (label: string) =>
    contextLabel === undefined || contextLabel === '' ? label : `${contextLabel} — ${label}`
  const rootClassName = ['kind-select', isAdvanced ? 'kind-select--advanced' : undefined, className]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' ')

  if (isAdvanced) {
    const displayedError = !advValid ? t('kindSelect.parseError') : validationError
    return (
      <div className={rootClassName}>
        <TextInput
          value={advRaw}
          onChange={(v) => {
            onEdit?.()
            setAdvRaw(v)
            if (isRegisteredKindString(v)) onChange(stringifyKind(parseKind(v)))
          }}
          placeholder="list<path<md>>"
          disabled={disabled}
          aria-label={contextualize(ariaLabel ?? t('kindSelect.baseLabel'))}
          aria-invalid={displayedError !== undefined}
          aria-describedby={displayedError === undefined ? undefined : advancedErrorId}
          data-testid={tid('advanced-input')}
        />
        {displayedError !== undefined && (
          <div
            id={advancedErrorId}
            className="kind-select__error"
            role={errorLive ? 'alert' : undefined}
          >
            {displayedError}
          </div>
        )}
        {decompose(advRaw).mode === 'guided' && (
          <button
            type="button"
            className="btn btn--xs"
            onClick={() => setForceAdvanced(false)}
            disabled={disabled}
            aria-label={contextualize(t('kindSelect.guidedToggle'))}
          >
            {t('kindSelect.guidedToggle')}
          </button>
        )}
      </div>
    )
  }

  const g = decomposed as Guided
  const isPath = g.leafId === 'path'

  return (
    <div className={rootClassName} aria-label={ariaLabel}>
      <div className="kind-select__row">
        <Select<string>
          value={g.leafId}
          onChange={(leafId) => onChange(recompose(g.listWrap, leafId, g.ext))}
          options={SELECTABLE.map((d) => ({
            value: d.id,
            label: t(d.labelKey),
            description: t(d.descriptionKey),
          }))}
          ariaLabel={contextualize(ariaLabel ?? t('kindSelect.baseLabel'))}
          disabled={disabled}
        />
        {isPath && (
          <span className="kind-select__ext">
            <Select<string>
              value={g.ext}
              onChange={(ext) => onChange(recompose(g.listWrap, g.leafId, ext))}
              options={PATH_EXTS.map((e) => ({ value: e.ext, label: t(e.labelKey) }))}
              ariaLabel={contextualize(t('kindSelect.extLabel'))}
              disabled={disabled}
            />
          </span>
        )}
        <Switch
          checked={g.listWrap}
          onChange={(listWrap) => onChange(recompose(listWrap, g.leafId, g.ext))}
          label={t('kindSelect.listToggle')}
          aria-label={contextualize(t('kindSelect.listToggle'))}
          disabled={disabled}
        />
        <button
          type="button"
          className="btn btn--xs kind-select__advanced-toggle"
          onClick={() => {
            setAdvRaw(value)
            setForceAdvanced(true)
          }}
          disabled={disabled}
          aria-label={contextualize(t('kindSelect.advancedToggle'))}
        >
          {t('kindSelect.advancedToggle')}
        </button>
      </div>
      {g.leafId === 'signal' && (
        <div className="kind-select__hint">{t('kindSelect.signalHint')}</div>
      )}
    </div>
  )
}
