// Shared inspector content. Wide/medium workspaces place it in a rail;
// compact/phone workspaces place the same content in a Dialog. It opens when
// the canvas reports a selected node and closes when the selection clears.
// Two tabs: Edit (form) and Preview (live prompt assembly).
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
import { useEffect, useMemo, useState } from 'react'
import type { FC } from 'react'
import { useTranslation } from 'react-i18next'
import { TabBar, tabDomIds, type TabDef } from '@/components/TabBar'
import { NoticeBanner } from '@/components/NoticeBanner'
import { computePorts } from './WorkflowCanvas'
import { nodeTitle } from './nodeTitle'
import { PromptPreview } from './PromptPreview'
import { AgentSingleEdit } from './inspector/AgentSingleEdit'
import { ClarifyEdit } from './inspector/ClarifyEdit'
import { CrossClarifyEdit } from './inspector/CrossClarifyEdit'
import { InputEdit } from './inspector/InputEdit'
import { OutputEdit } from './inspector/OutputEdit'
import { ReviewEdit } from './inspector/ReviewEdit'
import { WrapperFanoutEdit } from './inspector/WrapperFanoutEdit'
import { WrapperGitLoopEdit } from './inspector/WrapperGitLoopEdit'
import type { InspectorChangeMeta } from './inspector/historyMeta'
import type { EditProps } from './inspector/types'
import { createWorkflowSemanticContext } from '@/lib/workflow-connection-plan'
import {
  focusWorkflowInspectorAnchor,
  workflowInspectorHeadingId,
} from '@/lib/workflow-inspector-target'
import {
  applyWorkflowTransition,
  type WorkflowTransition,
  type WorkflowTransitionResult,
} from '@/lib/workflow-transition'

export type { InspectorChangeMeta } from './inspector/historyMeta'

// Re-exported for unit tests + historical import path compatibility (the
// helper moved to ./inspector/promptRefs with the agent Edit component).
export { extractMissingRefs } from './inspector/promptRefs'

export interface NodeInspectorProps {
  definition: WorkflowDefinition
  selectedNodeId: string | null
  agents: Agent[]
  focusRequest?: { requestId: number; focusId: string } | null
  onChange: (next: WorkflowDefinition, meta: InspectorChangeMeta) => void
  onClose: () => void
  /** Compact/phone equivalent of the selected-node canvas toolbar action. */
  onConnect?: (nodeId: string, trigger: HTMLElement) => void
  chrome?: 'rail' | 'content'
}

type Tab = 'edit' | 'preview'

const NODE_INSPECTOR_TAB_PREFIX = 'workflow-node-inspector'

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

