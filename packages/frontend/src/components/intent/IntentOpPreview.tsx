// RFC-234 (T9) — per-op rich preview for the intent draft panel.
//
// One card body per changeset op, presented by resource type (user decision,
// clarify round 3: 呈现全四项):
//   workflow  → read-only canvas ('intent-preview' surface); update ops add a
//               Before/After switch (before = live definition) plus word-level
//               diffs for every inventoried workflow template surface.
//   workgroup → structure preview (member chips, leader mark, mode/switches).
//   skill     → file tree with byte sizes, script-suffix warning badges (D20:
//               text-only files; scripts highlighted, never executed) and
//               expandable contents.
//   agent     → field summary chips + rendered bodyMd diff (create diffs
//               against empty, update against the live body).
//   mcp/plugin→ masked payload JSON (server projects secret slots to ‹secret›).
// Every card also inlines its own validation errors (prefix-matched on opId)
// and keeps the raw JSON reachable behind <details> — the rich view is a lens,
// not a substitute for the exact payload.
//
// Unresolvable references degrade, never throw: a handle that is not in the
// session mounts, a tempRef missing from the bundle, or a definition the local
// schema rejects each fall back to a text note + raw JSON.

import { useQuery } from '@tanstack/react-query'
import { useMemo, useRef, useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  Agent,
  WorkflowDefinition,
  WorkflowDetail,
  WorkflowTemplateSurface,
} from '@agent-workflow/shared'
import {
  INTENT_RESOURCE_TYPES,
  collectWorkflowTemplateSurfaces,
  WorkflowDefinitionSchema,
  type IntentResourceType,
} from '@agent-workflow/shared'
import { api } from '@/api/client'
import { Dialog } from '@/components/Dialog'
import { FeedbackStack } from '@/components/FeedbackStack'
import { DiffView } from '@/components/review/DiffView'
import { NoticeBanner } from '@/components/NoticeBanner'
import { Segmented } from '@/components/Segmented'
import { StatusChip } from '@/components/StatusChip'
import { WorkflowCanvas } from '@/components/canvas/WorkflowCanvas'

/** Text files the agent may ship inside a skill that are executable-looking.
 *  They ride the envelope as plain text (D20) — the badge warns reviewers,
 *  nothing here executes. */
const SCRIPT_SUFFIXES = [
  '.sh',
  '.bash',
  '.zsh',
  '.py',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.rb',
  '.pl',
  '.ps1',
  '.bat',
  '.cmd',
]

export function isScriptPath(path: string): boolean {
  const lower = path.toLowerCase()
  return SCRIPT_SUFFIXES.some((suffix) => lower.endsWith(suffix))
}

export interface IntentOpPreviewProps {
  op: Record<string, unknown>
  mounts: ReadonlyArray<{ handle: string; resourceType: string; resourceId: string }>
  /** tempRef (`$new:slug`) → proposed name, collected from the bundle's create ops. */
  bundleNames: ReadonlyMap<string, string>
  /** Validation errors already filtered to this op by the caller. */
  opErrors: readonly string[]
}

/** `res#agent#1` → mounted resource id (undefined when not a root mount). */
function resolveHandleId(
  mounts: IntentOpPreviewProps['mounts'],
  resourceType: string,
  handle: unknown,
): string | undefined {
  if (typeof handle !== 'string') return undefined
  return mounts.find((m) => m.resourceType === resourceType && m.handle === handle)?.resourceId
}

function refDisplayName(
  ref: unknown,
  bundleNames: ReadonlyMap<string, string>,
  mounts: IntentOpPreviewProps['mounts'],
  agents: readonly Agent[] | undefined,
): string {
  if (typeof ref !== 'string') return ''
  if (ref.startsWith('$new:')) return bundleNames.get(ref) ?? ref.slice('$new:'.length)
  const id = resolveHandleId(mounts, 'agent', ref)
  const agent = agents?.find((a) => a.id === id)
  return agent?.name ?? ref
}

function utf8Size(text: string): number {
  return new TextEncoder().encode(text).length
}

function toIntentResourceType(value: string): IntentResourceType | null {
  return (INTENT_RESOURCE_TYPES as readonly string[]).includes(value)
    ? (value as IntentResourceType)
    : null
}

interface OpPreviewRenderInput {
  readonly props: IntentOpPreviewProps
  readonly payload: Record<string, unknown>
  readonly action: string
}

