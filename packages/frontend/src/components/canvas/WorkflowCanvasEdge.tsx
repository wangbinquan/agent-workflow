import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from '@xyflow/react'
import { useTranslation } from 'react-i18next'

export interface WorkflowCanvasEdgeData extends Record<string, unknown> {
  onInsertNode?: (edgeId: string, trigger: HTMLElement) => void
  validation?: { errors: number; warnings: number }
}

type InsertableEdge = Edge<WorkflowCanvasEdgeData, 'workflow-insertable'>

export function WorkflowCanvasEdge(props: EdgeProps<InsertableEdge>) {
  const { t } = useTranslation()
  const [path, labelX, labelY] = getBezierPath({
    sourceX: props.sourceX,
    sourceY: props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX: props.targetX,
    targetY: props.targetY,
    targetPosition: props.targetPosition,
  })
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerStart={props.markerStart}
        markerEnd={props.markerEnd}
        style={props.style}
        interactionWidth={props.interactionWidth}
      />
      <EdgeLabelRenderer>
        {props.data?.onInsertNode !== undefined ? (
          <button
            type="button"
            className="workflow-edge-insert nodrag nopan"
            data-selected={props.selected === true ? 'true' : undefined}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            aria-label={t('editor.nodeActions.insertOnEdge')}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              props.data?.onInsertNode?.(props.id, event.currentTarget)
            }}
          >
            +
          </button>
        ) : null}
        {props.data?.validation !== undefined ? (
          <span
            className="workflow-edge-validation nodrag nopan"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY + 18}px)`,
            }}
            aria-label={[
              ...(props.data.validation.errors > 0
                ? [
                    t('editor.validationBadgeErrors', {
                      n: props.data.validation.errors,
                    }),
                  ]
                : []),
              ...(props.data.validation.warnings > 0
                ? [
                    t('editor.validationBadgeWarnings', {
                      n: props.data.validation.warnings,
                    }),
                  ]
                : []),
            ].join(', ')}
          >
            {props.data.validation.errors > 0 ? `! ${props.data.validation.errors}` : ''}
            {props.data.validation.errors > 0 && props.data.validation.warnings > 0 ? ' · ' : ''}
            {props.data.validation.warnings > 0 ? `⚠ ${props.data.validation.warnings}` : ''}
          </span>
        ) : null}
      </EdgeLabelRenderer>
    </>
  )
}
