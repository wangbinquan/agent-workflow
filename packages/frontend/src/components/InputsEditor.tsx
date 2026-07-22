// RFC-194 — transactional card editor for declarative Agent input ports.

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentInputPort } from '@agent-workflow/shared'
import { EmptyState } from './EmptyState'
import { FormSection } from './FormSection'
import { AgentPortCard } from './agent-ports/AgentPortCard'
import { AgentPortDialog, type AgentPortDialogMode } from './agent-ports/AgentPortDialog'
import { AGENT_PORT_NAME_RE, removeInputPort } from '@/lib/agent-ports'

interface InputsEditorProps {
  inputs: AgentInputPort[]
  onChange: (inputs: AgentInputPort[]) => void
  /** A route-level compact summary is already the page's live alert. */
  hasExternalPortAlert?: boolean
  /** Pre-RFC-194 compatibility only; adding is now an explicit Dialog action. */
  placeholder?: string
}

type PendingFocus = number | 'add' | null

export function InputsEditor({ inputs, onChange, hasExternalPortAlert }: InputsEditorProps) {
  const { t } = useTranslation()
  const [dialogMode, setDialogMode] = useState<AgentPortDialogMode | null>(null)
  const addRef = useRef<HTMLButtonElement | null>(null)
  const dialogTriggerRef = useRef<HTMLElement | null>(null)
  const editRefs = useRef(new Map<number, HTMLButtonElement>())
  const pendingFocusRef = useRef<PendingFocus>(null)

  useEffect(() => {
    const pending = pendingFocusRef.current
    if (pending === null) return
    pendingFocusRef.current = null
    if (pending === 'add') addRef.current?.focus()
    else editRefs.current.get(pending)?.focus()
  }, [inputs])

  const counts = new Map<string, number>()
  for (const input of inputs) counts.set(input.name, (counts.get(input.name) ?? 0) + 1)

  function open(mode: AgentPortDialogMode, trigger: HTMLElement | null) {
    dialogTriggerRef.current = trigger
    setDialogMode(mode)
  }

  function remove(index: number) {
    const next = removeInputPort(inputs, index)
    pendingFocusRef.current =
      next.length === 0 ? 'add' : Math.min(index, Math.max(0, next.length - 1))
    onChange(next)
  }

  return (
    <FormSection title={t('agentForm.ports.inputsTitle')} data-testid="agent-input-ports">
      <div className="agent-port-section__header">
        <div className="agent-port-section__intro">
          <p>{t('agentForm.ports.inputsRelation')}</p>
          <span className="agent-port-section__count">
            {t('agentForm.ports.count', { count: inputs.length })}
          </span>
        </div>
        <button
          ref={addRef}
          type="button"
          className="btn btn--primary btn--sm agent-port-section__add"
          onClick={(event) => open({ kind: 'add' }, event.currentTarget)}
          data-testid="agent-input-port-add"
        >
          {t('agentForm.ports.addInput')}
        </button>
      </div>

      {inputs.length === 0 ? (
        <EmptyState
          size="compact"
          title={t('agentForm.ports.inputsEmptyTitle')}
          description={t('agentForm.ports.inputsEmptyDescription')}
          data-testid="agent-input-ports-empty"
        />
      ) : (
        <div className="agent-port-list" data-testid="agent-input-port-list">
          {inputs.map((port, index) => (
            <AgentPortCard
              key={index}
              direction="input"
              index={index}
              name={port.name}
              kind={port.kind}
              description={port.description}
              // RFC-218 D5: absence means required — the card chip must agree
              // with launch semantics (true now folds to canonical-absent).
              required={port.required !== false}
              legacy={!AGENT_PORT_NAME_RE.test(port.name)}
              duplicate={(counts.get(port.name) ?? 0) > 1}
              editButtonRef={(node) => {
                if (node === null) editRefs.current.delete(index)
                else editRefs.current.set(index, node)
              }}
              onEdit={() => open({ kind: 'edit', index }, editRefs.current.get(index) ?? null)}
              onDelete={() => remove(index)}
            />
          ))}
        </div>
      )}

      {dialogMode !== null && (
        <AgentPortDialog
          open
          direction="input"
          mode={dialogMode}
          inputs={inputs}
          hasExternalPortAlert={hasExternalPortAlert}
          triggerRef={dialogTriggerRef}
          onClose={() => setDialogMode(null)}
          onCommit={(next) => {
            pendingFocusRef.current = dialogMode.kind === 'add' ? next.length - 1 : dialogMode.index
            onChange(next)
          }}
          testidPrefix="agent-input-port"
        />
      )}
    </FormSection>
  )
}
