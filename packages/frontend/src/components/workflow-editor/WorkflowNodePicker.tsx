import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react'
import { useTranslation } from 'react-i18next'
import type { Agent } from '@agent-workflow/shared'
import { Dialog } from '@/components/Dialog'
import { TextInput } from '@/components/Form'
import { useManagedLiveRegion } from '@/components/ManagedLiveRegion'
import {
  PALETTE_MIME,
  buildPalette,
  serialize,
  type PaletteItem,
} from '@/components/canvas/nodePalette'

export const NODE_PICKER_RECENT_STORAGE_KEY = 'agent-workflow.workflow-node-picker.recent.v1'

export type WorkflowNodePickerScope =
  | { kind: 'top-level' }
  | { kind: 'wrapper'; wrapperNodeId: string }

export type WorkflowNodePickerIntent =
  | {
      kind: 'free'
      viewportPoint: { x: number; y: number }
      scope: WorkflowNodePickerScope
    }
  | { kind: 'after-node'; nodeId: string; scope: WorkflowNodePickerScope }
  | { kind: 'inside-wrapper'; wrapperNodeId: string }
  | { kind: 'insert-edge'; edgeId: string }

interface PickerEntry {
  identity: string
  item: PaletteItem
  label: string
  description: string
}

export interface WorkflowNodePickerCatalogProps {
  agents: Agent[]
  onPick: (item: PaletteItem) => void
  onCancel?: () => void
  disabledReason?: (item: PaletteItem) => string | null
  showDragGrip?: boolean
  className?: string
  initialFocusRef?: RefObject<HTMLInputElement | null>
}

export interface WorkflowNodePickerProps extends Omit<
  WorkflowNodePickerCatalogProps,
  'onCancel' | 'initialFocusRef'
> {
  open: boolean
  intent: WorkflowNodePickerIntent
  onClose: () => void
  triggerRef?: RefObject<HTMLElement | null>
  restoreFocusFallbackRef?: RefObject<HTMLElement | null>
}

export function workflowNodePickerIdentity(item: PaletteItem): string {
  return item.kind === 'agent-single' ? `agent:${item.agentName}` : `kind:${item.kind}`
}

function readRecentIdentities(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const parsed = JSON.parse(window.localStorage.getItem(NODE_PICKER_RECENT_STORAGE_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((value): value is string => typeof value === 'string').slice(0, 6)
  } catch {
    return []
  }
}

function writeRecentIdentity(identity: string, previous: readonly string[]): string[] {
  const next = [identity, ...previous.filter((value) => value !== identity)].slice(0, 6)
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(NODE_PICKER_RECENT_STORAGE_KEY, JSON.stringify(next))
    } catch {
      // Storage can be unavailable in hardened/private browser contexts. The
      // picker remains fully usable; only the convenience group is omitted.
    }
  }
  return next
}

function buildEntries(agents: Agent[], t: (key: string) => string): PickerEntry[] {
  return buildPalette(agents, t).flatMap((section) =>
    section.items.map((entry) => ({
      identity: workflowNodePickerIdentity(entry.item),
      item: entry.item,
      label: entry.label,
      description: entry.description,
    })),
  )
}

function recommendedEntries(entries: readonly PickerEntry[]): PickerEntry[] {
  const agents = entries.filter((entry) => entry.item.kind === 'agent-single').slice(0, 3)
  const commonKinds = new Set(['input', 'output', 'review'])
  const common = entries.filter((entry) => commonKinds.has(entry.item.kind))
  const chosen = [...agents, ...common]
  if (chosen.length > 0) return chosen.slice(0, 6)
  return entries.slice(0, 6)
}

