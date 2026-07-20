import {
  REVIEW_INPUT_PORT_NAME,
  declaredPorts,
  type Agent,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@agent-workflow/shared'
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog } from '../Dialog'
import { Field, TextInput } from '../Form'
import { useManagedLiveRegion } from '../ManagedLiveRegion'
import { Select, type SelectOption } from '../Select'
import { existingInputPorts, nextFreeInputPort } from '../canvas/dropTarget'
import {
  createWorkflowSemanticContext,
  planWorkflowConnection,
  workflowConnectionDefinitionRevision,
  type ConnectionPlan,
  type ConnectionRequest,
} from '../../lib/workflow-connection-plan'

type SuccessfulConnectionPlan = Extract<ConnectionPlan, { ok: true }>

export interface ConnectionDialogProps {
  open: boolean
  definition: WorkflowDefinition
  agents: readonly Agent[]
  sourceNodeId: string
  sourcePortName?: string
  /** Existing generic edge replaced atomically by this connection plan. */
  replaceEdgeId?: string
  initialTargetNodeId?: string
  initialTargetPortName?: string
  onApply: (plan: SuccessfulConnectionPlan, targetNodeId: string) => boolean
  onClose: () => void
  triggerRef?: RefObject<HTMLElement | null>
  restoreFocusFallbackRef?: RefObject<HTMLElement | null>
}

type TargetMode = 'new' | 'reuse'
type FanoutRole = 'shard' | 'broadcast'

interface FanoutBoundarySelection {
  direction: 'input' | 'output'
  wrapperNodeId: string
}

function nodeLabel(node: WorkflowNode): string {
  const raw = node as unknown as Record<string, unknown>
  const candidate = raw.label ?? raw.name ?? raw.agentName
  return typeof candidate === 'string' && candidate.trim() !== ''
    ? `${candidate} (${node.id})`
    : `${node.id} · ${node.kind}`
}

function portNames(
  definition: WorkflowDefinition,
  node: WorkflowNode | undefined,
  agentsByName: ReturnType<typeof createWorkflowSemanticContext>['agentsByName'],
): string[] {
  if (node === undefined) return []
  const declared = declaredPorts(node, definition, agentsByName)
  const names = [...declared.dataOutputs, ...declared.systemOutputs].map((port) => port.name)
  for (const edge of definition.edges) {
    if (edge.source.nodeId === node.id && !names.includes(edge.source.portName)) {
      names.push(edge.source.portName)
    }
  }
  return names
}

function directWrapperParent(
  definition: WorkflowDefinition,
  nodeId: string,
): WorkflowNode | undefined {
  return definition.nodes.find((node) => {
    if (
      node.kind !== 'wrapper-git' &&
      node.kind !== 'wrapper-loop' &&
      node.kind !== 'wrapper-fanout'
    ) {
      return false
    }
    const nodeIds = (node as Record<string, unknown>).nodeIds
    return Array.isArray(nodeIds) && nodeIds.includes(nodeId)
  })
}

function fanoutBoundarySelection(
  definition: WorkflowDefinition,
  sourceNode: WorkflowNode | undefined,
  targetNode: WorkflowNode | undefined,
): FanoutBoundarySelection | null {
  if (sourceNode === undefined || targetNode === undefined) return null
  const sourceParent = directWrapperParent(definition, sourceNode.id)
  const targetParent = directWrapperParent(definition, targetNode.id)
  if (targetParent?.kind === 'wrapper-fanout' && sourceParent?.id !== targetParent.id) {
    return { direction: 'input', wrapperNodeId: targetParent.id }
  }
  if (sourceParent?.kind === 'wrapper-fanout' && targetParent?.id !== sourceParent.id) {
    return { direction: 'output', wrapperNodeId: sourceParent.id }
  }
  return null
}

