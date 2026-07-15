// RFC-194 — compact, read-only summary card for one Agent input/output port.
// Editing remains an explicit Dialog transaction owned by the parent editor;
// this component only renders the summary and contextual actions.

import {
  outputKindUiById,
  stringifyKind,
  tryParseKind,
  type ParsedKind,
} from '@agent-workflow/shared'
import type { ReactElement, Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { Card } from '../Card'
import { ConfirmButton } from '../ConfirmButton'
import { StatusChip } from '../StatusChip'

export type AgentPortCardDirection = 'input' | 'output'

export interface AgentPortCardProps {
  direction: AgentPortCardDirection
  /** Zero-based identity used by the editor and focus hand-off. */
  index: number
  name: string
  kind: string
  description?: string | null
  required?: boolean
  /** Only aggregator output cards surface their wrapper rename mapping. */
  aggregator?: boolean
  wrapperPortName?: string
  wrapperDuplicate?: boolean
  legacy?: boolean
  duplicate?: boolean
  editButtonRef?: Ref<HTMLButtonElement>
  onEdit: () => void
  onDelete: () => unknown | Promise<unknown>
}

function leafKind(parsed: ParsedKind): string {
  let current = parsed
  while (current.kind === 'list') current = current.item
  return current.kind === 'path' ? 'path' : current.name
}

function kindLabelKey(parsed: ParsedKind | null): string | null {
  if (parsed === null) return null
  return outputKindUiById(leafKind(parsed))?.labelKey ?? null
}

export function AgentPortCard({
  direction,
  index,
  name,
  kind,
  description,
  required = false,
  aggregator = false,
  wrapperPortName,
  wrapperDuplicate = false,
  legacy = false,
  duplicate = false,
  editButtonRef,
  onEdit,
  onDelete,
}: AgentPortCardProps): ReactElement {
  const { t } = useTranslation()
  const position = index + 1
  const directionLabel = t(`agentForm.ports.direction.${direction}`, {
    defaultValue: direction,
  })
  const actionContext = { direction: directionLabel, name, index: position }
  const editLabel = t('agentForm.ports.actions.edit', {
    ...actionContext,
    defaultValue: 'Edit {{direction}} port {{name}}, item {{index}}',
  })
  const deleteLabel = t('agentForm.ports.actions.delete', {
    ...actionContext,
    defaultValue: 'Delete {{direction}} port {{name}}, item {{index}}',
  })
  const confirmDeleteLabel = t('agentForm.ports.actions.confirmDelete', {
    ...actionContext,
    defaultValue: 'Confirm delete {{direction}} port {{name}}, item {{index}}',
  })
  const rawKind = kind === '' ? 'string' : kind
  const parsedKind = tryParseKind(rawKind)
  const canonicalKind = parsedKind === null ? rawKind : stringifyKind(parsedKind)
  const translatedKindKey = kindLabelKey(parsedKind)
  const translatedKind =
    translatedKindKey === null
      ? t('agentForm.ports.card.customKind', { defaultValue: 'Custom kind' })
      : t(translatedKindKey)
  const cleanDescription = description?.trim() ?? ''
  const effectiveWrapperName = wrapperPortName ?? name

  return (
    <Card
      className="agent-port-card"
      data-testid={`agent-port-card-${direction}-${index}`}
      header={
        <div className="agent-port-card__header">
          <code className="agent-port-card__name">{name}</code>
          <div className="agent-port-card__chips chip-row">
            <StatusChip kind="neutral" size="sm">
              {translatedKind}
            </StatusChip>
            <code className="agent-port-card__kind-code">{canonicalKind}</code>
            {legacy && (
              <StatusChip kind="warn" size="sm">
                {t('agentForm.ports.card.legacy', { defaultValue: 'Legacy name' })}
              </StatusChip>
            )}
            {duplicate && (
              <StatusChip kind="warn" size="sm">
                {t('agentForm.ports.card.duplicate', { defaultValue: 'Duplicate name' })}
              </StatusChip>
            )}
            {aggregator && wrapperDuplicate && (
              <StatusChip kind="warn" size="sm">
                {t('agentForm.ports.card.wrapperDuplicate', {
                  defaultValue: 'Duplicate promoted name',
                })}
              </StatusChip>
            )}
          </div>
        </div>
      }
      footer={
        <>
          <button
            ref={editButtonRef}
            type="button"
            className="btn btn--sm"
            onClick={onEdit}
            aria-label={editLabel}
          >
            {t('common.edit')}
          </button>
          <ConfirmButton
            label={t('common.delete')}
            confirmLabel={t('common.confirmDelete')}
            ariaLabel={deleteLabel}
            confirmAriaLabel={confirmDeleteLabel}
            confirmationKey={JSON.stringify([
              direction,
              index,
              name,
              kind,
              required,
              description ?? null,
              wrapperPortName ?? null,
            ])}
            onConfirm={onDelete}
            size="sm"
            variant="danger"
          />
        </>
      }
    >
      {direction === 'input' ? (
        <div className="agent-port-card__input-summary">
          <p className="agent-port-card__description">
            {cleanDescription === ''
              ? t('agentForm.ports.card.noDescription', { defaultValue: 'No description' })
              : cleanDescription}
          </p>
          {required && (
            <StatusChip kind="info" size="sm">
              {t('agentForm.ports.card.required', { defaultValue: 'Required' })}
            </StatusChip>
          )}
        </div>
      ) : aggregator ? (
        <div className="agent-port-card__output-summary">
          {effectiveWrapperName !== name ? (
            <span className="agent-port-card__wrapper-map">
              <code>{name}</code>
              <span> → </span>
              <code>{effectiveWrapperName}</code>
            </span>
          ) : (
            <span className="agent-port-card__wrapper-default">
              {t('agentForm.ports.card.wrapperSameName', {
                name,
                defaultValue: 'Wrapper port keeps the name {{name}}',
              })}
            </span>
          )}
        </div>
      ) : (
        <div className="agent-port-card__output-summary">
          <span className="agent-port-card__wrapper-default">
            {wrapperPortName === undefined
              ? t('agentForm.ports.card.normalOutput', {
                  defaultValue: 'The runtime envelope emits this exact name.',
                })
              : t('agentForm.ports.card.inactiveWrapperMap', {
                  name,
                  wrapper: wrapperPortName,
                  defaultValue:
                    'Reserved promotion {{name}} → {{wrapper}} is inactive for a normal agent.',
                })}
          </span>
        </div>
      )}
    </Card>
  )
}
