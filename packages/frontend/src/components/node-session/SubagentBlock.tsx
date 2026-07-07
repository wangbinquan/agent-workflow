// RFC-027: collapsible card representing a single `task` tool
// invocation. Wraps a recursive ConversationFlow render of the child
// session. Default state is collapsed so a parent with many subagents
// doesn't visually explode; the user opts in per card.

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionSubagentCall } from '@agent-workflow/shared'
import { ConversationFlow, RoleBadge } from './ConversationFlow'
import { toolStatusKind, toolStatusLabel } from './toolStatus'

interface Props {
  call: SessionSubagentCall
}

export function SubagentBlock({ call }: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  const child = call.child
  const captureMissing = child === null || child.captureComplete === false
  const subtitle = call.childAgentName ?? t('session.subagent')

  return (
    <article className="session-block session-block--subagent">
      <header className="session-block__head">
        <button
          type="button"
          className="session-subagent__toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? t('session.collapse') : t('session.expand')}
        >
          {open ? '▼' : '▶'}
        </button>
        <RoleBadge variant="subagent" icon="🪆" label={t('session.subagent')} />
        <code className="session-block__tool-name">{subtitle}</code>
        <span className={`status-chip status-chip--${toolStatusKind(call.status)}`}>
          {toolStatusLabel(call.status, t)}
        </span>
        {captureMissing && (
          <span className="session-capture-warning">{t('session.captureMissing')}</span>
        )}
      </header>
      {open && (
        <div className="session-subagent__body">
          {captureMissing && call.childOutputFallback !== null && (
            <div className="session-block__details">
              <div className="muted">{t('session.fallbackOutput')}</div>
              <pre className="session-block__body">{call.childOutputFallback}</pre>
            </div>
          )}
          {child !== null && <ConversationFlow tree={child} nested />}
        </div>
      )}
    </article>
  )
}

