// RFC-045 — controlled memory form field set.
//
// Shared by <MemoryNewDialog> (create candidate via POST /api/memories) and
// <MemoryEditDialog> (PATCH /api/memories/:id). Purely presentational: parent
// owns the state + submit + network call. The hook `useMemoryFormState`
// initializes / mutates state from an optional seed (for edit mode).
//
// UX choices (aligned with rest of the app):
//   - scope type → `.segmented` 4-option radiogroup (same pattern as
//     LanguageSwitch + NodeInspector clarify sessionMode picker).
//   - scope_id → shared `<Select>` (RFC-036 custom popover; matches every
//     other dropdown in the dialog ecosystem — no browser-chrome native
//     <select> popup).
//   - title / body → `<TextInput>` + `<TextArea>` from Form.tsx so border,
//     focus ring, and mono mode all match the rest of the app.
//   - tags → `<ChipsInput>` (Enter/comma commit, Backspace pop, dedup,
//     validator gate) instead of bespoke chip code.

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MemoryScope } from '@agent-workflow/shared'
import { ChipsInput } from '@/components/ChipsInput'
import { Field, TextArea, TextInput } from '@/components/Form'
import { Select } from '@/components/Select'

export interface MemoryFormState {
  scopeType: MemoryScope
  /** Always `null` when scopeType === 'global'. */
  scopeId: string | null
  title: string
  bodyMd: string
  tags: string[]
}

export interface ScopeOption {
  id: string
  /** Human-readable label for the dropdown. */
  label: string
}

/**
 * Client-side limits matching MemoryPatchRequestSchema / MemoryCreateRequestSchema.
 * Mirrored here to give immediate inline feedback before the request fires.
 */
export const MEMORY_FORM_LIMITS = {
  titleMin: 1,
  titleMax: 120,
  bodyMin: 1,
  bodyMax: 4000,
  tagMax: 40,
  tagsMax: 16,
} as const

export interface MemoryFormErrors {
  title?: string
  bodyMd?: string
  scopeId?: string
  tags?: string
}

export function defaultMemoryFormState(): MemoryFormState {
  return { scopeType: 'global', scopeId: null, title: '', bodyMd: '', tags: [] }
}

export function useMemoryFormState(initial?: Partial<MemoryFormState>) {
  const [state, setState] = useState<MemoryFormState>(() => ({
    ...defaultMemoryFormState(),
    ...initial,
  }))
  const setScopeType = useCallback((scopeType: MemoryScope) => {
    setState((prev) => ({
      ...prev,
      scopeType,
      // Switching to global clears scopeId; switching away from global keeps
      // whatever the user already chose (empty string flagged at submit time).
      scopeId: scopeType === 'global' ? null : (prev.scopeId ?? ''),
    }))
  }, [])
  const setScopeId = useCallback((scopeId: string | null) => {
    setState((prev) => ({ ...prev, scopeId }))
  }, [])
  const setTitle = useCallback((title: string) => setState((p) => ({ ...p, title })), [])
  const setBodyMd = useCallback((bodyMd: string) => setState((p) => ({ ...p, bodyMd })), [])
  const setTags = useCallback((tags: string[]) => setState((p) => ({ ...p, tags })), [])
  const reset = useCallback(
    (next?: Partial<MemoryFormState>) => setState({ ...defaultMemoryFormState(), ...next }),
    [],
  )
  return { state, setState, setScopeType, setScopeId, setTitle, setBodyMd, setTags, reset }
}

/**
 * Pure validation of a MemoryFormState. Returns the same field-level error
 * messages the form renders below each input. The caller decides what to do
 * with them (typically: render banner + block Save when keys exist).
 */
export function validateMemoryForm(
  s: MemoryFormState,
  t: (key: string, opts?: Record<string, unknown>) => string,
): MemoryFormErrors {
  const errors: MemoryFormErrors = {}
  const title = s.title.trim()
  const body = s.bodyMd.trim()
  if (title.length < MEMORY_FORM_LIMITS.titleMin) errors.title = t('memory.form.errTitleEmpty')
  else if (title.length > MEMORY_FORM_LIMITS.titleMax)
    errors.title = t('memory.form.errTitleTooLong', { max: MEMORY_FORM_LIMITS.titleMax })
  if (body.length < MEMORY_FORM_LIMITS.bodyMin) errors.bodyMd = t('memory.form.errBodyEmpty')
  else if (body.length > MEMORY_FORM_LIMITS.bodyMax)
    errors.bodyMd = t('memory.form.errBodyTooLong', { max: MEMORY_FORM_LIMITS.bodyMax })
  if (s.scopeType !== 'global') {
    if (s.scopeId === null || s.scopeId.trim() === '')
      errors.scopeId = t('memory.form.errScopeIdRequired')
  }
  if (s.tags.length > MEMORY_FORM_LIMITS.tagsMax)
    errors.tags = t('memory.form.errTagsTooMany', { max: MEMORY_FORM_LIMITS.tagsMax })
  if (s.tags.some((tag) => tag.length > MEMORY_FORM_LIMITS.tagMax))
    errors.tags = t('memory.form.errTagTooLong', { max: MEMORY_FORM_LIMITS.tagMax })
  return errors
}

