// RFC-247 D1 / D2 / D4 / D8 / C10 — issue a personal access token.
//
// Two phases in one dialog, GitHub's shape: pick what the token may do, then
// see the token exactly once. The reveal is a phase rather than a second dialog
// because the raw secret exists only in this response — a dismissable toast or
// a re-mounted dialog risks losing it to a stray click.
//
// The permission picker is a template row plus an optional grid. Most tokens
// are one of three shapes and want the template; the grid exists for the ones
// that are not, and for anything involving delete — which no template selects
// (D4-2), so reaching a delete grant requires opening the grid and ticking the
// individual box.

import { useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DELETE_POINTS,
  type PatPublic,
  type PatPurpose,
  type Permission,
  type Role,
} from '@agent-workflow/shared'
import { api, ApiError } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { Field, TextInput } from '@/components/Form'
import { NoticeBanner } from '@/components/NoticeBanner'
import { Segmented } from '@/components/Segmented'
import { Select } from '@/components/Select'
import { TokenPermissionMatrix } from '@/components/account/TokenPermissionMatrix'
import { copyText } from '@/lib/clipboard'
import {
  matchingTemplate,
  selectionHasDelete,
  templatePoints,
  type TemplateId,
} from '@/lib/token-matrix'

interface CreateTokenDialogProps {
  open: boolean
  onClose: () => void
  role: Role
  /** Invalidate the actor query so the new token appears in the list. */
  onCreated: () => Promise<void> | void
  triggerRef?: RefObject<HTMLElement | null>
}

/** RFC-247 D8 — expiry presets. `never` is offered but is not the default. */
const EXPIRY_DAYS: Record<string, number | null> = {
  '30d': 30,
  '90d': 90,
  '365d': 365,
  never: null,
}
type ExpiryChoice = keyof typeof EXPIRY_DAYS

/**
 * The template row's own value space. `custom` is a READOUT, not a template:
 * it is what the control shows once the grid no longer matches any preset, and
 * it is never selectable — picking it would have no defined meaning.
 */
type TemplateChoice = TemplateId | 'custom'

interface CreatedToken {
  token: string
  pat: PatPublic
}

