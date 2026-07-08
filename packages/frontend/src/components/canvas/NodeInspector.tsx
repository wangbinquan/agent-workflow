// Right-side 480px inspector drawer. Opens when the canvas reports a
// selected node; closes when the selection clears. Two tabs: Edit (form)
// and Preview (live prompt assembly).
//
// RFC-146 T3: the 1100-line per-kind `EditForm` switch became the
// `KIND_INSPECTORS` registry — one Edit component per kind under
// `./inspector/` (wrapper-git and wrapper-loop share one component, matching
// their historical shared case). `satisfies Record<NodeKind, …>` makes
// adding a NodeKind without an inspector a compile error — the same shape as
// the canvas `NODE_TYPES` renderer registry.
//
// The drawer mutates the workflow definition in place; the parent route
// owns the dirty/save bookkeeping.

import type { Agent, NodeKind, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { useEffect, useState } from 'react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
import { computePorts } from './WorkflowCanvas'
import { PromptPreview } from './PromptPreview'
import { AgentSingleEdit } from './inspector/AgentSingleEdit'
import { ClarifyEdit } from './inspector/ClarifyEdit'
import { CrossClarifyEdit } from './inspector/CrossClarifyEdit'
import { InputEdit } from './inspector/InputEdit'
import { OutputEdit } from './inspector/OutputEdit'
import { ReviewEdit } from './inspector/ReviewEdit'
import { WrapperFanoutEdit } from './inspector/WrapperFanoutEdit'
import { WrapperGitLoopEdit } from './inspector/WrapperGitLoopEdit'
import type { EditProps } from './inspector/types'

// Re-exported for unit tests + historical import path compatibility (the
// helper moved to ./inspector/promptRefs with the agent Edit component).
export { extractMissingRefs } from './inspector/promptRefs'

interface Props {
  definition: WorkflowDefinition
  selectedNodeId: string | null
  agents: Agent[]
  onChange: (next: WorkflowDefinition) => void
  onClose: () => void
}

type Tab = 'edit' | 'preview'

/**
 * Per-kind Edit form registry — same shape as the canvas NODE_TYPES
 * renderer registry. A new NodeKind fails to compile here until it
 * declares its inspector.
 */
const KIND_INSPECTORS = {
  'agent-single': AgentSingleEdit,
  input: InputEdit,
  output: OutputEdit,
  'wrapper-git': WrapperGitLoopEdit,
  'wrapper-loop': WrapperGitLoopEdit,
  'wrapper-fanout': WrapperFanoutEdit,
  review: ReviewEdit,
  clarify: ClarifyEdit,
  'clarify-cross-agent': CrossClarifyEdit,
} as const satisfies Record<NodeKind, FC<EditProps>>

export function NodeInspector({ definition, selectedNodeId, agents, onChange, onClose }: Props) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('edit')

  // Reset to edit tab whenever the selection changes.
  useEffect(() => {
    setTab('edit')
  }, [selectedNodeId])

  if (selectedNodeId === null) return null
  const node = definition.nodes.find((n) => n.id === selectedNodeId)
  if (node === undefined) return null

  // PreviewPane only renders prompt-template assembly for agent kinds; other
  // kinds previously got a disabled tab + "preview only available for agents"
  // muted message. Hiding the tab entirely (per user feedback) drops the
  // dead surface and avoids the implicit "this is greyed out for a reason"
  // confusion. Force the active tab back to edit when previewing isn't
  // available so a stale `tab === 'preview'` from a prior agent selection
  // doesn't render an empty pane.
  const hasPreview = node.kind === 'agent-single'
  const activeTab: Tab = !hasPreview ? 'edit' : tab

  function patch(next: WorkflowNode) {
    const nodes = definition.nodes.map((n) => (n.id === next.id ? next : n))
    onChange({ ...definition, nodes })
  }

  return (
    <aside className="inspector">
      <header className="inspector__header">
        <div>
          <div className="inspector__kind">{node.kind}</div>
          <div className="inspector__id">
            <code>{node.id}</code>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inspector__close"
          aria-label={t('inspector.closeAria')}
        >
          ×
        </button>
      </header>
      <div className="tabs tabs--inspector">
        <button
          type="button"
          className={`tabs__tab ${activeTab === 'edit' ? 'tabs__tab--active' : ''}`}
          onClick={() => setTab('edit')}
        >
          {t('inspector.tabEdit')}
        </button>
        {hasPreview && (
          <button
            type="button"
            className={`tabs__tab ${activeTab === 'preview' ? 'tabs__tab--active' : ''}`}
            onClick={() => setTab('preview')}
          >
            {t('inspector.tabPreview')}
          </button>
        )}
      </div>
      <div className="inspector__body">
        {activeTab === 'edit' ? (
          <EditForm
            node={node}
            agents={agents}
            definition={definition}
            onPatch={patch}
            onCommitDef={onChange}
          />
        ) : (
          <PreviewPane node={node} agents={agents} definition={definition} />
        )}
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------------------
// Edit tab — registry dispatch
// ---------------------------------------------------------------------------

function EditForm(props: EditProps) {
  const KindEdit = (KIND_INSPECTORS as Record<string, FC<EditProps>>)[props.node.kind] as
    | FC<EditProps>
    | undefined
  // Unknown kind (stale/corrupt snapshot): the historical switch fell
  // through and rendered nothing — keep that explicit.
  if (KindEdit === undefined) return null
  return <KindEdit {...props} />
}

// ---------------------------------------------------------------------------
// Preview tab
// ---------------------------------------------------------------------------

interface PreviewProps {
  node: WorkflowNode
  agents: Agent[]
  definition: WorkflowDefinition
}

function PreviewPane({ node, agents, definition }: PreviewProps) {
  const { t } = useTranslation()
  if (node.kind !== 'agent-single') {
    return <div className="muted">{t('inspector.previewOnlyAgent')}</div>
  }
  const agentName = (node as Record<string, unknown>).agentName as string | undefined
  const agent = agents.find((a) => a.name === agentName)
  const template = (node as Record<string, unknown>).promptTemplate as string | undefined
  const ports = computePorts(node, new Map(agents.map((a) => [a.name, a])), definition)
  return (
    <PromptPreview
      template={template ?? ''}
      inputPorts={ports.inputs}
      outputs={agent?.outputs ?? []}
      outputKinds={agent?.outputKinds}
    />
  )
}
