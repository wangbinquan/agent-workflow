// RFC-253 T33 — THE code-editing primitive.
//
// Before this component the repo had exactly one way to edit code-shaped text:
// `<TextArea monospace>`. That is fine for a two-line JSON blob and hostile for
// a hundred-line python script, so RFC-253 introduces CodeMirror 6 ONCE, here,
// as a shared primitive.
//
// ⚠ HONEST STATUS (impl-gate Codex 10, 2026-08-04): this previously said the
// MCP config field, the plugin options field and the workflow YAML import all
// render it. They do not — every one of them is still a `<TextArea>`; only the
// script node uses this component. The migration is RFC-253 D16's unfinished
// half, tracked in plan.md T39 and docs/audit-backlog.md. Written in the shape
// a second caller can adopt, but it does not yet have one.
//
// Design constraints that are load-bearing, not decoration:
//   - Theme follows the PLATFORM's CSS variables (--bg / --text / --border /
//     --accent), so light/dark switch with everything else and no second
//     palette can drift from the first.
//   - The focus ring is the `.form-input:focus` ring, inset, for the exact
//     reason documented at styles.css:4435 (an outset ring gets clipped by any
//     flush scroll container — the recurring "边框被切掉" bug).
//   - Tab inserts indentation, but Escape-then-Tab moves focus. A code editor
//     that swallows Tab unconditionally is a keyboard trap and fails AC-29.

import { useEffect, useMemo, useRef } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers, highlightActiveLine, placeholder } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  HighlightStyle,
  StreamLanguage,
  syntaxHighlighting,
  indentUnit,
  bracketMatching,
} from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { python } from '@codemirror/lang-python'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { yaml } from '@codemirror/lang-yaml'
import { shell } from '@codemirror/legacy-modes/mode/shell'

export type CodeEditorLanguage = 'python' | 'bash' | 'javascript' | 'json' | 'yaml' | 'plain'

function languageExtension(language: CodeEditorLanguage): Extension[] {
  switch (language) {
    case 'python':
      return [python()]
    case 'javascript':
      return [javascript()]
    case 'json':
      return [json()]
    case 'yaml':
      return [yaml()]
    case 'bash':
      return [StreamLanguage.define(shell)]
    case 'plain':
      return []
  }
}

/**
 * Token colors come from `--code-*` variables declared in styles.css beside
 * every other themed color, so light and dark are defined in ONE place. Putting
 * literals here would strand the dark palette somewhere the theme can't reach.
 */
const highlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--code-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--code-string)' },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: 'var(--code-comment)',
    fontStyle: 'italic',
  },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--code-number)' },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: 'var(--code-function)',
  },
  { tag: [tags.typeName, tags.className], color: 'var(--code-type)' },
  { tag: tags.operator, color: 'var(--code-operator)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--code-property)' },
])

const baseTheme = EditorView.theme({
  '&': {
    fontSize: '13px',
    border: '1px solid var(--border)',
    borderRadius: '6px',
    background: 'var(--bg)',
    color: 'var(--text)',
  },
  // Matches .form-input:focus (styles.css:4443) — inset so a flush container
  // cannot clip it.
  '&.cm-focused': {
    outline: '2px solid var(--accent)',
    outlineOffset: 'var(--focus-ring-offset-inset, -2px)',
    borderColor: 'transparent',
  },
  '.cm-content': {
    fontFamily: 'var(--font-mono)',
    padding: '7px 0',
  },
  '.cm-gutters': {
    background: 'transparent',
    color: 'var(--muted)',
    border: 'none',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLine': { background: 'color-mix(in srgb, var(--accent) 6%, transparent)' },
  '.cm-activeLineGutter': { background: 'transparent' },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection': {
    background: 'color-mix(in srgb, var(--accent) 22%, transparent)',
  },
  '.cm-placeholder': { color: 'var(--muted)' },
  '&.cm-editor.cm-readonly .cm-content': { opacity: '0.75' },
})

export interface CodeEditorProps {
  value: string
  onChange?: (value: string) => void
  language: CodeEditorLanguage
  readOnly?: boolean
  /** Fill the height of a flex/grid parent instead of using line-count sizing. */
  fill?: boolean
  /** Minimum visible height, in lines. */
  minLines?: number
  /** Maximum height before the editor scrolls internally, in lines. */
  maxLines?: number
  placeholder?: string
  'aria-label'?: string
  'data-testid'?: string
}

const LINE_HEIGHT_PX = 19

export function CodeEditor({
  value,
  onChange,
  language,
  readOnly = false,
  fill = false,
  minLines = 8,
  maxLines = 32,
  placeholder: placeholderText,
  'aria-label': ariaLabel,
  'data-testid': testId,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  // A controlled-value reconciliation is not a user edit. This guard is
  // especially load-bearing when two views show the same buffer (RFC-267's
  // inline + full-screen script editors): without it, one user's keystroke in
  // one view is echoed by the other view as a second onChange/history update.
  const reconcilingValueRef = useRef(false)
  // Keep the latest onChange reachable without rebuilding the editor on every
  // parent render (a rebuild would drop the cursor and the undo history).
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const extensions = useMemo<Extension[]>(
    () => [
      lineNumbers(),
      history(),
      bracketMatching(),
      highlightActiveLine(),
      indentUnit.of('  '),
      syntaxHighlighting(highlightStyle),
      baseTheme,
      EditorView.lineWrapping,
      // `indentWithTab` LAST so the default keymap still owns Escape; the pair
      // is what makes Tab indent while Escape-then-Tab still leaves the editor.
      keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
      ...languageExtension(language),
      ...(placeholderText === undefined ? [] : [placeholder(placeholderText)]),
      EditorState.readOnly.of(readOnly),
      EditorView.editable.of(!readOnly),
      EditorView.theme(
        fill
          ? {
              '&': { height: '100%', minHeight: '0' },
              '.cm-scroller': {
                height: '100%',
                minHeight: '0',
                maxHeight: 'none',
                overflow: 'auto',
              },
            }
          : {
              '.cm-scroller': {
                minHeight: `${minLines * LINE_HEIGHT_PX}px`,
                maxHeight: `${maxLines * LINE_HEIGHT_PX}px`,
                overflow: 'auto',
              },
            },
      ),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || reconcilingValueRef.current) return
        onChangeRef.current?.(update.state.doc.toString())
      }),
    ],
    [language, readOnly, fill, minLines, maxLines, placeholderText],
  )

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: host,
    })
    if (ariaLabel !== undefined) view.contentDOM.setAttribute('aria-label', ariaLabel)
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // `value` is deliberately absent: it seeds the initial doc only. Later
    // parent-driven changes are reconciled by the effect below, which preserves
    // the cursor instead of recreating the editor under the user's hands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extensions, ariaLabel])

  useEffect(() => {
    const view = viewRef.current
    if (view === null) return
    const current = view.state.doc.toString()
    if (current === value) return
    reconcilingValueRef.current = true
    try {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    } finally {
      reconcilingValueRef.current = false
    }
  }, [value])

  return (
    <div
      className={`code-editor${readOnly ? ' code-editor--readonly' : ''}${fill ? ' code-editor--fill' : ''}`}
      ref={hostRef}
      data-testid={testId}
      data-language={language}
      data-readonly={readOnly ? 'true' : 'false'}
      data-fill={fill ? 'true' : 'false'}
    />
  )
}