export function NodeInspector({
  definition,
  selectedNodeId,
  agents,
  focusRequest,
  onChange,
  onClose,
  onConnect,
  chrome = 'rail',
}: NodeInspectorProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('edit')
  const [transitionNotice, setTransitionNotice] = useState<string | null>(null)
  const semanticContext = useMemo(() => createWorkflowSemanticContext(agents), [agents])

  // Reset to edit tab whenever the selection changes.
  useEffect(() => {
    setTab('edit')
    setTransitionNotice(null)
  }, [selectedNodeId])

  useEffect(() => {
    if (focusRequest === null || focusRequest === undefined || selectedNodeId === null) return
    setTab('edit')
    let secondFrame = 0
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        focusWorkflowInspectorAnchor(focusRequest.focusId)
      })
    })
    return () => {
      window.cancelAnimationFrame(firstFrame)
      window.cancelAnimationFrame(secondFrame)
    }
  }, [focusRequest, selectedNodeId])

  if (selectedNodeId === null) return null
  const node = definition.nodes.find((n) => n.id === selectedNodeId)
  if (node === undefined) return null
  const headingId = workflowInspectorHeadingId(node.id)
  const ports = computePorts(node, new Map(agents.map((agent) => [agent.name, agent])), definition)
  const displayTitle = nodeTitle(node)

  // PreviewPane only renders prompt-template assembly for agent kinds; other
  // kinds previously got a disabled tab + "preview only available for agents"
  // muted message. Hiding the tab entirely (per user feedback) drops the
  // dead surface and avoids the implicit "this is greyed out for a reason"
  // confusion. Force the active tab back to edit when previewing isn't
  // available so a stale `tab === 'preview'` from a prior agent selection
  // doesn't render an empty pane.
  const hasPreview = node.kind === 'agent-single'
  const activeTab: Tab = !hasPreview ? 'edit' : tab
  const inspectorTabs: Array<TabDef<Tab>> = [
    { key: 'edit', label: t('inspector.tabEdit') },
    ...(hasPreview ? [{ key: 'preview', label: t('inspector.tabPreview') } as TabDef<Tab>] : []),
  ]

  function patch(next: WorkflowNode, meta: InspectorChangeMeta) {
    const nodes = definition.nodes.map((n) => (n.id === next.id ? next : n))
    commitDefinition({ ...definition, nodes }, meta)
  }

  function commitDefinition(next: WorkflowDefinition, meta: InspectorChangeMeta) {
    const result = applyWorkflowTransition(
      definition,
      { kind: 'replace-definition', next },
      semanticContext,
    )
    publishTransition(result, meta)
  }

  function commitTransition(transition: WorkflowTransition, meta: InspectorChangeMeta) {
    const result = applyWorkflowTransition(definition, transition, semanticContext)
    publishTransition(result, meta)
  }

  function publishTransition(result: WorkflowTransitionResult, meta: InspectorChangeMeta) {
    const blocked =
      result.next === definition &&
      result.warnings.some(
        (warning) =>
          ('action' in warning && warning.action === 'abort') ||
          warning.code === 'connection-plan-context-stale' ||
          warning.code === 'connection-plan-graph-stale',
      )
    setTransitionNotice(
      blocked
        ? t('canvas.referenceChangeBlocked')
        : result.warnings.length > 0
          ? t('canvas.referencesPruned', { n: result.warnings.length })
          : null,
    )
    if (!blocked) onChange(result.next, meta)
  }

  function closeHistoryMerge(meta: InspectorChangeMeta) {
    onChange(definition, meta)
  }

  return (
    <div
      className={chrome === 'rail' ? 'inspector' : 'inspector-content'}
      data-inspector-content="node"
    >
      {chrome === 'rail' ? (
        <header className="inspector__header">
          <div>
            <div id={headingId} className="inspector__title" tabIndex={-1}>
              {displayTitle}
            </div>
            <div className="inspector__summary">
              {t('inspector.nodePortSummary', {
                inputs: ports.inputs.length,
                outputs: ports.outputs.length,
              })}
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
      ) : (
        <div id={headingId} className="sr-only" tabIndex={-1}>
          {displayTitle}
        </div>
      )}
      {chrome === 'content' && onConnect !== undefined && ports.outputs.length > 0 ? (
        <div className="inspector__primary-actions">
          <button
            type="button"
            className="btn btn--primary"
            data-testid="inspector-connect-next"
            onClick={(event) => onConnect(node.id, event.currentTarget)}
          >
            {t('editor.nodeActions.connectNext')}
          </button>
        </div>
      ) : null}
      <details className="inspector__technical inspector__technical--node">
        <summary>{t('agentForm.technicalDetailsSummary')}</summary>
        <dl>
          <dt>{t('inspector.technicalKind')}</dt>
          <dd>
            <code>{node.kind}</code>
          </dd>
          <dt>{t('inspector.technicalId')}</dt>
          <dd className="inspector__technical-id">
            <code>{node.id}</code>
            <button
              type="button"
              className="btn btn--xs btn--ghost"
              onClick={() => void navigator.clipboard?.writeText(node.id)}
            >
              {t('editor.nodeActions.copy')}
            </button>
          </dd>
        </dl>
      </details>
      {transitionNotice !== null && (
        <NoticeBanner tone="warning" size="compact">
          {transitionNotice}
        </NoticeBanner>
      )}
      <TabBar<Tab>
        variant="inspector"
        tabs={inspectorTabs}
        active={activeTab}
        onSelect={setTab}
        ariaLabelledBy={headingId}
        idPrefix={NODE_INSPECTOR_TAB_PREFIX}
      />
      <div className="inspector__body">
        {inspectorTabs.map(({ key }) => {
          const ids = tabDomIds(NODE_INSPECTOR_TAB_PREFIX, key)
          const active = key === activeTab
          return (
            <div
              key={key}
              role="tabpanel"
              id={ids.panelId}
              aria-labelledby={ids.tabId}
              hidden={!active}
            >
              {active && key === 'edit' && (
                <EditForm
                  node={node}
                  agents={agents}
                  definition={definition}
                  onPatch={patch}
                  onCommitDef={commitDefinition}
                  onTransition={commitTransition}
                  onHistoryBoundary={closeHistoryMerge}
                />
              )}
              {active && key === 'preview' && (
                <PreviewPane node={node} agents={agents} definition={definition} />
              )}
            </div>
          )
        })}
      </div>
    </div>
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
