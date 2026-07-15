// RFC-194 — transactional card editor for the three-field Agent output state.

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { DEFAULT_OUTPUT_KIND, type AgentOutputKindsMap } from '@agent-workflow/shared'
import { ConfirmButton } from './ConfirmButton'
import { EmptyState } from './EmptyState'
import { FormSection } from './FormSection'
import { AgentPortCard } from './agent-ports/AgentPortCard'
import { AgentPortDialog, type AgentPortDialogMode } from './agent-ports/AgentPortDialog'
import {
  AGENT_PORT_NAME_RE,
  findOrphanOutputSidecars,
  removeOrphanOutputSidecars,
  removeOutputPort,
  type MutableOutputPortState,
  type OrphanSidecarRef,
} from '@/lib/agent-ports'

interface OutputsEditorProps {
  outputs: string[]
  outputKinds?: AgentOutputKindsMap
  outputWrapperPortNames?: Record<string, string>
  aggregator?: boolean
  /** A route-level compact summary is already the page's live alert. */
  hasExternalPortAlert?: boolean
  onChange: (
    outputs: string[],
    outputKinds: AgentOutputKindsMap | undefined,
    outputWrapperPortNames: Record<string, string> | undefined,
  ) => void
  /** Pre-RFC-194 compatibility only; adding is now an explicit Dialog action. */
  placeholder?: string
}

type PendingFocus = number | 'add' | null

export function OutputsEditor({
  outputs,
  outputKinds,
  outputWrapperPortNames,
  aggregator = false,
  hasExternalPortAlert,
  onChange,
}: OutputsEditorProps) {
  const { t } = useTranslation()
  const [dialogMode, setDialogMode] = useState<AgentPortDialogMode | null>(null)
  const addRef = useRef<HTMLButtonElement | null>(null)
  const dialogTriggerRef = useRef<HTMLElement | null>(null)
  const editRefs = useRef(new Map<number, HTMLButtonElement>())
  const pendingFocusRef = useRef<PendingFocus>(null)
  const state = { outputs, outputKinds, outputWrapperPortNames }

  useEffect(() => {
    const pending = pendingFocusRef.current
    if (pending === null) return
    pendingFocusRef.current = null
    if (pending === 'add') addRef.current?.focus()
    else editRefs.current.get(pending)?.focus()
  }, [outputs])

  const counts = new Map<string, number>()
  for (const output of outputs) counts.set(output, (counts.get(output) ?? 0) + 1)
  const wrapperCounts = new Map<string, number>()
  for (const output of outputs) {
    const wrapper = outputWrapperPortNames?.[output] ?? output
    wrapperCounts.set(wrapper, (wrapperCounts.get(wrapper) ?? 0) + 1)
  }
  const orphans = findOrphanOutputSidecars(state)

  function emit(next: MutableOutputPortState) {
    onChange(next.outputs, next.outputKinds, next.outputWrapperPortNames)
  }

  function open(mode: AgentPortDialogMode, trigger: HTMLElement | null) {
    dialogTriggerRef.current = trigger
    setDialogMode(mode)
  }

  function remove(index: number) {
    const next = removeOutputPort(state, index)
    pendingFocusRef.current =
      next.outputs.length === 0 ? 'add' : Math.min(index, Math.max(0, next.outputs.length - 1))
    emit(next)
  }

  function cleanupOrphan(ref: OrphanSidecarRef) {
    emit(removeOrphanOutputSidecars(state, [ref]))
  }

  return (
    <FormSection title={t('agentForm.ports.outputsTitle')} data-testid="agent-output-ports">
      <div className="agent-port-section__header">
        <div className="agent-port-section__intro">
          <p>{t('agentForm.ports.outputsRelation')}</p>
          <span className="agent-port-section__count">
            {t('agentForm.ports.count', { count: outputs.length })}
          </span>
        </div>
        <button
          ref={addRef}
          type="button"
          className="btn btn--primary btn--sm agent-port-section__add"
          onClick={(event) => open({ kind: 'add' }, event.currentTarget)}
          data-testid="agent-output-port-add"
        >
          {t('agentForm.ports.addOutput')}
        </button>
      </div>

      {outputs.length === 0 ? (
        <EmptyState
          size="compact"
          title={t('agentForm.ports.outputsEmptyTitle')}
          description={t('agentForm.ports.outputsEmptyDescription')}
          data-testid="agent-output-ports-empty"
        />
      ) : (
        <div className="agent-port-list" data-testid="agent-output-port-list">
          {outputs.map((name, index) => (
            <AgentPortCard
              key={index}
              direction="output"
              index={index}
              name={name}
              kind={outputKinds?.[name] ?? DEFAULT_OUTPUT_KIND}
              aggregator={aggregator}
              wrapperPortName={outputWrapperPortNames?.[name]}
              wrapperDuplicate={
                aggregator && (wrapperCounts.get(outputWrapperPortNames?.[name] ?? name) ?? 0) > 1
              }
              legacy={!AGENT_PORT_NAME_RE.test(name)}
              duplicate={(counts.get(name) ?? 0) > 1}
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

      {orphans.length > 0 && (
        <section className="agent-port-orphans" aria-labelledby="agent-port-orphans-title">
          <div className="agent-port-orphans__header">
            <h3 id="agent-port-orphans-title">{t('agentForm.ports.orphanTitle')}</h3>
            <p>{t('agentForm.ports.orphanDescription')}</p>
          </div>
          <ul className="agent-port-orphans__list">
            {orphans.map((ref) => {
              const value =
                ref.source === 'outputKinds'
                  ? outputKinds?.[ref.key]
                  : outputWrapperPortNames?.[ref.key]
              const context = `${ref.source}:${ref.key}`
              const confirmationIdentity = JSON.stringify([context, value])
              return (
                <li key={context} className="agent-port-orphans__item">
                  <code>
                    {t(
                      ref.source === 'outputKinds'
                        ? 'agentForm.ports.orphanKind'
                        : 'agentForm.ports.orphanWrapper',
                      { key: ref.key, value: String(value) },
                    )}
                  </code>
                  <ConfirmButton
                    size="sm"
                    variant="danger"
                    label={t('common.delete')}
                    confirmLabel={t('common.confirmDelete')}
                    ariaLabel={t('agentForm.ports.cleanupOrphan', { key: context })}
                    confirmAriaLabel={t('agentForm.ports.confirmCleanupOrphan', { key: context })}
                    confirmationKey={confirmationIdentity}
                    onConfirm={() => cleanupOrphan(ref)}
                  />
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {dialogMode !== null && (
        <AgentPortDialog
          open
          direction="output"
          mode={dialogMode}
          outputState={state}
          role={aggregator ? 'aggregator' : 'normal'}
          hasExternalPortAlert={hasExternalPortAlert}
          triggerRef={dialogTriggerRef}
          onClose={() => setDialogMode(null)}
          onCommit={(next) => {
            pendingFocusRef.current =
              dialogMode.kind === 'add' ? next.outputs.length - 1 : dialogMode.index
            emit(next)
          }}
          testidPrefix="agent-output-port"
        />
      )}
    </FormSection>
  )
}
