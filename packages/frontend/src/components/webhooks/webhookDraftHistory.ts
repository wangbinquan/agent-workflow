export type WebhookDraftMutation =
  | { readonly kind: 'typing'; readonly field: string }
  | { readonly kind: 'atomic' }

interface PendingTyping<T> {
  readonly field: string
  readonly baseline: T
}

/**
 * One history owner for the entire controlled Webhook rule draft.
 *
 * Text-like controls coalesce all mutations made during one focus session;
 * picker/Select/button changes are atomic. The class is intentionally UI-free
 * so shortcuts, beforeinput and visible actions all execute the same rules.
 */
export class WebhookDraftHistory<T> {
  readonly #equals: (left: T, right: T) => boolean
  #past: T[] = []
  #present: T
  #future: T[] = []
  #pending: PendingTyping<T> | null = null

  constructor(initial: T, equals: (left: T, right: T) => boolean = Object.is) {
    this.#present = initial
    this.#equals = equals
  }

  get current(): T {
    return this.#present
  }

  get canUndo(): boolean {
    return (
      this.#past.length > 0 ||
      (this.#pending !== null && !this.#equals(this.#pending.baseline, this.#present))
    )
  }

  get canRedo(): boolean {
    return this.#future.length > 0
  }

  get hasPendingTyping(): boolean {
    return this.#pending !== null
  }

  apply(next: T, mutation: WebhookDraftMutation): boolean {
    if (this.#equals(next, this.#present)) return false

    if (mutation.kind === 'typing') {
      if (this.#pending !== null && this.#pending.field !== mutation.field) {
        this.commitTyping(this.#pending.field)
      }
      this.#pending ??= { field: mutation.field, baseline: this.#present }
      this.#present = next
      // Any accepted user mutation after Undo truncates the redo branch.
      this.#future = []
      return true
    }

    this.commitTyping()
    this.#past.push(this.#present)
    this.#present = next
    this.#future = []
    return true
  }

  commitTyping(field?: string): boolean {
    const pending = this.#pending
    if (pending === null || (field !== undefined && pending.field !== field)) return false
    this.#pending = null
    if (this.#equals(pending.baseline, this.#present)) return false
    this.#past.push(pending.baseline)
    return true
  }

  /** Apply derived/query state without manufacturing a user-visible history item. */
  replaceCurrent(next: T): boolean {
    if (this.#equals(next, this.#present)) return false
    this.#present = next
    return true
  }

  undo(): T | null {
    this.commitTyping()
    const previous = this.#past.pop()
    if (previous === undefined) return null
    this.#future.push(this.#present)
    this.#present = previous
    return previous
  }

  redo(): T | null {
    this.commitTyping()
    const next = this.#future.pop()
    if (next === undefined) return null
    this.#past.push(this.#present)
    this.#present = next
    return next
  }

  reset(next: T): void {
    this.#past = []
    this.#present = next
    this.#future = []
    this.#pending = null
  }
}