// RFC-348 D6 — one renderer per shared roster member (`null` = raw JSON only), so
// a new IntentResourceType fails to compile here until it decides its preview.
const OP_PREVIEW_RENDERERS = {
  workflow: ({ props, payload, action }) => (
    <WorkflowOpPreview
      op={props.op}
      payload={payload}
      action={action}
      mounts={props.mounts}
      bundleNames={props.bundleNames}
    />
  ),
  workgroup: ({ props, payload }) => (
    <WorkgroupOpPreview payload={payload} mounts={props.mounts} bundleNames={props.bundleNames} />
  ),
  skill: ({ payload }) => <SkillOpPreview payload={payload} />,
  agent: ({ props, payload, action }) => (
    <AgentOpPreview op={props.op} payload={payload} action={action} mounts={props.mounts} />
  ),
  mcp: () => null,
  plugin: () => null,
} satisfies Record<IntentResourceType, (input: OpPreviewRenderInput) => ReactElement | null>

export function IntentOpPreview(props: IntentOpPreviewProps): ReactElement {
  const { t } = useTranslation()
  const intentResourceType = toIntentResourceType(String(props.op.resourceType ?? ''))
  const action = String(props.op.action ?? '')
  const payload = (props.op.payload ?? {}) as Record<string, unknown>

  return (
    <div className="intent-op-preview">
      <FeedbackStack variant="section">
        {props.opErrors.length > 0 ? (
          <NoticeBanner tone="error">
            <ul>
              {props.opErrors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </NoticeBanner>
        ) : null}
      </FeedbackStack>
      {intentResourceType === null
        ? null
        : OP_PREVIEW_RENDERERS[intentResourceType]({ props, payload, action })}
      <details>
        <summary>{t('intent.previewRawJson')}</summary>
        <pre className="mono" style={{ maxHeight: 240, overflow: 'auto' }}>
          {JSON.stringify(payload, null, 2)}
        </pre>
      </details>
    </div>
  )
}

// ── workflow ────────────────────────────────────────────────────────────────

export interface WorkflowTemplateDiff {
  readonly key: string
  readonly label: string
  readonly before: string
  readonly after: string
}

function relativeTemplatePointer(surface: WorkflowTemplateSurface): string {
  return surface.pointer.replace(/^\/nodes\/\d+/, '')
}

function templateSurfaceKey(surface: WorkflowTemplateSurface): string {
  return `${surface.nodeId}\u0000${relativeTemplatePointer(surface)}`
}

/**
 * Compare the same authoritative template-surface inventory used by Intent
 * validation and runtime preflight. Node reordering therefore does not create
 * false diffs, while added and removed map entries remain visible.
 */
export function collectWorkflowTemplateDiffs(
  before: WorkflowDefinition,
  after: WorkflowDefinition,
): WorkflowTemplateDiff[] {
  const beforeSurfaces = new Map(
    collectWorkflowTemplateSurfaces(before).map((surface) => [
      templateSurfaceKey(surface),
      surface,
    ]),
  )
  const afterSurfaces = new Map(
    collectWorkflowTemplateSurfaces(after).map((surface) => [templateSurfaceKey(surface), surface]),
  )
  const keys = new Set([...beforeSurfaces.keys(), ...afterSurfaces.keys()])

  return [...keys].flatMap((key) => {
    const previous = beforeSurfaces.get(key)
    const next = afterSurfaces.get(key)
    const beforeText = previous?.text ?? ''
    const afterText = next?.text ?? ''
    if (beforeText === afterText) return []
    const surface = next ?? previous!
    return [
      {
        key,
        label: `${surface.nodeId}${relativeTemplatePointer(surface)}`,
        before: beforeText,
        after: afterText,
      },
    ]
  })
}

function WorkflowOpPreview(props: {
  op: Record<string, unknown>
  payload: Record<string, unknown>
  action: string
  mounts: IntentOpPreviewProps['mounts']
  bundleNames: ReadonlyMap<string, string>
}) {
  const { t } = useTranslation()
  const [side, setSide] = useState<'before' | 'after'>('after')
  const [canvasOpen, setCanvasOpen] = useState(false)
  const canvasTriggerRef = useRef<HTMLButtonElement | null>(null)
  const agentsQuery = useQuery<Agent[]>({
    queryKey: ['agents'],
    queryFn: () => api.get('/api/agents'),
  })
  const beforeId =
    props.action === 'update'
      ? resolveHandleId(props.mounts, 'workflow', props.op.target)
      : undefined
  const beforeQuery = useQuery<WorkflowDetail>({
    queryKey: ['workflows', beforeId ?? ''],
    queryFn: () => api.get(`/api/workflows/${encodeURIComponent(beforeId ?? '')}`),
    enabled: beforeId !== undefined,
  })

  // Map intent `agentRef` nodes to canvas shape: agentName carries the friendly
  // label; agentId stays unset (nothing to bind — this is a proposal).
  const after = useMemo(() => {
    const definition = props.payload.definition as { nodes?: unknown } | undefined
    // Degrade (not throw) on malformed model output — the raw JSON stays.
    if (definition === undefined || !Array.isArray(definition.nodes)) return null
    const mapped = {
      ...definition,
      nodes: definition.nodes.map((node) => {
        const row = node as Record<string, unknown>
        if (typeof row.agentRef !== 'string') return row
        const { agentRef: _agentRef, ...rest } = row
        return {
          ...rest,
          agentName: refDisplayName(
            row.agentRef,
            props.bundleNames,
            props.mounts,
            agentsQuery.data,
          ),
        }
      }),
    }
    const parsed = WorkflowDefinitionSchema.safeParse(mapped)
    return parsed.success ? parsed.data : null
  }, [props.payload.definition, props.bundleNames, props.mounts, agentsQuery.data])

  const before = beforeQuery.data?.definition as WorkflowDefinition | undefined
  const shown: WorkflowDefinition | null =
    side === 'before' && before !== undefined ? before : after

  const templateDiffs = useMemo(() => {
    if (before === undefined || after === null) return []
    return collectWorkflowTemplateDiffs(before, after)
  }, [before, after])

  return (
    <div className="intent-workflow-preview-shell">
      {props.action === 'update' && before !== undefined ? (
        <Segmented
          ariaLabel={t('intent.previewSideSwitch')}
          value={side}
          onChange={(next) => setSide(next as 'before' | 'after')}
          options={[
            { value: 'before', label: t('intent.previewBefore') },
            { value: 'after', label: t('intent.previewAfter') },
          ]}
        />
      ) : null}
      {shown !== null ? (
        <div className="intent-workflow-preview" data-testid="intent-preview-workflow">
          <header className="intent-workflow-preview__header">
            <div>
              <h4>{t('intent.previewWorkflowGraph')}</h4>
              <p className="intent-workflow-preview__metrics">
                <span>{t('intent.previewNodeCount', { count: shown.nodes.length })}</span>
                <span aria-hidden="true">·</span>
                <span>{t('intent.previewEdgeCount', { count: shown.edges.length })}</span>
              </p>
            </div>
            <button
              ref={canvasTriggerRef}
              type="button"
              className="btn btn--sm"
              aria-haspopup="dialog"
              onClick={() => setCanvasOpen(true)}
            >
              {t('intent.previewOpenCanvas')}
            </button>
          </header>
          <div
            className="canvas-frame intent-workflow-preview__canvas"
            data-testid="intent-preview-canvas"
          >
            <WorkflowCanvas
              surface="intent-preview"
              definition={shown}
              agents={agentsQuery.data ?? []}
              readOnly
            />
          </div>
          <p className="intent-workflow-preview__hint">{t('intent.previewCanvasHint')}</p>
          <Dialog
            open={canvasOpen}
            onClose={() => setCanvasOpen(false)}
            title={t('intent.previewCanvasDialogTitle')}
            size="lg"
            panelClassName="intent-workflow-preview-dialog"
            triggerRef={canvasTriggerRef}
            data-testid="intent-preview-canvas-dialog"
          >
            <p className="intent-workflow-preview__dialog-hint">{t('intent.previewCanvasHint')}</p>
            <div
              className="canvas-frame intent-workflow-preview__canvas intent-workflow-preview__canvas--expanded"
              data-testid="intent-preview-canvas-expanded"
            >
              <WorkflowCanvas
                surface="intent-preview"
                definition={shown}
                agents={agentsQuery.data ?? []}
                readOnly
              />
            </div>
          </Dialog>
        </div>
      ) : (
        <p className="muted">{t('intent.previewCanvasUnavailable')}</p>
      )}
      {templateDiffs.length > 0 ? (
        <div>
          <h4>{t('intent.previewPromptDiff')}</h4>
          {templateDiffs.map((diff) => (
            <DiffView
              key={diff.key}
              left={diff.before}
              right={diff.after}
              granularity="word"
              leftLabel={diff.label}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

// ── workgroup ───────────────────────────────────────────────────────────────

function WorkgroupOpPreview(props: {
  payload: Record<string, unknown>
  mounts: IntentOpPreviewProps['mounts']
  bundleNames: ReadonlyMap<string, string>
}) {
  const { t } = useTranslation()
  const agentsQuery = useQuery<Agent[]>({
    queryKey: ['agents'],
    queryFn: () => api.get('/api/agents'),
  })
  const members = Array.isArray(props.payload.members)
    ? (props.payload.members as Array<Record<string, unknown>>)
    : []
  const leader =
    typeof props.payload.leaderDisplayName === 'string'
      ? props.payload.leaderDisplayName
      : undefined
  return (
    <div data-testid="intent-preview-workgroup">
      <p>
        <StatusChip kind="neutral" size="sm">
          {String(props.payload.mode ?? '')}
        </StatusChip>
      </p>
      <h4>{t('intent.previewMembers', { count: members.length })}</h4>
      <ul>
        {members.map((member) => {
          const displayName = String(member.displayName ?? '')
          const human = member.memberType === 'human'
          return (
            <li key={displayName}>
              <strong>{displayName}</strong>
              {leader === displayName ? (
                <>
                  {' '}
                  <StatusChip kind="info" size="sm">
                    {t('intent.previewLeader')}
                  </StatusChip>
                </>
              ) : null}{' '}
              {human ? (
                <StatusChip kind="warn" size="sm">
                  {t('intent.previewHumanPlaceholder')}
                </StatusChip>
              ) : (
                <span className="muted">
                  {refDisplayName(
                    member.agentRef,
                    props.bundleNames,
                    props.mounts,
                    agentsQuery.data,
                  )}
                </span>
              )}
              {typeof member.roleDesc === 'string' && member.roleDesc !== '' ? (
                <span className="muted"> — {member.roleDesc}</span>
              ) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ── skill ───────────────────────────────────────────────────────────────────

function SkillOpPreview(props: { payload: Record<string, unknown> }) {
  const { t } = useTranslation()
  const files = Array.isArray(props.payload.files)
    ? (props.payload.files as Array<{ path?: unknown; content?: unknown }>)
    : []
  const bodyMd = typeof props.payload.bodyMd === 'string' ? props.payload.bodyMd : ''
  return (
    <div data-testid="intent-preview-skill">
      {bodyMd !== '' ? (
        <details open>
          <summary>{t('intent.previewBodyDiff')}</summary>
          <DiffView left="" right={bodyMd} granularity="block" />
        </details>
      ) : null}
      {files.length > 0 ? (
        <div>
          <h4>{t('intent.previewFiles', { count: files.length })}</h4>
          <ul className="mono">
            {files.map((file) => {
              const path = String(file.path ?? '')
              const content = typeof file.content === 'string' ? file.content : ''
              return (
                <li key={path}>
                  <details>
                    <summary>
                      {path} <span className="muted">({utf8Size(content)} B)</span>{' '}
                      {isScriptPath(path) ? (
                        <StatusChip kind="warn" size="sm" data-testid="intent-script-badge">
                          {t('intent.previewScriptBadge')}
                        </StatusChip>
                      ) : null}
                    </summary>
                    <pre className="mono" style={{ maxHeight: 240, overflow: 'auto' }}>
                      {content}
                    </pre>
                  </details>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

// ── agent ───────────────────────────────────────────────────────────────────

function AgentOpPreview(props: {
  op: Record<string, unknown>
  payload: Record<string, unknown>
  action: string
  mounts: IntentOpPreviewProps['mounts']
}) {
  const { t } = useTranslation()
  const beforeId =
    props.action === 'update' ? resolveHandleId(props.mounts, 'agent', props.op.target) : undefined
  const beforeQuery = useQuery<Agent>({
    queryKey: ['agents', beforeId ?? ''],
    queryFn: () => api.get(`/api/agents/${encodeURIComponent(beforeId ?? '')}`),
    enabled: beforeId !== undefined,
  })
  const after = typeof props.payload.bodyMd === 'string' ? props.payload.bodyMd : ''
  const before =
    props.action === 'update'
      ? ((beforeQuery.data as { bodyMd?: string } | undefined)?.bodyMd ?? undefined)
      : ''
  const chips: Array<[string, number]> = [
    ['outputs', Array.isArray(props.payload.outputs) ? props.payload.outputs.length : 0],
    ['skills', Array.isArray(props.payload.skills) ? props.payload.skills.length : 0],
    ['mcp', Array.isArray(props.payload.mcp) ? props.payload.mcp.length : 0],
    ['plugins', Array.isArray(props.payload.plugins) ? props.payload.plugins.length : 0],
  ]
  return (
    <div data-testid="intent-preview-agent">
      <p>
        {chips
          .filter(([, count]) => count > 0)
          .map(([key, count]) => (
            <span key={key}>
              <StatusChip kind="neutral" size="sm">
                {key}: {count}
              </StatusChip>{' '}
            </span>
          ))}
        {typeof props.payload.runtime === 'string' ? (
          <StatusChip kind="neutral" size="sm">
            {props.payload.runtime}
          </StatusChip>
        ) : null}
      </p>
      {props.action === 'update' && before === undefined ? (
        <p className="muted">{t('intent.previewBeforeUnavailable')}</p>
      ) : null}
      {after !== '' || (before ?? '') !== '' ? (
        <details open={props.action === 'update'}>
          <summary>{t('intent.previewBodyDiff')}</summary>
          <DiffView left={before ?? ''} right={after} granularity="word" />
        </details>
      ) : null}
    </div>
  )
}
