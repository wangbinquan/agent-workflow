// Side-by-side markdown editor for agent body / SKILL.md.
//
// RFC-008 T3: the preview pane now uses the same <Prose> renderer that
// review docs use, so the editor preview supports the full GFM + GitHub
// callout + KaTeX + shiki feature surface. The body is fed through
// useDeferredValue so heavy renders don't gate keystrokes.

import {
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  MARKDOWN_DIVIDER_WIDTH,
  MARKDOWN_LAYOUT_STORAGE_KEY,
  markdownEditorLayout,
  parseMarkdownLayout,
  parseSavedMarkdownLayout,
  type MarkdownEditorMode,
  type MarkdownLayoutPreference,
  type MarkdownSinglePane,
} from '@/lib/markdown-editor-layout'
import { Prose } from './prose/Prose'
import { TextArea } from './Form'
import { Segmented } from './Segmented'

interface MarkdownEditorProps {
  value: string
  onChange: (v: string) => void
  rows?: number
  placeholder?: string
  /** RFC-169: fill the parent's height (the agent Prompt tab) instead of a
   *  fixed `rows` height — the editor grows to the tab content area. */
  fill?: boolean
  readOnly?: boolean
}

export function MarkdownEditor({
  value,
  onChange,
  rows = 18,
  placeholder,
  fill,
  readOnly,
}: MarkdownEditorProps) {
  const { t } = useTranslation()
  const deferred = useDeferredValue(value)
  const id = useId()
  const panesRef = useRef<HTMLDivElement>(null)
  const editRef = useRef<HTMLDivElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)
  const separatorRef = useRef<HTMLDivElement>(null)
  const activeModeRef = useRef<HTMLButtonElement>(null)
  const dragRef = useRef<{ pointerId: number; target: HTMLDivElement } | null>(null)
  const [dragging, setDragging] = useState(false)
  const [width, setWidth] = useState(0)
  const [savedPreference, setSavedPreference] = useState(() => {
    try {
      return parseSavedMarkdownLayout(localStorage.getItem(MARKDOWN_LAYOUT_STORAGE_KEY))
    } catch {
      return null
    }
  })
  // Loading resource metadata can temporarily make a writable page read-only.
  // Defaults follow that live state until the user actually chooses a layout
  // or interacts with a pane; mounting must not persist a transient default.
  const preference = savedPreference ?? parseMarkdownLayout(null, readOnly)
  const setPreference = (update: (current: MarkdownLayoutPreference) => MarkdownLayoutPreference) =>
    setSavedPreference((current) => update(current ?? parseMarkdownLayout(null, readOnly)))
  const layout = markdownEditorLayout(preference, width)

  useEffect(() => {
    if (savedPreference === null) return
    try {
      localStorage.setItem(MARKDOWN_LAYOUT_STORAGE_KEY, JSON.stringify(savedPreference))
    } catch {
      // Layout still works when browser storage is unavailable or full.
    }
  }, [savedPreference])

  useLayoutEffect(() => {
    const panes = panesRef.current
    if (panes === null) return
    const measure = () => {
      const next = panes.getBoundingClientRect().width
      // Keep-mounted route tabs report zero while hidden. Preserve their layout.
      if (next > 0) setWidth(next)
    }
    measure()
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure)
      observer.observe(panes)
      return () => observer.disconnect()
    }
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  const releasePointer = useCallback(() => {
    const drag = dragRef.current
    dragRef.current = null
    if (drag?.target.hasPointerCapture(drag.pointerId)) {
      drag.target.releasePointerCapture(drag.pointerId)
    }
  }, [])
  const stopDrag = useCallback(() => {
    releasePointer()
    setDragging(false)
  }, [releasePointer])
  useEffect(() => releasePointer, [releasePointer])

  useLayoutEffect(() => {
    if (layout.mode === 'split') return
    stopDrag()
    const hiddenPane = layout.mode === 'edit' ? previewRef.current : editRef.current
    const active = document.activeElement
    if (hiddenPane?.contains(active) || separatorRef.current === active) {
      activeModeRef.current?.focus()
    }
  }, [layout.mode, stopDrag])

  const rememberPane = (singlePane: MarkdownSinglePane) => {
    setPreference((current) =>
      current.singlePane === singlePane ? current : { ...current, singlePane },
    )
  }
  const selectMode = (mode: MarkdownEditorMode) => {
    setPreference((current) => ({
      ...current,
      mode,
      singlePane: mode === 'split' ? current.singlePane : mode,
    }))
  }
  const setRatio = (ratio: number) => setPreference((current) => ({ ...current, ratio }))
  const movePointer = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    const rect = panesRef.current?.getBoundingClientRect()
    if (rect === undefined) return
    const live = markdownEditorLayout(preference, rect.width)
    if (live.compact) {
      stopDrag()
      return
    }
    const ratio = (event.clientX - rect.left - MARKDOWN_DIVIDER_WIDTH / 2) / live.available
    setRatio(Math.max(live.min, Math.min(live.max, ratio)))
  }
  const endPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) stopDrag()
  }
  const resizeByKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    let ratio: number
    switch (event.key) {
      case 'ArrowLeft':
        ratio = layout.ratio - 0.02
        break
      case 'ArrowRight':
        ratio = layout.ratio + 0.02
        break
      case 'Home':
        ratio = layout.min
        break
      case 'End':
        ratio = layout.max
        break
      case 'Enter':
        event.preventDefault()
        selectMode('preview')
        return
      default:
        return
    }
    event.preventDefault()
    setRatio(Math.max(layout.min, Math.min(layout.max, ratio)))
  }

  return (
    <div
      className={fill === true ? 'md-editor md-editor--fill' : 'md-editor'}
      data-mode={layout.mode}
      data-dragging={dragging || undefined}
      data-testid="markdown-editor"
    >
      <div className="md-editor__toolbar">
        <span className="md-editor__label">
          {readOnly ? t('markdownEditor.readOnly') : 'Markdown'}
        </span>
        <div className="md-editor__tools">
          <Segmented<MarkdownEditorMode>
            value={layout.mode}
            onChange={selectMode}
            allowActiveReselect
            ariaLabel={t('markdownEditor.layout')}
            testidPrefix="markdown-mode"
            activeOptionRef={activeModeRef}
            options={(['edit', 'split', 'preview'] as const).map((mode) => ({
              value: mode,
              label: t(`markdownEditor.${mode}`),
              disabled: mode === 'split' && layout.compact,
              ariaDescribedBy: mode === 'split' && layout.compact ? `${id}-compact` : undefined,
              title:
                mode === 'split' && layout.compact ? t('markdownEditor.compactHint') : undefined,
            }))}
          />
          {layout.mode === 'split' && (
            <button type="button" className="btn btn--sm" onClick={() => setRatio(0.5)}>
              {t('markdownEditor.equalSplit')}
            </button>
          )}
        </div>
        {layout.compact && (
          <span id={`${id}-compact`} className="md-editor__hint">
            {t('markdownEditor.compactHint')}
          </span>
        )}
      </div>
      <div
        className="md-editor__panes"
        ref={panesRef}
        style={{
          gridTemplateColumns:
            layout.mode === 'split'
              ? `minmax(0, ${layout.ratio}fr) ${MARKDOWN_DIVIDER_WIDTH}px minmax(0, ${1 - layout.ratio}fr)`
              : 'minmax(0, 1fr)',
        }}
      >
        <div
          id={`${id}-edit`}
          ref={editRef}
          className="md-editor__pane md-editor__pane--edit"
          hidden={layout.mode === 'preview'}
          onFocusCapture={() => rememberPane('edit')}
        >
          <label className="md-editor__label" htmlFor={`${id}-source`}>
            {t('agentForm.markdownEditLabel')}
          </label>
          <TextArea
            id={`${id}-source`}
            value={value}
            onChange={onChange}
            rows={rows}
            placeholder={placeholder}
            monospace
            readOnly={readOnly}
            data-testid="markdown-source"
          />
        </div>
        <div
          ref={separatorRef}
          className="md-editor__separator"
          hidden={layout.mode !== 'split'}
          role="separator"
          tabIndex={0}
          aria-label={t('markdownEditor.resize')}
          aria-orientation="vertical"
          aria-controls={`${id}-edit`}
          aria-valuemin={Math.round(layout.min * 100)}
          aria-valuemax={Math.round(layout.max * 100)}
          aria-valuenow={Math.round(layout.ratio * 100)}
          aria-valuetext={t('markdownEditor.ratio', { percent: Math.round(layout.ratio * 100) })}
          aria-describedby={`${id}-resize-help`}
          title={t('markdownEditor.resizeHint')}
          onPointerDown={(event) => {
            if (event.button !== 0 || dragRef.current !== null) return
            event.preventDefault()
            event.currentTarget.focus()
            event.currentTarget.setPointerCapture(event.pointerId)
            dragRef.current = { pointerId: event.pointerId, target: event.currentTarget }
            setDragging(true)
          }}
          onPointerMove={movePointer}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          onLostPointerCapture={endPointer}
          onDoubleClick={() => setRatio(0.5)}
          onKeyDown={resizeByKeyboard}
        />
        <div
          ref={previewRef}
          className="md-editor__pane md-editor__pane--preview"
          hidden={layout.mode === 'edit'}
          onFocusCapture={() => rememberPane('preview')}
          onPointerDownCapture={() => rememberPane('preview')}
        >
          <div id={`${id}-preview-label`} className="md-editor__label">
            {t('agentForm.markdownPreviewLabel')}
          </div>
          <div
            className="md-editor__preview"
            role="region"
            aria-labelledby={`${id}-preview-label`}
            tabIndex={0}
          >
            {deferred.trim() === '' ? (
              <div className="md-preview__empty">{t('agentForm.markdownPreviewEmpty')}</div>
            ) : (
              <Prose body={deferred} />
            )}
          </div>
        </div>
      </div>
      <span id={`${id}-resize-help`} className="sr-only">
        {t('markdownEditor.resizeHint')}
      </span>
    </div>
  )
}
