// RFC-027: renders a SessionTree (one level) as a vertical list of
// conversation blocks. Subagent calls embed a nested ConversationFlow
// via SubagentBlock; nesting depth is unbounded and expressed purely
// through DOM structure (no `depth` prop) so the component tree
// faithfully mirrors the data tree.

import { useTranslation } from 'react-i18next'
import type { SessionMessage, SessionTree } from '@agent-workflow/shared'
import { SubagentBlock } from './SubagentBlock'

interface Props {
  tree: SessionTree
  /** Internal flag — true when this flow is nested inside a SubagentBlock. */
  nested?: boolean
}

export function ConversationFlow({ tree, nested }: Props) {
  const { t } = useTranslation()
  if (tree.messages.length === 0) {
    return <div className="muted session-flow__empty">{t('session.empty')}</div>
  }
  return (
    <div className={`session-flow ${nested === true ? 'session-flow--nested' : ''}`}>
      {tree.messages.map((m, i) => (
        <MessageBlock key={`${m.kind}-${i}`} message={m} />
      ))}
    </div>
  )
}

function MessageBlock({ message }: { message: SessionMessage }) {
  const { t } = useTranslation()
  switch (message.kind) {
    case 'user':
      return (
        <article className="session-block session-block--user">
          <header className="session-block__head">
            <span className="session-block__role">{t('session.user')}</span>
            <Ts ts={message.ts} />
          </header>
          <pre className="session-block__body">{message.text}</pre>
        </article>
      )
    case 'assistant-text':
      return (
        <article className="session-block session-block--assistant">
          <header className="session-block__head">
            <span className="session-block__role">{t('session.assistant')}</span>
            <Ts ts={message.ts} />
          </header>
          <pre className="session-block__body">{message.text}</pre>
        </article>
      )
    case 'tool-call':
      return (
        <article className="session-block session-block--tool">
          <header className="session-block__head">
            <span className="session-block__role">
              {t('session.toolCall')}: <code>{message.toolName}</code>
            </span>
            <span className={`status-chip status-chip--${toneFor(message.status)}`}>
              {statusLabel(message.status, t)}
            </span>
            <Ts ts={message.ts} />
          </header>
          {message.input !== undefined && message.input !== null ? (
            <details className="session-block__details">
              <summary>{t('session.toolCall')} · input</summary>
              <pre className="session-block__body">{stringify(message.input)}</pre>
            </details>
          ) : null}
          {message.output !== null ? (
            <details open className="session-block__details">
              <summary>{t('session.toolResult')}</summary>
              <pre className="session-block__body">{message.output}</pre>
            </details>
          ) : null}
        </article>
      )
    case 'subagent-call':
      return <SubagentBlock call={message} />
  }
}

function Ts({ ts }: { ts: number }) {
  if (!Number.isFinite(ts) || ts <= 0) return null
  return <span className="session-block__ts">{new Date(ts).toLocaleTimeString()}</span>
}

function toneFor(status: string): string {
  switch (status) {
    case 'completed':
      return 'green'
    case 'running':
      return 'blue'
    case 'error':
      return 'red'
    default:
      return 'gray'
  }
}

function statusLabel(status: string, t: (key: string) => string): string {
  switch (status) {
    case 'pending':
      return t('session.statusPending')
    case 'running':
      return t('session.statusRunning')
    case 'completed':
      return t('session.statusCompleted')
    case 'error':
      return t('session.statusError')
    default:
      return status
  }
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
