import {
  useEffect,
  useId,
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
import { TabBar, type TabDef } from '@/components/TabBar'
import { TabPanels } from '@/components/split/TabPanels'
import { useUserLookup } from '@/hooks/useUserLookup'
import {
  PALETTE_MIME,
  buildPalette,
  serialize,
  type PaletteItem,
  type PaletteSectionKey,
} from '@/components/canvas/nodePalette'
import {
  deriveNodePickerCatalog,
  type NodePickerCategory,
  type NodePickerEntry,
} from '@/lib/workflow-node-picker'

export { workflowNodePickerIdentity } from '@/lib/workflow-node-picker'

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

type WorkflowNodePickerCatalogBodyProps = WorkflowNodePickerCatalogProps & {
  ownerLabel?: (ownerUserId: string | null | undefined) => string | undefined
}

export function WorkflowNodePickerCatalog(props: WorkflowNodePickerCatalogProps) {
  const hasOwners = props.agents.some(
    (agent) => agent.ownerUserId !== null && agent.ownerUserId !== undefined,
  )
  return hasOwners ? (
    <OwnerAwareWorkflowNodePickerCatalog {...props} />
  ) : (
    <WorkflowNodePickerCatalogBody {...props} />
  )
}

function OwnerAwareWorkflowNodePickerCatalog(props: WorkflowNodePickerCatalogProps) {
  const owners = useUserLookup(props.agents.map((agent) => agent.ownerUserId))
  return (
    <WorkflowNodePickerCatalogBody
      {...props}
      ownerLabel={(ownerUserId) => owners.get(ownerUserId)?.displayName ?? ownerUserId ?? undefined}
    />
  )
}

function WorkflowNodePickerCatalogBody({
  agents,
  onPick,
  onCancel,
  disabledReason,
  showDragGrip = false,
  className,
  initialFocusRef,
  ownerLabel,
}: WorkflowNodePickerCatalogBodyProps) {
  const { t } = useTranslation()
  const managedLiveRegion = useManagedLiveRegion()
  const ownSearchRef = useRef<HTMLInputElement | null>(null)
  const searchRef = initialFocusRef ?? ownSearchRef
  const categoryTabsId = `workflow-node-picker-category-${useId().replace(/:/g, '')}`
  const [query, setQuery] = useState('')
  const [activeCategory, setActiveCategory] = useState<NodePickerCategory>('all')
  const [recent, setRecent] = useState<string[]>(readRecentIdentities)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const sections = useMemo(() => buildPalette(agents, t, ownerLabel), [agents, ownerLabel, t])
  const categoryLabels = useMemo<Record<PaletteSectionKey, string>>(
    () => ({
      // RFC-304 — 'internal' holds kinds that are synthesized by the platform and
      // never authorable (currently only `code-round`). `buildPalette` produces
      // no section for it, so this label is unreachable in the UI; the entry
      // exists solely because the record is exhaustive over PaletteSectionKey.
      // Do NOT add it to the tab list — a tab would render an always-empty
      // category. Locked by palette tests.
      internal: '',
      agents: t('editor.nodePicker.categoryAgent'),
      wrappers: t('editor.nodePicker.categoryWrapper'),
      // RFC-243 — call-workflow lives in its own Calls category.
      calls: t('editor.nodePicker.categoryCalls'),
      // RFC-253 — scripts run deterministic compute with no model process.
      scripts: t('editor.nodePicker.categoryScripts'),
      integrations: t('editor.nodePicker.categoryIntegrations'), // RFC-269
      io: t('editor.nodePicker.categoryIo'),
      human: t('editor.nodePicker.categoryHuman'),
    }),
    [t],
  )
  const model = useMemo(
    () =>
      deriveNodePickerCatalog({
        sections,
        activeCategory,
        query,
        recentIdentities: recent,
        labels: {
          recommended: t('editor.nodePicker.recommended'),
          recent: t('editor.nodePicker.recent'),
        },
      }),
    [activeCategory, query, recent, sections, t],
  )
  const categoryTabs = useMemo<ReadonlyArray<TabDef<NodePickerCategory>>>(
    () => [
      {
        key: 'all',
        label: t('editor.nodePicker.categoryAll'),
        badge: model.categoryCounts.all,
        testid: 'workflow-node-picker-category-all',
      },
      {
        key: 'agents',
        label: categoryLabels.agents,
        badge: model.categoryCounts.agents,
        testid: 'workflow-node-picker-category-agents',
      },
      {
        key: 'wrappers',
        label: categoryLabels.wrappers,
        badge: model.categoryCounts.wrappers,
        testid: 'workflow-node-picker-category-wrappers',
      },
      {
        // RFC-243 — call-workflow lives in its own Calls category.
        key: 'calls',
        label: categoryLabels.calls,
        badge: model.categoryCounts.calls,
        testid: 'workflow-node-picker-category-calls',
      },
      {
        // RFC-253 — scripts run deterministic compute with no model process.
        key: 'scripts',
        label: categoryLabels.scripts,
        badge: model.categoryCounts.scripts,
        testid: 'workflow-node-picker-category-scripts',
      },
      {
        key: 'io',
        label: categoryLabels.io,
        badge: model.categoryCounts.io,
        testid: 'workflow-node-picker-category-io',
      },
      {
        key: 'human',
        label: categoryLabels.human,
        badge: model.categoryCounts.human,
        testid: 'workflow-node-picker-category-human',
      },
    ],
    [categoryLabels, model.categoryCounts, t],
  )
  const flattened = model.groups.flatMap((group) =>
    group.entries.map((entry) => ({ groupKey: group.key, entry })),
  )
  itemRefs.current.length = flattened.length

  useEffect(() => {
    setQuery('')
  }, [agents])

  useEffect(() => {
    if (managedLiveRegion === null) return
    managedLiveRegion.announce(
      model.visibleEntryCount === 0
        ? t('editor.nodePicker.noMatches')
        : activeCategory === 'all'
          ? t('editor.nodePicker.resultsCount', { n: model.visibleEntryCount })
          : t('editor.nodePicker.resultsCountInCategory', {
              n: model.visibleEntryCount,
              category: categoryLabels[activeCategory],
            }),
    )
  }, [activeCategory, categoryLabels, managedLiveRegion, model.visibleEntryCount, t])

  const focusIndex = (index: number) => {
    if (flattened.length === 0) return
    const wrapped = (index + flattened.length) % flattened.length
    itemRefs.current[wrapped]?.focus()
  }

  const choose = (entry: NodePickerEntry) => {
    if (disabledReason?.(entry.item) !== null && disabledReason?.(entry.item) !== undefined) return
    setRecent((previous) => writeRecentIdentity(entry.identity, previous))
    onPick(entry.item)
  }

  const onItemKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
    entry: NodePickerEntry,
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

  const onDragStart = (event: DragEvent<HTMLElement>, item: PaletteItem, reason: string | null) => {
    // RFC-270 — `aria-disabled` only stops click/Enter, and dragging is a
    // SECOND creation path: without this the grey-out is decoration and an
    // unprivileged user still drops the node onto the canvas.
    if (reason !== null) {
      event.preventDefault()
      return
    }
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
      <TabBar
        tabs={categoryTabs}
        active={activeCategory}
        onSelect={setActiveCategory}
        variant="segment"
        className="workflow-node-picker__category-tabs"
        rootTestid="workflow-node-picker-categories"
        idPrefix={categoryTabsId}
        ariaLabel={t('editor.nodePicker.categoriesLabel')}
      />
      <TabPanels
        active={activeCategory}
        idPrefix={categoryTabsId}
        className="workflow-node-picker__panel"
        panels={categoryTabs.map((tab) => ({
          key: tab.key,
          testid: `workflow-node-picker-category-panel-${tab.key}`,
          content:
            tab.key === activeCategory ? (
              <div
                className="workflow-node-picker__groups"
                aria-live={managedLiveRegion === null ? 'polite' : undefined}
              >
                {model.groups.map((group) => (
                  <section key={group.key} className="workflow-node-picker__group">
                    <h3 className="workflow-node-picker__group-title">{group.label}</h3>
                    <ul className="workflow-node-picker__list">
                      {group.entries.map((entry) => {
                        const index = flatIndex++
                        const reason = disabledReason?.(entry.item) ?? null
                        return (
                          <li
                            key={`${group.key}:${entry.identity}`}
                            className="workflow-node-picker__row"
                          >
                            <button
                              ref={(node) => {
                                itemRefs.current[index] = node
                              }}
                              type="button"
                              className="workflow-node-picker__item editor-sidebar__item"
                              aria-disabled={reason === null ? undefined : true}
                              data-category={entry.sectionKey}
                              data-node-kind={entry.item.kind}
                              data-testid={`workflow-node-picker-item-${entry.item.kind === 'agent-single' ? `agent-${entry.item.agentId}` : `kind-${entry.item.kind}`}`}
                              onClick={() => choose(entry)}
                              onKeyDown={(event) => onItemKeyDown(event, index, entry)}
                            >
                              <span className="workflow-node-picker__item-copy">
                                <span className="workflow-node-picker__item-heading">
                                  <span className="editor-sidebar__item-label" title={entry.label}>
                                    {entry.label}
                                  </span>
                                  <span
                                    className="chip chip--tight workflow-node-picker__type-chip"
                                    data-category={entry.sectionKey}
                                    data-node-kind={entry.item.kind}
                                  >
                                    {categoryLabels[entry.sectionKey]}
                                  </span>
                                </span>
                                <span className="editor-sidebar__item-hint">
                                  {entry.description}
                                </span>
                                {reason !== null ? (
                                  <span className="workflow-node-picker__disabled-reason">
                                    {reason}
                                  </span>
                                ) : null}
                              </span>
                              {showDragGrip ? (
                                <span
                                  className="workflow-node-picker__drag-grip"
                                  draggable={reason === null}
                                  onDragStart={(event) => onDragStart(event, entry.item, reason)}
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
            ) : null,
        }))}
      />
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