const SCOPE_OPTIONS: ReadonlyArray<MemoryScope> = ['global', 'agent', 'workflow', 'repo']

export interface MemoryFormFieldsProps {
  state: MemoryFormState
  errors?: MemoryFormErrors
  onScopeType: (s: MemoryScope) => void
  onScopeId: (s: string | null) => void
  onTitle: (s: string) => void
  onBodyMd: (s: string) => void
  onTags: (s: string[]) => void
  /** Dropdown options for scope_id when scopeType !== global. Caller fetches. */
  agents: ScopeOption[]
  workflows: ScopeOption[]
  repos: ScopeOption[]
  /** Disables every input (used while save is in-flight). */
  disabled?: boolean
}

export function MemoryFormFields(props: MemoryFormFieldsProps) {
  const { t } = useTranslation()
  const { state, errors = {}, disabled } = props
  const scopeIdOptions: ReadonlyArray<{ value: string; label: string }> = (() => {
    if (state.scopeType === 'agent')
      return props.agents.map((o) => ({ value: o.id, label: o.label }))
    if (state.scopeType === 'workflow')
      return props.workflows.map((o) => ({ value: o.id, label: o.label }))
    if (state.scopeType === 'repo') return props.repos.map((o) => ({ value: o.id, label: o.label }))
    return []
  })()

  const validateTag = (token: string): string | null => {
    if (token.length > MEMORY_FORM_LIMITS.tagMax) {
      return t('memory.form.errTagTooLong', { max: MEMORY_FORM_LIMITS.tagMax })
    }
    if (state.tags.length >= MEMORY_FORM_LIMITS.tagsMax) {
      return t('memory.form.errTagsTooMany', { max: MEMORY_FORM_LIMITS.tagsMax })
    }
    return null
  }

  return (
    <div className="memory-form" data-testid="memory-form">
      <Field label={t('memory.form.scopeType')} group>
        <div
          role="radiogroup"
          aria-label={t('memory.form.scopeType')}
          className="segmented memory-form__scope-segmented"
        >
          {SCOPE_OPTIONS.map((s) => {
            const active = state.scopeType === s
            return (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={active}
                disabled={disabled}
                className={`segmented__option ${active ? 'segmented__option--active' : ''}`.trim()}
                onClick={() => {
                  if (s !== state.scopeType) props.onScopeType(s)
                }}
                data-testid={`memory-form-scope-${s}`}
              >
                {t(`memory.scope.${s}`)}
              </button>
            )
          })}
        </div>
      </Field>

      <Field label={t('memory.form.scopeId')} group>
        {state.scopeType === 'global' ? (
          <span
            className="muted memory-form__scope-id-global"
            data-testid="memory-form-scope-id-global"
          >
            {t('memory.form.scopeIdGlobal')}
          </span>
        ) : (
          <div className="memory-form__scope-id-wrap" data-testid="memory-form-scope-id">
            <Select<string>
              value={state.scopeId ?? ''}
              options={[
                { value: '', label: t('memory.form.scopeIdPlaceholder') },
                ...scopeIdOptions,
              ]}
              onChange={(v) => props.onScopeId(v === '' ? null : v)}
              disabled={disabled}
              ariaLabel={t('memory.form.scopeId')}
              placeholder={t('memory.form.scopeIdPlaceholder')}
            />
          </div>
        )}
        {errors.scopeId !== undefined && (
          <span className="memory-form__error" role="alert">
            {errors.scopeId}
          </span>
        )}
      </Field>

      <Field label={t('memory.form.title')}>
        <TextInput
          value={state.title}
          onChange={props.onTitle}
          disabled={disabled}
          maxLength={MEMORY_FORM_LIMITS.titleMax + 10}
          data-testid="memory-form-title"
        />
        {errors.title !== undefined && (
          <span className="memory-form__error" role="alert">
            {errors.title}
          </span>
        )}
      </Field>

      <Field label={t('memory.form.bodyMd')}>
        <TextArea
          value={state.bodyMd}
          onChange={props.onBodyMd}
          rows={8}
          monospace
          placeholder={t('memory.form.bodyMd')}
          disabled={disabled}
          data-testid="memory-form-body"
        />
        {errors.bodyMd !== undefined && (
          <span className="memory-form__error" role="alert">
            {errors.bodyMd}
          </span>
        )}
      </Field>

      <Field label={t('memory.form.tags')} hint={t('memory.form.tagsHint')} group>
        <ChipsInput
          value={state.tags}
          onChange={props.onTags}
          placeholder={t('memory.form.tagInputPlaceholder')}
          validate={validateTag}
          disabled={disabled}
          testidPrefix="memory-form-tag"
        />
        {errors.tags !== undefined && (
          <span className="memory-form__error" role="alert">
            {errors.tags}
          </span>
        )}
      </Field>
    </div>
  )
}
