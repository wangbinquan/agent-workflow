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
}

export function EditorPaletteContent({
  agents,
  onAdd,
  initialFocusRef,
  showDragGrip = true,
  className,
}: EditorPaletteContentProps) {
  return (
    <WorkflowNodePickerCatalog
      agents={agents}
      onPick={onAdd}
      showDragGrip={showDragGrip}
      className={className}
      initialFocusRef={initialFocusRef}
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