export function WorkflowNodePickerCatalog({
  agents,
  onPick,
  onCancel,
  disabledReason,
  showDragGrip = false,
  className,
  initialFocusRef,
}: WorkflowNodePickerCatalogProps) {
  const { t } = useTranslation()
  const managedLiveRegion = useManagedLiveRegion()
  const ownSearchRef = useRef<HTMLInputElement | null>(null)
  const searchRef = initialFocusRef ?? ownSearchRef
  const [query, setQuery] = useState('')
  const [recent, setRecent] = useState<string[]>(readRecentIdentities)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const entries = useMemo(() => buildEntries(agents, t), [agents, t])
  const byIdentity = useMemo(
    () => new Map(entries.map((entry) => [entry.identity, entry] as const)),
    [entries],
  )
  const recentEntries = recent.flatMap((identity) => {
    const entry = byIdentity.get(identity)
    return entry === undefined ? [] : [entry]
  })
  const trimmedQuery = query.trim().toLowerCase()
  const filtered =
    trimmedQuery === ''
      ? entries
      : entries.filter((entry) => {
          const haystack = [
            entry.label,
            entry.description,
            entry.item.kind,
            entry.item.kind === 'agent-single' ? entry.item.agentName : '',
          ]
            .join('\n')
            .toLowerCase()
          return haystack.includes(trimmedQuery)
        })
  const groups =
    trimmedQuery === ''
      ? [
          {
            key: 'recommended',
            label: t('editor.nodePicker.recommended'),
            entries: recommendedEntries(entries),
          },
          ...(recentEntries.length > 0
            ? [{ key: 'recent', label: t('editor.nodePicker.recent'), entries: recentEntries }]
            : []),
          { key: 'all', label: t('editor.nodePicker.all'), entries },
        ]
      : [{ key: 'all', label: t('editor.nodePicker.all'), entries: filtered }]
  const flattened = groups.flatMap((group) =>
    group.entries.map((entry) => ({ groupKey: group.key, entry })),
  )
  itemRefs.current.length = flattened.length

  useEffect(() => {
    setQuery('')
  }, [agents])

  useEffect(() => {
    if (managedLiveRegion === null) return
    managedLiveRegion.announce(
      filtered.length === 0
        ? t('editor.nodePicker.noMatches')
        : t('editor.nodePicker.resultsCount', { n: filtered.length }),
    )
  }, [filtered.length, managedLiveRegion, t])

  const focusIndex = (index: number) => {
    if (flattened.length === 0) return
    const wrapped = (index + flattened.length) % flattened.length
    itemRefs.current[wrapped]?.focus()
  }

  const choose = (entry: PickerEntry) => {
    if (disabledReason?.(entry.item) !== null && disabledReason?.(entry.item) !== undefined) return
    setRecent((previous) => writeRecentIdentity(entry.identity, previous))
    onPick(entry.item)
  }

  const onItemKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
    entry: PickerEntry,
  ) => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      focusIndex(index + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      focusIndex(index - 1)
    } else if (event.key === 'Home') {
      event.preventDefault()
      focusIndex(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focusIndex(flattened.length - 1)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      choose(entry)
    } else if (event.key === 'Escape' && onCancel !== undefined) {
      event.preventDefault()
      event.stopPropagation()
      onCancel()
    }
  }

  const onDragStart = (event: DragEvent<HTMLElement>, item: PaletteItem) => {
    const serialized = serialize(item)
    event.dataTransfer.setData(PALETTE_MIME, serialized)
    event.dataTransfer.setData('text/plain', serialized)
    event.dataTransfer.effectAllowed = 'copy'
  }

  let flatIndex = 0
  return (
    <div
      className={
        className === undefined ? 'workflow-node-picker' : `workflow-node-picker ${className}`
      }
    >
      <TextInput
        type="search"
        value={query}
        onChange={setQuery}
        inputRef={searchRef}
        aria-label={t('editor.nodePicker.searchLabel')}
        placeholder={t('editor.nodePicker.searchPlaceholder')}
        data-testid="workflow-node-picker-search"
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            focusIndex(0)
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            focusIndex(flattened.length - 1)
          } else if (event.key === 'Escape' && onCancel !== undefined) {
            event.preventDefault()
            event.stopPropagation()
            onCancel()
          }
        }}
      />
      <div
        className="workflow-node-picker__groups"
        aria-live={managedLiveRegion === null ? 'polite' : undefined}
      >
        {groups.map((group) => (
          <section key={group.key} className="workflow-node-picker__group">
            <h3 className="workflow-node-picker__group-title">{group.label}</h3>
            <ul className="workflow-node-picker__list">
              {group.entries.map((entry) => {
                const index = flatIndex++
                const reason = disabledReason?.(entry.item) ?? null
                return (
                  <li key={`${group.key}:${entry.identity}`} className="workflow-node-picker__row">
                    <button
                      ref={(node) => {
                        itemRefs.current[index] = node
                      }}
                      type="button"
                      className="workflow-node-picker__item editor-sidebar__item"
                      aria-disabled={reason === null ? undefined : true}
                      data-testid={`workflow-node-picker-item-${entry.item.kind === 'agent-single' ? `agent-${entry.item.agentName}` : `kind-${entry.item.kind}`}`}
                      onClick={() => choose(entry)}
                      onKeyDown={(event) => onItemKeyDown(event, index, entry)}
                    >
                      <span className="workflow-node-picker__item-copy">
                        <span className="editor-sidebar__item-label">{entry.label}</span>
                        <span className="editor-sidebar__item-hint">{entry.description}</span>
                        {reason !== null ? (
                          <span className="workflow-node-picker__disabled-reason">{reason}</span>
                        ) : null}
                      </span>
                      {showDragGrip ? (
                        <span
                          className="workflow-node-picker__drag-grip"
                          draggable
                          onDragStart={(event) => onDragStart(event, entry.item)}
                          title={t('editor.nodePicker.dragHint')}
                          aria-hidden="true"
                        >
                          ⠿
                        </span>
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
        {flattened.length === 0 ? (
          <div className="muted workflow-node-picker__empty">
            {t('editor.nodePicker.noMatches')}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function WorkflowNodePicker({
  open,
  agents,
  intent: _intent,
  onPick,
  onClose,
  disabledReason,
  showDragGrip,
  className,
  triggerRef,
  restoreFocusFallbackRef,
}: WorkflowNodePickerProps) {
  const { t } = useTranslation()
  const searchRef = useRef<HTMLInputElement | null>(null)
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('editor.nodePicker.title')}
      initialFocusRef={searchRef}
      triggerRef={triggerRef}
      restoreFocusFallbackRef={restoreFocusFallbackRef}
      data-testid="workflow-node-picker-dialog"
      panelClassName="workflow-node-picker-dialog"
      footer={
        <button type="button" className="btn" onClick={onClose}>
          {t('common.cancel')}
        </button>
      }
    >
      <WorkflowNodePickerCatalog
        agents={agents}
        onPick={onPick}
        onCancel={onClose}
        disabledReason={disabledReason}
        showDragGrip={showDragGrip}
        className={className}
        initialFocusRef={searchRef}
      />
    </Dialog>
  )
}
