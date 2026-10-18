// RFC-027: renders a SessionTree (one level) as a vertical list of
// conversation blocks. Subagent calls embed a nested ConversationFlow
// through SubagentBlock children; nesting depth is unbounded and expressed purely
// through DOM structure (no `depth` prop) so the component tree
// faithfully mirrors the data tree.

import { useTranslation } from 'react-i18next'
import type { SessionMessage, SessionTree } from '@agent-workflow/shared'
import { SubagentBlock } from './SubagentBlock'
import { RoleBadge } from './RoleBadge'
import { toolStatusKind, toolStatusLabel } from './toolStatus'
import { StatusChip } from '../StatusChip'

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
            <RoleBadge variant="user" icon="👤" label={t('session.user')} />
            <Ts ts={message.ts} />
          </header>
          <pre className="session-block__body">{message.text}</pre>
        </article>
      )
    case 'assistant-text':
      return (
        <article className="session-block session-block--assistant">
          <header className="session-block__head">
            <RoleBadge variant="assistant" icon="🤖" label={t('session.assistant')} />
            <Ts ts={message.ts} />
          </header>
          <pre className="session-block__body">{message.text}</pre>
        </article>
      )
    case 'assistant-reasoning':
      // Collapsed-by-default so long chains of thought don't drown the
      // assistant reply / tool calls. The summary surfaces a char count
      // so users can tell at a glance whether the model "thought a lot"
      // before answering.
      return (
        <article className="session-block session-block--reasoning">
          <header className="session-block__head">
            <RoleBadge variant="reasoning" icon="🧠" label={t('session.thinking')} />
            <Ts ts={message.ts} />
          </header>
          <details className="session-block__details">
            <summary>
              <span className="session-block__details-tag">
                {t('session.thinkingCount', { n: message.text.length })}
              </span>
            </summary>
            <pre className="session-block__body">{message.text}</pre>
          </details>
        </article>
      )
    case 'tool-call':
      return (
        <article className="session-block session-block--tool">
          <header className="session-block__head">
            <RoleBadge variant="tool" icon="🔧" label={t('session.toolCall')} />
            <code className="session-block__tool-name">{message.toolName}</code>
            <StatusChip kind={toolStatusKind(message.status)}>
              {toolStatusLabel(message.status, t)}
            </StatusChip>
            <Ts ts={message.ts} />
          </header>
          {message.input !== undefined && message.input !== null ? (
            <details className="session-block__details">
              <summary>
                <span className="session-block__details-tag">{t('session.toolInput')}</span>
              </summary>
              <pre className="session-block__body">{stringify(message.input)}</pre>
            </details>
          ) : null}
          {message.output !== null ? (
            <details open className="session-block__details">
              <summary>
                <span className="session-block__details-tag">{t('session.toolResult')}</span>
              </summary>
              <pre className="session-block__body">{message.output}</pre>
            </details>
          ) : null}
        </article>
      )
    case 'subagent-call':
      return (
        <SubagentBlock call={message}>
          {message.child !== null ? <ConversationFlow tree={message.child} nested /> : null}
        </SubagentBlock>
      )
  }
}

function Ts({ ts }: { ts: number }) {
  if (!Number.isFinite(ts) || ts <= 0) return null
  return <span className="session-block__ts">{new Date(ts).toLocaleTimeString()}</span>
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
