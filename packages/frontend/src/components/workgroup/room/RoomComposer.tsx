// RFC-217 T10 — the room composer: draft / caret / @-mention completion /
// focus tracking / send-chord state, ALL local to this component so a
// keystroke re-renders the composer alone, never the timeline or side rail
// (the old god component kept these six states at the top and re-rendered
// 1500 lines per character). The send mutation lives here too — its only
// external effect is the room-key invalidation.
//
// The @-mention popup keeps the active-descendant listbox model from RFC-174
// (a multiline textarea can't be a combobox); the keyboard/hover highlight
// state machine is the shared useListboxNavigation hook.

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '@/api/client'
import { ErrorBanner } from '@/components/ErrorBanner'
import { TextArea } from '@/components/Form'
import { useListboxNavigation } from '@/hooks/useListboxNavigation'
import {
  applyMention,
  mentionCandidates,
  mentionQueryAt,
  resolveComposerKey,
  sendChordModLabel,
  workgroupRoomKey,
  type MentionContext,
  type WorkgroupRoomResponse,
} from '@/lib/workgroup-room'

export interface RoomComposerProps {
  taskId: string
  canPost: boolean
  /** Roster source for @-mention completion (undefined while loading). */
  config: WorkgroupRoomResponse['config'] | undefined
}

