// 240px palette sidebar for the workflow editor. Each item is HTML5
// draggable; the drop side lives on the canvas.

import { useMemo, useState, type DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { Agent } from '@agent-workflow/shared'
import { PALETTE_MIME, buildPalette, serialize, type PaletteItem } from './nodePalette'

interface Props {
  agents: Agent[]
}

export function EditorSidebar({ agents }: Props) {
  const { t } = useTranslation()
  const [filter, setFilter] = useState('')
  const sections = useMemo(() => buildPalette(agents, t), [agents, t])

  const visible = useMemo(() => {
    if (filter.trim() === '') return sections
    const lower = filter.toLowerCase()
    return sections
      .map((s) => ({
        ...s,
        items: s.items.filter(
          (i) =>
            i.label.toLowerCase().includes(lower) || i.description.toLowerCase().includes(lower),
        ),
      }))
      .filter((s) => s.items.length > 0)
  }, [sections, filter])

  function onDragStart(e: DragEvent<HTMLDivElement>, item: PaletteItem) {
    e.dataTransfer.setData(PALETTE_MIME, serialize(item))
    e.dataTransfer.setData('text/plain', serialize(item))
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <aside className="editor-sidebar">
      <div className="editor-sidebar__filter">
        <input
          type="search"
          placeholder={t('editor.paletteFilter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="form-input form-input--sm"
        />
      </div>
      <div className="editor-sidebar__sections">
        {visible.map((section) => (
          <section key={section.label} className="editor-sidebar__section">
            <div className="editor-sidebar__title">{section.label}</div>
            <ul className="editor-sidebar__list">
              {section.items.map((entry, i) => (
                <li key={`${section.label}-${i}`}>
                  <div
                    role="button"
                    draggable
                    onDragStart={(e) => onDragStart(e, entry.item)}
                    className="editor-sidebar__item"
                    title={entry.description}
                  >
                    <div className="editor-sidebar__item-label">{entry.label}</div>
                    <div className="editor-sidebar__item-hint">{entry.description}</div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {visible.length === 0 && (
          <div className="muted editor-sidebar__empty">{t('editor.paletteNoMatches')}</div>
        )}
      </div>
    </aside>
  )
}
