// 240px palette sidebar for the workflow editor. The row/search/catalog is
// shared with the modal WorkflowNodePicker; only the desktop drag grip is a
// sidebar enhancement.

import type { Agent } from '@agent-workflow/shared'
import type { RefObject } from 'react'
import { WorkflowNodePickerCatalog } from '../workflow-editor/WorkflowNodePicker'
import type { PaletteItem } from './nodePalette'

export interface EditorPaletteContentProps {
  agents: Agent[]
  onAdd: (item: PaletteItem) => void
  initialFocusRef?: RefObject<HTMLInputElement | null>
  showDragGrip?: boolean
  className?: string
  /**
   * RFC-270 — why this row cannot be used, or `null` when it can. The catalog
   * has always accepted this prop; until RFC-270 nobody passed it, so the
   * `script` / `code-host-call` rows were draggable by users who could not save
   * them. Threaded (rather than read inside the catalog) because the catalog is
   * a presentation primitive with no business rules of its own.
   */
  disabledReason?: (item: PaletteItem) => string | null
}

export function EditorPaletteContent({
  agents,
  onAdd,
  initialFocusRef,
  showDragGrip = true,
  className,
  disabledReason,
}: EditorPaletteContentProps) {
  return (
    <WorkflowNodePickerCatalog
      agents={agents}
      onPick={onAdd}
      showDragGrip={showDragGrip}
      className={className}
      initialFocusRef={initialFocusRef}
      disabledReason={disabledReason}
    />
  )
}

export function EditorSidebar(props: EditorPaletteContentProps) {
  return (
    <aside className="editor-sidebar">
      <EditorPaletteContent {...props} showDragGrip className="workflow-node-picker--sidebar" />
    </aside>
  )
}
