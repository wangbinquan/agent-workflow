// RFC-258 §4.3 — the source-navigation session as a PURE reducer (gate F-17:
// the session is modelled explicitly — every jump snapshots WHERE YOU WERE,
// including view mode and scroll, so pop restores the exact pre-jump view;
// consecutive identical targets dedupe; leaving the session clears the stack).

export interface CodeNavEntry {
  repoKey: string
  side: 'base' | 'worktree'
  filePath: string
  /** Line to focus on return/arrival (optional for whole-file entries). */
  line?: number
  col?: number
  /** The view the user was in when they jumped (restored on pop). */
  viewMode: 'hunk' | 'full'
  scrollTop?: number
}

export interface CodeNavState {
  /** History of PREVIOUS positions, oldest first. The present position lives
   *  in the host component; the stack only holds what pop returns to. */
  stack: readonly CodeNavEntry[]
}

export const CODE_NAV_EMPTY: CodeNavState = { stack: [] }

export type CodeNavAction =
  | { type: 'push'; from: CodeNavEntry }
  | { type: 'pop' }
  | { type: 'clear' }

function sameSpot(a: CodeNavEntry, b: CodeNavEntry): boolean {
  return (
    a.repoKey === b.repoKey && a.side === b.side && a.filePath === b.filePath && a.line === b.line
  )
}

export function codeNavReducer(state: CodeNavState, action: CodeNavAction): CodeNavState {
  switch (action.type) {
    case 'push': {
      const top = state.stack[state.stack.length - 1]
      if (top !== undefined && sameSpot(top, action.from)) return state
      return { stack: [...state.stack, action.from] }
    }
    case 'pop': {
      if (state.stack.length === 0) return state
      return { stack: state.stack.slice(0, -1) }
    }
    case 'clear':
      return state.stack.length === 0 ? state : CODE_NAV_EMPTY
  }
}

/** The entry pop would return to (breadcrumb rendering). */
export function codeNavTop(state: CodeNavState): CodeNavEntry | null {
  return state.stack[state.stack.length - 1] ?? null
}
