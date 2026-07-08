// RFC-043 T5 — replays the distiller subprocess conversation. Reuses
// RFC-027's <ConversationFlow /> exactly — only swap the attempt picker
// for a distill-specific simplified version (no inline-session group /
// shardKey / fanout-parent concepts apply here).

import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type { MemoryDistillSessionAttempt, MemoryDistillSessionView } from '@agent-workflow/shared'
import { ConversationFlow } from '@/components/node-session/ConversationFlow'
import { EmptyState } from '@/components/EmptyState'
import { LoadingState } from '@/components/LoadingState'
import { selectAttempts } from '@/lib/distill-job-detail'

interface Props {
  sessionData: MemoryDistillSessionView | undefined
  loading: boolean
  error: ReactElement | null
}

export function ConversationSection({ sessionData, loading, error }: Props) {
  const { t } = useTranslation()
  if (loading) return <LoadingState size="compact" />
  if (error !== null) return error
  const attempts = selectAttempts(sessionData?.attempts ?? [])
  if (attempts.length === 0) {
    return <EmptyState size="compact" title={t('memory.distillJobDetail.noConversation')} />
  }
  return <ConversationSectionInner attempts={attempts} />
}

function ConversationSectionInner({ attempts }: { attempts: MemoryDistillSessionAttempt[] }) {
  const { t } = useTranslation()
  // Default to the latest attempt — admins usually care about "the most
  // recent retry's behavior" first; older attempts available via the picker.
  const [picked, setPicked] = useState<number>(attempts[attempts.length - 1]!.attemptIndex)
  const current = attempts.find((a) => a.attemptIndex === picked) ?? attempts[attempts.length - 1]!
  return (
    <div className="distill-job-detail__conversation" data-testid="distill-conversation">
      {attempts.length > 1 && (
        <AttemptPickerLite attempts={attempts} picked={picked} onPick={setPicked} />
      )}
      {current.captureFailed && (
        <div className="error-box" data-testid="distill-conversation-capture-failed">
          {t('memory.distillJobDetail.captureFailed')}
        </div>
      )}
      {current.tree === null ? (
        <EmptyState size="compact" title={t('memory.distillJobDetail.noConversation')} />
      ) : (
        <ConversationFlow tree={current.tree} />
      )}
    </div>
  )
}

function AttemptPickerLite({
  attempts,
  picked,
  onPick,
}: {
  attempts: MemoryDistillSessionAttempt[]
  picked: number
  onPick: (n: number) => void
}) {
  const { t } = useTranslation()
  return (
    <div className="distill-job-detail__attempt-picker">
      <span className="muted">{t('memory.distillJobDetail.attemptPickerLabel')}</span>
      {attempts.map((a) => (
        <button
          key={a.attemptIndex}
          type="button"
          className={`btn btn--xs ${picked === a.attemptIndex ? 'btn--primary' : ''}`}
          onClick={() => onPick(a.attemptIndex)}
          data-testid={`distill-attempt-${a.attemptIndex}`}
          aria-pressed={picked === a.attemptIndex}
        >
          {t('memory.distillJobDetail.attempt', { n: a.attemptIndex + 1 })}
          {a.captureFailed && <span aria-hidden="true"> ⚠</span>}
        </button>
      ))}
    </div>
  )
}
