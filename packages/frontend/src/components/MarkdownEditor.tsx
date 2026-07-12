// Side-by-side markdown editor for agent body / SKILL.md.
//
// RFC-008 T3: the preview pane now uses the same <Prose> renderer that
// review docs use, so the editor preview supports the full GFM + GitHub
// callout + KaTeX + shiki feature surface. The body is fed through
// useDeferredValue so heavy renders don't gate keystrokes.

import { useDeferredValue } from 'react'
import { useTranslation } from 'react-i18next'
import { Prose } from './prose/Prose'
import { TextArea } from './Form'

interface MarkdownEditorProps {
  value: string
  onChange: (v: string) => void
  rows?: number
  placeholder?: string
  /** RFC-169: fill the parent's height (the agent Prompt tab) instead of a
   *  fixed `rows` height — the editor grows to the tab content area. */
  fill?: boolean
}

export function MarkdownEditor({
  value,
  onChange,
  rows = 18,
  placeholder,
  fill,
}: MarkdownEditorProps) {
  const { t } = useTranslation()
  const deferred = useDeferredValue(value)
  return (
    <div className={fill === true ? 'md-editor md-editor--fill' : 'md-editor'}>
      <div className="md-editor__pane md-editor__pane--edit">
        <div className="md-editor__label">{t('agentForm.markdownEditLabel')}</div>
        <TextArea
          value={value}
          onChange={onChange}
          rows={rows}
          placeholder={placeholder}
          monospace
        />
      </div>
      <div className="md-editor__pane md-editor__pane--preview">
        <div className="md-editor__label">{t('agentForm.markdownPreviewLabel')}</div>
        {deferred.trim() === '' ? (
          <div className="md-editor__preview md-preview__empty">
            {t('agentForm.markdownPreviewEmpty')}
          </div>
        ) : (
          <Prose body={deferred} className="md-editor__preview" />
        )}
      </div>
    </div>
  )
}
