import { useId, useRef, useState, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { INTENT_MESSAGE_MAX, type IntentSessionSummary } from '@agent-workflow/shared'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api, type ApiError } from '@/api/client'
import { ChoiceCards } from '@/components/ChoiceCards'
import { ErrorBanner } from '@/components/ErrorBanner'
import { Field, TextArea } from '@/components/Form'
import {
  AGENT_ICON,
  MCP_ICON,
  PLUGIN_ICON,
  SKILL_ICON,
  WORKFLOW_ICON,
  WORKGROUP_ICON,
} from '@/components/icons/resourceIcons'

type ArtifactHint = 'agent' | 'skill' | 'mcp' | 'plugin' | 'workflow' | 'workgroup'
type ArtifactHintChoice = 'auto' | ArtifactHint

export function IntentCreateComposer(props: {
  variant: 'inline' | 'dialog'
  initialHint?: ArtifactHintChoice
  mount?: { resourceType: ArtifactHint; resourceId: string }
  onCreated: (session: IntentSessionSummary) => void
  onCancel?: () => void
  /** Dialog variant: portal the stateful actions into Dialog's pinned footer. */
  footerTarget?: HTMLElement | null
}) {
  const { t } = useTranslation()
  const formId = useId()
  const [message, setMessage] = useState('')
  const [hint, setHint] = useState<ArtifactHintChoice>(props.initialHint ?? 'auto')
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const createSession = useMutation<IntentSessionSummary, ApiError, void>({
    mutationFn: () =>
      api.post<IntentSessionSummary>('/api/intent-sessions', {
        message: message.trim(),
        ...(hint === 'auto' || props.mount !== undefined ? {} : { hint }),
        ...(props.mount === undefined ? {} : { mounts: [props.mount] }),
      }),
    onSuccess: (session) => {
      setMessage('')
      setHint(props.initialHint ?? 'auto')
      props.onCreated(session)
    },
  })

  const examples = [
    t('intent.exampleWorkflow'),
    t('intent.exampleWorkgroup'),
    t('intent.exampleAgent'),
  ]
  const chooseExample = (value: string): void => {
    setMessage(value)
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      textarea?.focus()
      textarea?.setSelectionRange(value.length, value.length)
    })
  }
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (message.trim() === '' || createSession.isPending) return
    createSession.mutate()
  }
  const options = [
    {
      value: 'auto' as const,
      label: t('intent.hintAuto'),
      icon: <span className="intent-create__sparkle">✦</span>,
    },
    { value: 'agent' as const, label: t('intent.resourceType.agent'), icon: AGENT_ICON },
    { value: 'skill' as const, label: t('intent.resourceType.skill'), icon: SKILL_ICON },
    { value: 'mcp' as const, label: t('intent.resourceType.mcp'), icon: MCP_ICON },
    { value: 'plugin' as const, label: t('intent.resourceType.plugin'), icon: PLUGIN_ICON },
    {
      value: 'workflow' as const,
      label: t('intent.resourceType.workflow'),
      icon: WORKFLOW_ICON,
    },
    {
      value: 'workgroup' as const,
      label: t('intent.resourceType.workgroup'),
      icon: WORKGROUP_ICON,
    },
  ]
  const footer = (
    <div className="intent-create__footer">
      <span className="intent-create__safety">
        <span aria-hidden="true">✓</span> {t('intent.draftSafety')}
      </span>
      <div className="intent-create__actions">
        {props.onCancel !== undefined ? (
          <button
            type="button"
            className="btn"
            disabled={createSession.isPending}
            onClick={props.onCancel}
          >
            {t('common.cancel')}
          </button>
        ) : null}
        <button
          type="submit"
          form={formId}
          className="btn btn--primary"
          disabled={message.trim() === '' || createSession.isPending}
        >
          {createSession.isPending ? t('common.creating') : t('intent.startBuilding')}
        </button>
      </div>
    </div>
  )

  return (
    <form
      id={formId}
      className={`intent-create intent-create--${props.variant}`}
      onSubmit={submit}
      data-testid={`intent-create-${props.variant}`}
    >
      {createSession.isError ? <ErrorBanner error={createSession.error} /> : null}
      <Field label={t('intent.messageLabel')} hint={t('intent.messageHint')} required>
        <TextArea
          value={message}
          onChange={setMessage}
          rows={props.variant === 'inline' ? 5 : 6}
          maxLength={INTENT_MESSAGE_MAX}
          placeholder={t('intent.messagePlaceholder')}
          disabled={createSession.isPending}
          textareaRef={textareaRef}
          data-testid="intent-create-message"
          onKeyDown={(event) => {
            if (
              (event.metaKey || event.ctrlKey) &&
              event.key === 'Enter' &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault()
              event.currentTarget.form?.requestSubmit()
            }
          }}
        />
      </Field>
      <div className="intent-create__counter">
        {message.length.toLocaleString()} / {INTENT_MESSAGE_MAX.toLocaleString()}
      </div>
      {props.variant === 'inline' && props.mount === undefined && message.trim() === '' ? (
        <div className="intent-create__examples" aria-label={t('intent.examplesLabel')}>
          {examples.map((example) => (
            <button
              key={example}
              type="button"
              className="intent-create__example"
              onClick={() => chooseExample(example)}
            >
              {example}
            </button>
          ))}
        </div>
      ) : null}
      {props.mount === undefined ? (
        <Field label={t('intent.hintLabel')} hint={t('intent.hintHint')} group>
          <ChoiceCards<ArtifactHintChoice>
            value={hint}
            options={options}
            onChange={setHint}
            disabled={createSession.isPending}
            ariaLabel={t('intent.hintLabel')}
            className="intent-create__types"
            testidPrefix="intent-create-hint"
          />
        </Field>
      ) : (
        <div className="intent-create__modify" data-testid="intent-modify-target">
          <span>
            {t('intent.modifyTargetNote', {
              type: t(`intent.resourceType.${props.mount.resourceType}`),
            })}
          </span>
        </div>
      )}
      {props.footerTarget === undefined ? footer : null}
      {props.footerTarget !== undefined && props.footerTarget !== null
        ? createPortal(footer, props.footerTarget)
        : null}
    </form>
  )
}