function RoomComposerInner({ taskId, canPost, config }: RoomComposerProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()

  const [draft, setDraft] = useState('')
  const [caret, setCaret] = useState(0)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  // RFC-174 — @-mention keyboard nav + send-chord state.
  const [dismissed, setDismissed] = useState<MentionContext | null>(null)
  const [composerFocused, setComposerFocused] = useState(false)
  const sendFromKbdRef = useRef(false)
  const wasSendPendingRef = useRef(false)
  const pendingCaretRef = useRef<number | null>(null)

  const send = useMutation({
    mutationFn: (body: string) =>
      api.post<{ messageId: string; assignmentIds: string[] }>(
        `/api/workgroup-tasks/${encodeURIComponent(taskId)}/messages`,
        { body },
      ),
    onSuccess: () => {
      setDraft('')
      setCaret(0)
      setDismissed(null) // fresh draft: never inherit a stale Esc dismissal
      void qc.invalidateQueries({ queryKey: workgroupRoomKey(taskId) })
    },
    // Focus restoration after a keyboard send happens in an effect that watches
    // send.isPending true→false — onSettled fires before the re-render that
    // re-enables the (disabled-while-pending) textarea, so .focus() would no-op.
  })

  // @-mention completion over the roster (design: 输入 @ 时按花名册补全).
  const mentionCtx = mentionQueryAt(draft, caret)
  const rawSuggestions =
    mentionCtx === null || config === undefined ? [] : mentionCandidates(config, mentionCtx.query)
  // Token-session dismissal (Esc): keyed on {start,query} so typing more in the
  // same token reopens it, while moving to another @token is unaffected.
  const isDismissed =
    mentionCtx !== null &&
    dismissed !== null &&
    dismissed.start === mentionCtx.start &&
    dismissed.query === mentionCtx.query
  // Also gate on focus + postability + no send in flight (RFC-174 P1-3).
  const mentionOpen =
    rawSuggestions.length > 0 && !isDismissed && composerFocused && canPost && !send.isPending
  const suggestions = mentionOpen ? rawSuggestions : []
  const nav = useListboxNavigation(suggestions.length)

  // Re-highlight the top match whenever the mention query changes.
  const navReset = nav.reset
  useEffect(() => {
    navReset()
  }, [mentionCtx?.query, navReset])

  // Apply a post-commit caret AFTER the controlled value lands in the DOM —
  // setting selectionRange synchronously (before re-render) mis-places it.
  useLayoutEffect(() => {
    if (pendingCaretRef.current === null) return
    const pos = pendingCaretRef.current
    pendingCaretRef.current = null
    const el = inputRef.current
    if (el !== null) {
      el.focus()
      try {
        el.setSelectionRange(pos, pos)
      } catch {
        /* jsdom/happy-dom quirk tolerance */
      }
    }
  }, [draft])

  // Restore focus after a keyboard send: watch send.isPending fall true→false so
  // we re-focus AFTER the re-render that re-enables the textarea (focusing a
  // still-disabled element in onSettled is a no-op).
  useEffect(() => {
    if (wasSendPendingRef.current && !send.isPending && sendFromKbdRef.current) {
      sendFromKbdRef.current = false
      inputRef.current?.focus()
    }
    wasSendPendingRef.current = send.isPending
  }, [send.isPending])

  function commitMention(displayName: string): void {
    if (mentionCtx === null) return
    const next = applyMention(draft, caret, mentionCtx, displayName)
    setDraft(next.text)
    setCaret(next.caret)
    pendingCaretRef.current = next.caret // applied by the layout effect above
    nav.reset()
    setDismissed(null) // committed token is gone; don't leave a stale dismissal
  }

  return (
    <div className="workgroup-room__composer">
      {suggestions.length > 0 && (
        <ul
          className="workgroup-room__mentions"
          id={nav.listboxId}
          role="listbox"
          aria-label={t('workgroups.room.mentionsAria')}
          data-testid="workgroup-room-mentions"
        >
          {suggestions.map((m, i) => (
            // The <li> IS the option (mirrors Select.tsx) — no inner button,
            // so nothing in the popup enters the Tab sequence under the
            // active-descendant model.
            <li
              key={m.id}
              id={nav.optionId(i)}
              role="option"
              aria-selected={i === nav.activeIndex}
              className={i === nav.activeIndex ? 'is-active' : undefined}
              onMouseEnter={() => nav.setActive(i)}
              // preventDefault keeps the textarea focused through the click.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => commitMention(m.displayName)}
              data-testid={`wg-mention-${m.displayName}`}
            >
              @{m.displayName}
              {m.roleDesc !== '' && <span className="muted"> · {m.roleDesc}</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="workgroup-room__composer-row">
        <TextArea
          textareaRef={inputRef}
          className="workgroup-room__input"
          rows={2}
          value={draft}
          placeholder={
            canPost ? t('workgroups.room.composerPlaceholder') : t('workgroups.room.terminalNotice')
          }
          disabled={!canPost || send.isPending}
          // Editable textbox with an associated listbox via active-descendant
          // (a multiline field can't be a combobox, so NO aria-expanded).
          aria-autocomplete="list"
          // Both references only point at the listbox while it is mounted —
          // a dangling aria-controls/activedescendant confuses screen readers.
          aria-controls={mentionOpen ? nav.listboxId : undefined}
          aria-activedescendant={mentionOpen ? nav.optionId(nav.activeIndex) : undefined}
          onChange={(value) => {
            setDraft(value)
            setCaret(inputRef.current?.selectionStart ?? value.length)
            // Any edit invalidates a prior Esc dismissal (so re-typing the
            // same @token after clearing/sending reopens the dropdown).
            setDismissed(null)
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
          onFocus={() => setComposerFocused(true)}
          onBlur={() => setComposerFocused(false)}
          onKeyDown={(e) => {
            const action = resolveComposerKey({
              key: e.key,
              metaKey: e.metaKey,
              ctrlKey: e.ctrlKey,
              altKey: e.altKey,
              shiftKey: e.shiftKey,
              isComposing: e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229,
              mentionOpen,
              candidateCount: suggestions.length,
              activeIndex: nav.activeIndex,
            })
            switch (action.type) {
              case 'send':
                e.preventDefault() // unconditional — never leak a newline
                if (canPost && !send.isPending && draft.trim().length > 0) {
                  sendFromKbdRef.current = true
                  send.mutate(draft.trim())
                }
                break
              case 'mention-move':
                e.preventDefault()
                nav.setActive(action.index)
                break
              case 'mention-commit': {
                e.preventDefault()
                const target = suggestions[action.index] ?? suggestions[0]
                if (target !== undefined) commitMention(target.displayName)
                break
              }
              case 'mention-close':
                e.preventDefault()
                setDismissed(mentionCtx)
                break
              case 'default':
                break
            }
          }}
          data-testid="workgroup-room-input"
        />
        <button
          type="button"
          className="btn btn--primary"
          disabled={!canPost || send.isPending || draft.trim().length === 0}
          onClick={() => send.mutate(draft.trim())}
          data-testid="workgroup-room-send"
        >
          {send.isPending ? t('workgroups.room.sending') : t('workgroups.room.send')}
        </button>
      </div>
      {canPost && (
        <div
          className="form-field__hint workgroup-room__composer-hint"
          data-testid="workgroup-room-shortcut-hint"
        >
          {t('workgroups.room.composerShortcutHint', { mod: sendChordModLabel() })}
        </div>
      )}
      {!canPost && (
        <div className="form-field__hint" data-testid="workgroup-room-terminal-notice">
          {t('workgroups.room.terminalNotice')}
        </div>
      )}
      {send.error !== null && send.error !== undefined && (
        <ErrorBanner error={send.error} testid="workgroup-room-send-error" />
      )}
    </div>
  )
}

/** memo: room-data refetches / the 1s duration ticker re-render the shell —
 *  the composer's props (taskId/canPost/config reference) stay stable, so it
 *  skips those renders entirely (and its keystrokes never leave it). */
export const RoomComposer = memo(RoomComposerInner)