function requestForSelection(fields: {
  definition: WorkflowDefinition
  sourceNode: WorkflowNode | undefined
  sourcePortName: string
  targetNode: WorkflowNode | undefined
  targetPortName: string
  mode: TargetMode
  fanoutKind: string
  fanoutRole: FanoutRole
  edgeId?: string
}): ConnectionRequest | null {
  const { sourceNode, targetNode } = fields
  if (sourceNode === undefined || targetNode === undefined) return null

  const boundary = fanoutBoundarySelection(fields.definition, sourceNode, targetNode)
  if (boundary?.direction === 'input') {
    return {
      kind: 'fanout-boundary-input',
      wrapperNodeId: boundary.wrapperNodeId,
      outerEndpoint: { nodeId: sourceNode.id, portName: fields.sourcePortName },
      innerEndpoint: { nodeId: targetNode.id, portName: fields.targetPortName },
      port: {
        portName: fields.targetPortName,
        kind: fields.fanoutKind,
        role: fields.fanoutRole,
      },
    }
  }
  if (boundary?.direction === 'output') {
    return {
      kind: 'fanout-boundary-output',
      wrapperNodeId: boundary.wrapperNodeId,
      innerEndpoint: { nodeId: sourceNode.id, portName: fields.sourcePortName },
      outerEndpoint: { nodeId: targetNode.id, portName: fields.targetPortName },
      port: { portName: fields.sourcePortName, kind: fields.fanoutKind },
    }
  }

  if (
    (sourceNode.kind === 'agent-single' && targetNode.kind === 'clarify') ||
    (sourceNode.kind === 'clarify' && targetNode.kind === 'agent-single')
  ) {
    return {
      kind: 'clarify-questioner',
      questionerNodeId: sourceNode.kind === 'agent-single' ? sourceNode.id : targetNode.id,
      clarifyNodeId: sourceNode.kind === 'clarify' ? sourceNode.id : targetNode.id,
    }
  }

  if (
    (sourceNode.kind === 'agent-single' && targetNode.kind === 'clarify-cross-agent') ||
    (sourceNode.kind === 'clarify-cross-agent' && targetNode.kind === 'agent-single')
  ) {
    if (sourceNode.kind === 'clarify-cross-agent' && fields.sourcePortName === 'to_designer') {
      return {
        kind: 'cross-designer',
        crossClarifyNodeId: sourceNode.id,
        designerNodeId: targetNode.id,
      }
    }
    return {
      kind: 'cross-questioner',
      questionerNodeId: sourceNode.kind === 'agent-single' ? sourceNode.id : targetNode.id,
      crossClarifyNodeId: sourceNode.kind === 'clarify-cross-agent' ? sourceNode.id : targetNode.id,
    }
  }

  return {
    kind: 'generic',
    source: { nodeId: sourceNode.id, portName: fields.sourcePortName },
    targetNodeId: targetNode.id,
    target: { mode: fields.mode, portName: fields.targetPortName },
    ...(fields.edgeId !== undefined ? { edgeId: fields.edgeId } : {}),
  }
}

function compatibilityTone(plan: ConnectionPlan | null): string {
  if (plan === null || !plan.ok) return 'danger'
  return plan.compatibility === 'compatible'
    ? 'success'
    : plan.compatibility === 'unknown'
      ? 'attention'
      : 'danger'
}

