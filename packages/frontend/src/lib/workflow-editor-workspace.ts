import { useSyncExternalStore } from 'react'

export type WorkflowEditorWorkspaceMode = 'wide' | 'medium' | 'compact' | 'phone'

export function workflowEditorWorkspaceMode(width: number): WorkflowEditorWorkspaceMode {
  if (width >= 1536) return 'wide'
  if (width >= 1180) return 'medium'
  if (width >= 721) return 'compact'
  return 'phone'
}

function currentWidth(): number {
  return typeof window === 'undefined' ? 1536 : window.innerWidth
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  window.addEventListener('resize', onChange)
  return () => window.removeEventListener('resize', onChange)
}

export function useWorkflowEditorWorkspaceMode(): WorkflowEditorWorkspaceMode {
  const width = useSyncExternalStore(subscribe, currentWidth, () => 1536)
  return workflowEditorWorkspaceMode(width)
}

export function workspaceHasPaletteRail(mode: WorkflowEditorWorkspaceMode): boolean {
  return mode === 'wide'
}

export function workspaceHasInspectorRail(mode: WorkflowEditorWorkspaceMode): boolean {
  return mode === 'wide' || mode === 'medium'
}