export function CreateTokenDialog({
  open,
  onClose,
  role,
  onCreated,
  triggerRef,
}: CreateTokenDialogProps) {
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState<PatPurpose>('mcp_only')
  const [selected, setSelected] = useState<ReadonlySet<Permission>>(new Set())
  const [advanced, setAdvanced] = useState(false)
  const [expiry, setExpiry] = useState<ExpiryChoice>('90d')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [created, setCreated] = useState<CreatedToken | null>(null)
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle')

  const template = matchingTemplate(selected, role)
  const hasDelete = selectionHasDelete(selected)

  const reset = (): void => {
    setName('')
    setPurpose('mcp_only')
    setSelected(new Set())
    setAdvanced(false)
    setExpiry('90d')
    setPending(false)
    setError(undefined)
    setCreated(null)
    setCopied('idle')
  }

  const close = (): void => {
    reset()
    onClose()
  }

  const applyTemplate = (id: TemplateId): void => {
    setSelected(new Set(templatePoints(id, role)))
  }

  const toggle = (permission: Permission, next: boolean): void => {
    setSelected((prev) => {
      const out = new Set(prev)
      if (next) out.add(permission)
      else out.delete(permission)
      return out
    })
  }

  const submit = async (): Promise<void> => {
    setPending(true)
    setError(undefined)
    try {
      const days = EXPIRY_DAYS[expiry] ?? null
      const result = await api.post<CreatedToken>('/api/auth/pats', {
        name: name.trim(),
        scopes: [...selected],
        purpose,
        expiresAt: days === null ? null : Date.now() + days * 86_400_000,
      })
      setCreated(result)
      await onCreated()
    } catch (err) {
      // Surface the backend's own message: `pat-scope-ungrantable` names which
      // points were refused, and a generic "creation failed" would throw that
      // away at the one moment it is worth reading.
      setError(err instanceof ApiError ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  if (created !== null) {
    return (
      <Dialog
        open={open}
        onClose={close}
        title={t('account.token.createdTitle')}
        size="md"
        triggerRef={triggerRef}
        data-testid="token-created-dialog"
        footer={
          <button type="button" className="btn btn--primary" onClick={close}>
            {t('common.done')}
          </button>
        }
      >
        <NoticeBanner tone="warning">
          <strong>{t('account.token.shownOnceTitle')}</strong>
          <p>{t('account.token.shownOnceDescription')}</p>
        </NoticeBanner>
        {/* Selectable, not an input: the fallback copy path focuses a hidden
            textarea, and inside a Dialog the focus trap fights it (see
            lib/clipboard.ts). Manual select must stay possible. */}
        <code className="token-reveal" data-testid="token-created-value">
          {created.token}
        </code>
        <div className="token-reveal__actions">
          <button
            type="button"
            className="btn btn--sm"
            data-testid="token-copy"
            onClick={() => {
              void copyText(created.token).then((ok) => setCopied(ok ? 'ok' : 'failed'))
            }}
          >
            {t('account.copy')}
          </button>
          {copied === 'ok' && (
            <span className="token-reveal__status" role="status">
              {t('account.token.copied')}
            </span>
          )}
          {copied === 'failed' && (
            <span className="token-reveal__status token-reveal__status--error" role="status">
              {t('account.token.copyFailed')}
            </span>
          )}
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t('account.token.createTitle')}
      size="lg"
      triggerRef={triggerRef}
      data-testid="token-create-dialog"
      footer={
        <>
          {error !== undefined && <span className="form-actions__error">{error}</span>}
          <button type="button" className="btn" onClick={close} disabled={pending}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className={hasDelete ? 'btn btn--danger' : 'btn btn--primary'}
            disabled={pending || name.trim() === ''}
            onClick={() => void submit()}
            data-testid="token-create-confirm"
          >
            {pending ? t('common.creating') : t('account.token.create')}
          </button>
        </>
      }
    >
      <Field label={t('account.patName')} hint={t('account.token.nameHint')} required>
        <TextInput
          value={name}
          onChange={setName}
          maxLength={128}
          placeholder={t('account.patNamePlaceholder')}
          data-testid="token-create-name"
        />
      </Field>

      <Field
        label={t('account.token.purposeLabel')}
        hint={t(`account.token.purposeHint.${purpose}`)}
        group
        labelId="token-purpose-label"
      >
        <Segmented<PatPurpose>
          value={purpose}
          onChange={setPurpose}
          ariaLabel={t('account.token.purposeLabel')}
          testidPrefix="token-purpose"
          options={[
            { value: 'mcp_only', label: t('account.token.purpose.mcp_only') },
            { value: 'general', label: t('account.token.purpose.general') },
          ]}
        />
      </Field>

      <Field
        label={t('account.token.templateLabel')}
        hint={t('account.token.templateHint')}
        group
        labelId="token-template-label"
      >
        <Segmented<TemplateChoice>
          // A selection that matches no template still has to render something.
          // Falling back to a phantom "read-only" would tick the least
          // capable option on the most capable selection; `custom` is a real
          // state and says so.
          value={template ?? 'custom'}
          onChange={(id) => {
            if (id !== 'custom') applyTemplate(id)
          }}
          allowActiveReselect
          ariaLabel={t('account.token.templateLabel')}
          testidPrefix="token-template"
          options={[
            { value: 'read-only', label: t('account.token.template.read-only') },
            { value: 'task-automation', label: t('account.token.template.task-automation') },
            { value: 'full', label: t('account.token.template.full') },
            // Not pickable — it describes the grid rather than setting it.
            { value: 'custom', label: t('account.token.template.custom'), disabled: true },
          ]}
        />
      </Field>

      <details
        className="account-technical-details"
        open={advanced}
        onToggle={(e) => setAdvanced((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary data-testid="token-advanced-toggle">{t('account.token.advanced')}</summary>
        <p className="form-field__hint">{t('account.token.advancedHint')}</p>
        <TokenPermissionMatrix
          role={role}
          selected={selected}
          onToggle={toggle}
          disabled={pending}
          testidPrefix="token-matrix"
        />
      </details>

      {hasDelete && (
        <NoticeBanner tone="warning" testid="token-delete-warning">
          <strong>{t('account.token.deleteWarningTitle')}</strong>
          <p>
            {t('account.token.deleteWarningDescription', {
              points: [...selected]
                .filter((p) => DELETE_POINTS.includes(p))
                .sort()
                .join(', '),
            })}
          </p>
        </NoticeBanner>
      )}

      <Field label={t('account.token.expiryLabel')} hint={t('account.token.expiryHint')}>
        <Select<ExpiryChoice>
          value={expiry}
          onChange={setExpiry}
          ariaLabel={t('account.token.expiryLabel')}
          data-testid="token-expiry"
          options={[
            { value: '30d', label: t('account.token.expiry.30d') },
            { value: '90d', label: t('account.token.expiry.90d') },
            { value: '365d', label: t('account.token.expiry.365d') },
            { value: 'never', label: t('account.token.expiry.never') },
          ]}
        />
      </Field>
    </Dialog>
  )
}