export function ConnectionDialog(props: ConnectionDialogProps) {
  const { t } = useTranslation()
  const managedLiveRegion = useManagedLiveRegion()
  const context = useMemo(() => createWorkflowSemanticContext(props.agents), [props.agents])
  const planningDefinition = useMemo(
    () =>
      props.replaceEdgeId === undefined
        ? props.definition
        : {
            ...props.definition,
            edges: props.definition.edges.filter((edge) => edge.id !== props.replaceEdgeId),
          },
    [props.definition, props.replaceEdgeId],
  )
  const sourceNode = useMemo(
    () => planningDefinition.nodes.find((node) => node.id === props.sourceNodeId),
    [planningDefinition.nodes, props.sourceNodeId],
  )
  const sourcePorts = useMemo(
    () => portNames(planningDefinition, sourceNode, context.agentsByName),
    [context.agentsByName, planningDefinition, sourceNode],
  )
  const targetNodes = useMemo(
    () => planningDefinition.nodes.filter((node) => node.id !== props.sourceNodeId),
    [planningDefinition.nodes, props.sourceNodeId],
  )

  const [sourcePortName, setSourcePortName] = useState(props.sourcePortName ?? sourcePorts[0] ?? '')
  const [targetNodeId, setTargetNodeId] = useState(
    props.initialTargetNodeId ?? targetNodes[0]?.id ?? '',
  )
  const [mode, setMode] = useState<TargetMode>('new')
  const [targetPortName, setTargetPortName] = useState(
    props.initialTargetPortName ?? sourcePorts[0] ?? 'input',
  )
  const [fanoutKind, setFanoutKind] = useState('string')
  const [fanoutRole, setFanoutRole] = useState<FanoutRole>('shard')
  const sourceSelectRef = useRef<HTMLButtonElement | null>(null)

  const targetNode = useMemo(
    () => targetNodes.find((node) => node.id === targetNodeId),
    [targetNodeId, targetNodes],
  )
  const reusablePorts = useMemo(
    () => (targetNode === undefined ? [] : existingInputPorts(planningDefinition, targetNode)),
    [planningDefinition, targetNode],
  )
  const boundary = useMemo(
    () => fanoutBoundarySelection(planningDefinition, sourceNode, targetNode),
    [planningDefinition, sourceNode, targetNode],
  )

  useEffect(() => {
    if (!props.open) return
    if (props.initialTargetNodeId !== undefined) setTargetNodeId(props.initialTargetNodeId)
    if (props.initialTargetPortName !== undefined) {
      setMode('new')
      setTargetPortName(props.initialTargetPortName)
    }
  }, [props.initialTargetNodeId, props.initialTargetPortName, props.open])

  useEffect(() => {
    if (sourcePorts.length === 0) {
      setSourcePortName('')
      return
    }
    if (props.sourcePortName !== undefined && sourcePorts.includes(props.sourcePortName)) {
      setSourcePortName(props.sourcePortName)
      return
    }
    setSourcePortName((current) => (sourcePorts.includes(current) ? current : sourcePorts[0]!))
  }, [props.sourcePortName, sourcePorts])

  useEffect(() => {
    if (sourceNode === undefined) return
    const declared = declaredPorts(sourceNode, planningDefinition, context.agentsByName)
    const kind = declared.dataOutputs.find((port) => port.name === sourcePortName)?.kind
    setFanoutKind(kind ?? 'string')
  }, [context.agentsByName, planningDefinition, sourceNode, sourcePortName])

  useEffect(() => {
    if (targetNodes.length === 0) {
      setTargetNodeId('')
      return
    }
    setTargetNodeId((current) =>
      targetNodes.some((node) => node.id === current) ? current : targetNodes[0]!.id,
    )
  }, [targetNodes])

  useEffect(() => {
    if (targetNode?.kind === 'review') {
      setMode('reuse')
      setTargetPortName(REVIEW_INPUT_PORT_NAME)
      return
    }
    if (mode === 'reuse') {
      setTargetPortName((current) =>
        reusablePorts.includes(current) ? current : (reusablePorts[0] ?? ''),
      )
      return
    }
    const desired = sourcePortName === '' ? 'input' : sourcePortName
    setTargetPortName((current) =>
      current !== '' && !reusablePorts.includes(current)
        ? current
        : nextFreeInputPort(reusablePorts, desired),
    )
  }, [mode, reusablePorts, sourcePortName, targetNode?.kind])

  const request = useMemo(
    () =>
      requestForSelection({
        definition: planningDefinition,
        sourceNode,
        sourcePortName,
        targetNode,
        targetPortName,
        mode,
        fanoutKind,
        fanoutRole,
        edgeId: props.replaceEdgeId,
      }),
    [
      fanoutKind,
      fanoutRole,
      mode,
      planningDefinition,
      props.replaceEdgeId,
      sourceNode,
      sourcePortName,
      targetNode,
      targetPortName,
    ],
  )
  const plan = useMemo(() => {
    if (request === null) return null
    const candidate = planWorkflowConnection(planningDefinition, request, context)
    if (candidate.ok !== true || props.replaceEdgeId === undefined) return candidate
    return {
      ...candidate,
      definitionRevision: workflowConnectionDefinitionRevision(props.definition),
      removeEdgeIds: [...new Set([...candidate.removeEdgeIds, props.replaceEdgeId])],
      preview: {
        ...candidate.preview,
        replacedEdgeIds: [...new Set([...candidate.preview.replacedEdgeIds, props.replaceEdgeId])],
      },
    }
  }, [context, planningDefinition, props.definition, props.replaceEdgeId, request])

  const sourceOptions: SelectOption<string>[] = sourcePorts.map((portName) => ({
    value: portName,
    label: portName,
  }))
  const targetOptions: SelectOption<string>[] = targetNodes.map((node) => ({
    value: node.id,
    label: nodeLabel(node),
  }))
  const reuseOptions: SelectOption<string>[] = reusablePorts.map((portName) => ({
    value: portName,
    label: portName,
  }))
  const isDomainChannel =
    targetNode?.kind === 'clarify' ||
    targetNode?.kind === 'clarify-cross-agent' ||
    sourceNode?.kind === 'clarify' ||
    sourceNode?.kind === 'clarify-cross-agent'
  const canSubmit = plan?.ok === true && plan.compatibility === 'compatible'

  const compatibilityLabel =
    plan === null
      ? t('editor.connectionDialog.incomplete')
      : !plan.ok
        ? plan.reason.message
        : t(`editor.connectionDialog.compatibility.${plan.compatibility}`)
  const previewTargetPort = isDomainChannel
    ? t('editor.connectionDialog.domainChannel')
    : targetPortName

  useEffect(() => {
    if (props.open && managedLiveRegion !== null) {
      managedLiveRegion.announce(compatibilityLabel)
    }
  }, [compatibilityLabel, managedLiveRegion, props.open])

  return (
    <Dialog
      open={props.open}
      onClose={props.onClose}
      title={t('editor.connectionDialog.title')}
      size="md"
      initialFocusRef={sourceSelectRef}
      triggerRef={props.triggerRef}
      restoreFocusFallbackRef={props.restoreFocusFallbackRef}
      panelClassName="connection-dialog"
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={props.onClose}>
            {t('common.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            data-testid="connection-submit"
            disabled={!canSubmit}
            onClick={() => {
              if (plan?.ok !== true || plan.compatibility !== 'compatible') return
              if (props.onApply(plan, targetNodeId)) props.onClose()
            }}
          >
            {t('editor.connectionDialog.apply')}
          </button>
        </>
      }
    >
      <div className="connection-dialog__form">
        <Field label={t('editor.connectionDialog.sourcePort')}>
          <Select
            value={sourcePortName}
            options={sourceOptions}
            onChange={setSourcePortName}
            triggerRef={sourceSelectRef}
            data-testid="connection-source-port"
            ariaLabel={t('editor.connectionDialog.sourcePort')}
          />
        </Field>

        <Field label={t('editor.connectionDialog.targetNode')}>
          <Select
            value={targetNodeId}
            options={targetOptions}
            onChange={(value) => {
              setTargetNodeId(value)
              const next = targetNodes.find((node) => node.id === value)
              setMode(next?.kind === 'review' ? 'reuse' : 'new')
            }}
            searchable
            data-testid="connection-target-node"
            ariaLabel={t('editor.connectionDialog.targetNode')}
          />
        </Field>

        {boundary !== null && (
          <div className="connection-dialog__boundary" data-testid="connection-fanout-boundary">
            <strong>
              {boundary.direction === 'input'
                ? t('editor.connectionDialog.fanoutInput')
                : t('editor.connectionDialog.fanoutOutput')}
            </strong>
            <span>
              {t('editor.connectionDialog.fanoutEndpoint', {
                wrapper: boundary.wrapperNodeId,
                inner:
                  boundary.direction === 'input' ? (targetNode?.id ?? '…') : props.sourceNodeId,
                outer:
                  boundary.direction === 'input' ? props.sourceNodeId : (targetNode?.id ?? '…'),
              })}
            </span>
          </div>
        )}

        {!isDomainChannel && (
          <Field label={t('editor.connectionDialog.inputMode')} group>
            <div className="connection-dialog__mode" role="group">
              <button
                type="button"
                className={mode === 'new' ? 'is-active' : undefined}
                data-testid="connection-mode-new"
                disabled={targetNode?.kind === 'review'}
                aria-pressed={mode === 'new'}
                onClick={() => {
                  setMode('new')
                  setTargetPortName(
                    nextFreeInputPort(
                      reusablePorts,
                      sourcePortName === '' ? 'input' : sourcePortName,
                    ),
                  )
                }}
              >
                {t('editor.connectionDialog.newInput')}
              </button>
              <button
                type="button"
                className={mode === 'reuse' ? 'is-active' : undefined}
                data-testid="connection-mode-reuse"
                disabled={targetNode?.kind !== 'review' && reuseOptions.length === 0}
                aria-pressed={mode === 'reuse'}
                onClick={() => {
                  setMode('reuse')
                  setTargetPortName(
                    targetNode?.kind === 'review'
                      ? REVIEW_INPUT_PORT_NAME
                      : (reuseOptions[0]?.value ?? ''),
                  )
                }}
              >
                {t('editor.connectionDialog.reuseInput')}
              </button>
            </div>
          </Field>
        )}

        <Field label={t('editor.connectionDialog.targetPort')}>
          <div data-testid="connection-target-port">
            {targetNode?.kind === 'review' ? (
              <code>{REVIEW_INPUT_PORT_NAME}</code>
            ) : isDomainChannel ? (
              <span className="muted">{t('editor.connectionDialog.domainChannel')}</span>
            ) : mode === 'reuse' ? (
              <Select
                value={targetPortName}
                options={reuseOptions}
                onChange={setTargetPortName}
                disabled={reuseOptions.length === 0}
                ariaLabel={t('editor.connectionDialog.targetPort')}
              />
            ) : (
              <TextInput value={targetPortName} onChange={setTargetPortName} />
            )}
          </div>
        </Field>

        {boundary !== null && (
          <Field label={t('editor.connectionDialog.fanoutKind')}>
            <TextInput
              value={fanoutKind}
              onChange={setFanoutKind}
              data-testid="connection-fanout-kind"
            />
          </Field>
        )}

        {boundary?.direction === 'input' && (
          <Field label={t('editor.connectionDialog.fanoutRole')} group>
            <div className="connection-dialog__mode" role="group">
              <button
                type="button"
                className={fanoutRole === 'shard' ? 'is-active' : undefined}
                aria-pressed={fanoutRole === 'shard'}
                data-testid="connection-fanout-role-shard"
                onClick={() => setFanoutRole('shard')}
              >
                {t('editor.connectionDialog.fanoutShard')}
              </button>
              <button
                type="button"
                className={fanoutRole === 'broadcast' ? 'is-active' : undefined}
                aria-pressed={fanoutRole === 'broadcast'}
                data-testid="connection-fanout-role-broadcast"
                onClick={() => setFanoutRole('broadcast')}
              >
                {t('editor.connectionDialog.fanoutBroadcast')}
              </button>
            </div>
          </Field>
        )}

        <div className="connection-dialog__preview" data-testid="connection-preview">
          <span>{t('editor.connectionDialog.preview')}</span>
          <code>
            {props.sourceNodeId}.{sourcePortName || '…'} → {targetNodeId || '…'}.
            {previewTargetPort || '…'}
          </code>
        </div>

        <div
          className="connection-dialog__compatibility"
          data-tone={compatibilityTone(plan)}
          data-testid="connection-compatibility"
          role={managedLiveRegion === null ? 'status' : undefined}
          aria-live={managedLiveRegion === null ? 'polite' : undefined}
        >
          {compatibilityLabel}
        </div>

        {plan?.ok === true && plan.preview.replacedEdgeIds.length > 0 && (
          <div className="connection-dialog__replacement" data-testid="connection-replacement">
            {t('editor.connectionDialog.replaces', {
              edges: plan.preview.replacedEdgeIds.join(', '),
            })}
          </div>
        )}
        {plan?.ok === true && plan.preview.fanoutShardDemotions.length > 0 && (
          <div className="connection-dialog__replacement" data-testid="connection-fanout-demotions">
            {t('editor.connectionDialog.fanoutDemotes', {
              ports: plan.preview.fanoutShardDemotions.join(', '),
            })}
          </div>
        )}
        {plan?.ok === true && plan.warnings.length > 0 && (
          <ul className="connection-dialog__warnings">
            {plan.warnings.map((warning) => (
              <li key={warning.code}>{warning.message}</li>
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  )
}
