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
      agents: t('editor.nodePicker.categoryAgent'),
      wrappers: t('editor.nodePicker.categoryWrapper'),
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
                              data-testid={`workflow-node-picker-item-${entry.item.kind === 'agent-single' ? `agent-${entry.item.agentName}` : `kind-${entry.item.kind}`}`}
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
