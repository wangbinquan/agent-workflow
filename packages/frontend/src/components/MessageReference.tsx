interface AvailableMessageReferenceProps {
  author: string
  body: string
  ariaLabel: string
  onActivate: () => void
  unavailable?: false
  unavailableLabel?: never
  testId?: string
}

interface UnavailableMessageReferenceProps {
  unavailable: true
  unavailableLabel: string
  author?: never
  body?: never
  ariaLabel?: never
  onActivate?: never
  testId?: string
}

export type MessageReferenceProps =
  | AvailableMessageReferenceProps
  | UnavailableMessageReferenceProps

/**
 * Compact, one-level quote preview shared by chat surfaces.
 *
 * The caller owns lookup and navigation so this primitive stays independent
 * from any room's message model. A missing target deliberately renders as
 * non-interactive text instead of a dead button.
 */
export function MessageReference(props: MessageReferenceProps) {
  if (props.unavailable) {
    return (
      <div
        className="message-reference message-reference--unavailable"
        role="note"
        data-testid={props.testId}
      >
        <span className="message-reference__unavailable">{props.unavailableLabel}</span>
      </div>
    )
  }

  return (
    <button
      type="button"
      className="message-reference message-reference--interactive"
      aria-label={props.ariaLabel}
      onClick={props.onActivate}
      data-testid={props.testId}
    >
      <span className="message-reference__author">{props.author}</span>
      <span className="message-reference__body">{props.body}</span>
    </button>
  )
}
