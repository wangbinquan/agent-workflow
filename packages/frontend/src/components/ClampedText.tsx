// Shared "long text, folded" primitive.
//
// Motivation: several surfaces show text whose length is user-supplied and
// unbounded (a workgroup goal, a memory candidate body, …) inside a container
// that must stay scannable. The naive treatment — a bare `max-height` +
// `overflow: hidden` — hard-clips mid-sentence with NO affordance to read on,
// which is a data-visibility bug, not a styling choice (the workgroup room's
// 工作组信息 goal shipped exactly that: styles.css even claimed "full text via
// title" while the JSX never set a `title`).
//
// This component is the canonical treatment: clamp to a line budget, fade the
// bottom edge so the fold is visible, and expose a 展开 / 收起 toggle. Short
// text renders as the bare element with no wrapper and no button, so callers
// pay nothing for the common case.
//
// Clamping decision is CONTENT-based (line count + character budget) rather
// than measured (`scrollHeight > clientHeight`): jsdom performs no layout, so a
// measured fold would be untestable and would flicker on first paint. The
// character budget is what catches a single long unbroken paragraph, which is
// the common shape for a goal.
//
// Reuse note: components/memory/MemoryApprovalQueue.tsx has a bespoke
// `CollapsibleBody` predating this primitive. It is a migration candidate, but
// its clamp height (14rem) does not correspond to its 8-line threshold, so
// folding it in here would silently change that queue's visuals — left alone
// deliberately; migrate it when that surface is next touched on purpose.

import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'

export interface ClampedTextProps {
  /** The full text. Always rendered in the DOM — the fold is CSS-only, so
   *  screen readers and Ctrl-F still reach the hidden tail. */
  text: string
  /**
   * Visible line budget while folded. Drives both the CSS clamp height and
   * the newline-count half of the "does this need a toggle" test.
   */
  maxLines?: number
  /**
   * Character budget while folded. Catches long single-paragraph text that
   * has no newlines to count but still wraps past `maxLines`. Defaults to a
   * conservative ~28 chars per line.
   */
  maxChars?: number
  /** Element for the text itself. `pre` preserves author whitespace. */
  as?: 'div' | 'p' | 'pre'
  /** Extra classes appended after the standard `.clamped-text__body` chain. */
  className?: string
  'data-testid'?: string
  /** testid for the toggle button; omit to leave it untagged. */
  toggleTestId?: string
}

/** Newline-separated line count (cheap, matches the folded rendering closely
 *  enough for a threshold — wrapped soft lines are covered by `maxChars`). */
function countLines(text: string): number {
  let n = 1
  for (const ch of text) if (ch === '\n') n += 1
  return n
}

export function ClampedText(props: ClampedTextProps): ReactElement {
  const { t } = useTranslation()
  const maxLines = props.maxLines ?? 4
  const maxChars = props.maxChars ?? maxLines * 28
  const [expanded, setExpanded] = useState(false)
  const Tag = props.as ?? 'div'
  const needsToggle = countLines(props.text) > maxLines || props.text.length > maxChars

  const bodyClasses = ['clamped-text__body']
  if (needsToggle && !expanded) bodyClasses.push('clamped-text__body--clamped')
  if (props.className !== undefined && props.className !== '') bodyClasses.push(props.className)

  const body = (
    <Tag
      className={bodyClasses.join(' ')}
      // `--clamped-text-lines` feeds the CSS max-height so one component
      // serves every line budget without a class per size.
      style={{ ['--clamped-text-lines' as string]: String(maxLines) }}
      data-expanded={needsToggle ? (expanded ? 'true' : 'false') : undefined}
      data-testid={props['data-testid']}
    >
      {props.text}
    </Tag>
  )

  // Short text: no wrapper, no button — byte-identical to rendering the
  // element directly, so callers can adopt this without layout churn.
  if (!needsToggle) return body

  return (
    <div className="clamped-text">
      {body}
      <button
        type="button"
        className="btn btn--xs clamped-text__toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        data-testid={props.toggleTestId}
      >
        {expanded ? t('common.collapseText') : t('common.expandText')}
      </button>
    </div>
  )
}
