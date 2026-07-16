// RFC-201 B2 — route-backed page section navigation.
//
// Page sections are links, not tabs: the leaf key remains the URL source of
// truth and the route owner renders every desktop destination as a real Link.
// The compact presentation reuses the shared Select and delegates its URL
// update to the owner.  A component-owned ResizeObserver chooses exactly one
// presentation from the stable layout container that owns both navigation
// and panel. Observing that containing parent (rather than a 220px rail after
// layout) prevents a desktop-rail/compact feedback loop.

import { createLink } from '@tanstack/react-router'
import {
  forwardRef,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from 'react'
import { Select, type SelectOption } from '@/components/Select'

export type PageSectionBadgeTone = 'neutral' | 'attention' | 'danger'

export interface PageSectionLeaf<K extends string> {
  key: K
  /** Plain localized text shared by desktop links and the compact Select. */
  label: string
  description?: string
  badge?: ReactNode
  badgeTone?: PageSectionBadgeTone
  badgeAriaLabel?: string
  disabled?: boolean
  disabledReason?: string
}

export interface PageSectionGroup<K extends string> {
  key: string
  label: string
  badge?: ReactNode
  badgeTone?: PageSectionBadgeTone
  badgeAriaLabel?: string
  /** Item order also defines the group's default destination. */
  items: readonly PageSectionLeaf<K>[]
}

export interface PageSectionDestinationState {
  className: string
  ariaCurrent?: 'page'
  children: ReactNode
}

interface PageSectionAnchorProps extends ComponentPropsWithoutRef<'a'> {
  /** Exact leaf ownership supplied by PageSectionNav, never fuzzy router activity. */
  pageSectionCurrent?: 'page'
  /** Injected by TanStack for fuzzy activity; exact section state replaces it. */
  'data-status'?: string
}

/**
 * TanStack-router-backed anchor whose current-page semantics are owned by the
 * exact PageSectionNav leaf. TanStack Link otherwise marks a group-default
 * destination current whenever its href happens to equal the active leaf,
 * producing two aria-current owners in the inline presentation.
 */
const PageSectionAnchor = forwardRef<HTMLAnchorElement, PageSectionAnchorProps>(
  (
    {
      pageSectionCurrent,
      'aria-current': _automaticCurrent,
      'data-status': _automaticStatus,
      ...anchorProps
    },
    ref,
  ) => {
    const className =
      _automaticStatus === 'active'
        ? anchorProps.className
            ?.split(/\s+/)
            .filter((token) => token !== 'active')
            .join(' ')
        : anchorProps.className
    return <a {...anchorProps} ref={ref} className={className} aria-current={pageSectionCurrent} />
  },
)

export const PageSectionLink = createLink(PageSectionAnchor)

export interface PageSectionNavProps<K extends string> {
  groups: readonly PageSectionGroup<K>[]
  active: K
  /** Render a real TanStack Link (or equivalent real anchor) for this leaf. */
  renderDestination: (key: K, state: PageSectionDestinationState) => ReactNode
  /** Perform the route owner's functional search update for compact mode. */
  onSelectCompact: (key: K) => void
  presentation: 'rail' | 'inline'
  /** Inline pages may keep both navigation levels on one compact desktop row. */
  inlineLayout?: 'stacked' | 'single-row'
  ariaLabel: string
  idPrefix: string
}

export interface FlatPageSection<K extends string> {
  group: PageSectionGroup<K>
  leaf: PageSectionLeaf<K>
}

export function flattenPageSectionGroups<K extends string>(
  groups: readonly PageSectionGroup<K>[],
): FlatPageSection<K>[] {
  return groups.flatMap((group) => group.items.map((leaf) => ({ group, leaf })))
}

/**
 * Locks the route owner's capability-filtered model before presentation.
 * The component calls this in dev/test; exporting it keeps the model oracle
 * independently testable without coupling callers to DOM details.
 */
export function assertPageSectionNavModel<K extends string>(
  groups: readonly PageSectionGroup<K>[],
  active: K,
): void {
  const groupKeys = new Set<string>()
  const leafKeys = new Set<K>()

  for (const group of groups) {
    if (groupKeys.has(group.key)) {
      throw new Error(`PageSectionNav: duplicate group key "${group.key}"`)
    }
    groupKeys.add(group.key)

    for (const leaf of group.items) {
      if (leafKeys.has(leaf.key)) {
        throw new Error(`PageSectionNav: duplicate leaf key "${leaf.key}"`)
      }
      leafKeys.add(leaf.key)
    }
  }

  if (!leafKeys.has(active)) {
    throw new Error(`PageSectionNav: active leaf "${active}" is not visible`)
  }
}

type ContainerMode = 'compact' | 'desktop'

const DESKTOP_MIN_REM = 56
const FALLBACK_ROOT_FONT_SIZE = 16

function rootRemPixels(): number {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return FALLBACK_ROOT_FONT_SIZE
  }
  const parsed = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : FALLBACK_ROOT_FONT_SIZE
}

function modeForInlineSize(inlineSize: number): ContainerMode {
  return inlineSize >= DESKTOP_MIN_REM * rootRemPixels() ? 'desktop' : 'compact'
}

type LegacyResizeObserverSize = ResizeObserverSize | readonly ResizeObserverSize[]

function resizeEntryInlineSize(entry: ResizeObserverEntry): number {
  // Safari historically exposed a single ResizeObserverSize while modern
  // browsers expose an array. Prefer the content box because the RFC's 56rem
  // contract is about the space available to this component's content.
  const contentBox = entry.contentBoxSize as LegacyResizeObserverSize | undefined
  if (contentBox !== undefined) {
    const firstSize = Array.isArray(contentBox) ? contentBox[0] : (contentBox as ResizeObserverSize)
    if (firstSize?.inlineSize !== undefined) return firstSize.inlineSize
  }
  return entry.contentRect.width
}

function focusBelongsToContainer(element: HTMLElement): boolean {
  const activeElement = document.activeElement
  if (!(activeElement instanceof Element)) return false
  if (element.contains(activeElement)) return true

  // Select's listbox is portaled to document.body. Treat focus in that owned
  // popup as navigation focus so a resize does not strand focus on <body>.
  const controlledId = element
    .querySelector<HTMLElement>('[role="combobox"][aria-controls]')
    ?.getAttribute('aria-controls')
  return (
    controlledId !== null &&
    controlledId !== undefined &&
    activeElement.closest<HTMLElement>('[role="listbox"]')?.id === controlledId
  )
}

function isInteractionHidden(element: Element): boolean {
  return element.closest('[hidden], [inert], [aria-hidden="true"]') !== null
}

interface ContainerModeStore {
  getSnapshot: () => ContainerMode
  getServerSnapshot: () => ContainerMode
  subscribe: (listener: () => void) => () => void
  setElement: (element: HTMLElement | null) => void
  getElement: () => HTMLElement | null
  consumeFocusHandoff: (mode: ContainerMode) => boolean
}

function createContainerModeStore(): ContainerModeStore {
  let navigationElement: HTMLElement | null = null
  let containerElement: HTMLElement | null = null
  let observer: ResizeObserver | null = null
  let mode: ContainerMode = 'compact'
  let focusHandoffTarget: ContainerMode | null = null
  const listeners = new Set<() => void>()

  const stopObserving = () => {
    observer?.disconnect()
    observer = null
  }

  const publishInlineSize = (inlineSize: number) => {
    const nextMode = modeForInlineSize(inlineSize)
    if (nextMode === mode) return
    focusHandoffTarget =
      navigationElement !== null && focusBelongsToContainer(navigationElement) ? nextMode : null
    mode = nextMode
    for (const listener of listeners) listener()
  }

  const startObserving = () => {
    if (
      observer !== null ||
      containerElement === null ||
      listeners.size === 0 ||
      typeof ResizeObserver === 'undefined'
    ) {
      return
    }
    observer = new ResizeObserver((entries) => {
      const entry = entries.find((candidate) => candidate.target === containerElement)
      if (entry !== undefined) publishInlineSize(resizeEntryInlineSize(entry))
    })
    observer.observe(containerElement)
  }

  return {
    getSnapshot: () => mode,
    getServerSnapshot: () => 'compact',
    subscribe: (listener) => {
      listeners.add(listener)
      startObserving()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) stopObserving()
      }
    },
    setElement: (nextElement) => {
      if (navigationElement === nextElement) return
      stopObserving()
      navigationElement = nextElement
      // The route must make this parent the stable nav+panel layout
      // container. Falling back to the nav itself keeps isolated usage safe;
      // a missing/zero measurement remains compact until RO reports space.
      containerElement = nextElement?.parentElement ?? nextElement
      if (containerElement !== null) {
        publishInlineSize(containerElement.getBoundingClientRect().width)
        startObserving()
      }
    },
    getElement: () => navigationElement,
    consumeFocusHandoff: (targetMode) => {
      const shouldHandoff = focusHandoffTarget === targetMode
      focusHandoffTarget = null
      return shouldHandoff
    },
  }
}

function hasBadge(value: ReactNode): boolean {
  return value !== undefined && value !== null && value !== false
}

function Badge({
  value,
  tone = 'neutral',
  ariaLabel,
}: {
  value: ReactNode
  tone?: PageSectionBadgeTone
  ariaLabel?: string
}) {
  if (!hasBadge(value)) return null
  return (
    <span
      className={`page-section-nav__badge page-section-nav__badge--${tone}`}
      data-tone={tone}
      aria-label={ariaLabel}
    >
      {value}
    </span>
  )
}

function GroupContent<K extends string>({ group }: { group: PageSectionGroup<K> }) {
  return (
    <span className="page-section-nav__destination-main">
      <span className="page-section-nav__destination-label">{group.label}</span>
      <Badge value={group.badge} tone={group.badgeTone} ariaLabel={group.badgeAriaLabel} />
    </span>
  )
}

function LeafContent<K extends string>({ leaf }: { leaf: PageSectionLeaf<K> }) {
  return (
    <>
      <span className="page-section-nav__destination-main">
        <span className="page-section-nav__destination-label">{leaf.label}</span>
        <Badge value={leaf.badge} tone={leaf.badgeTone} ariaLabel={leaf.badgeAriaLabel} />
      </span>
      {leaf.description !== undefined && leaf.description !== '' && (
        <span className="page-section-nav__destination-description">{leaf.description}</span>
      )}
      {leaf.disabled === true &&
        leaf.disabledReason !== undefined &&
        leaf.disabledReason !== '' && (
          <span className="page-section-nav__destination-disabled-reason">
            {leaf.disabledReason}
          </span>
        )}
    </>
  )
}

function compactDescription<K extends string>(
  group: PageSectionGroup<K>,
  leaf: PageSectionLeaf<K>,
): string {
  return [group.label, leaf.description, leaf.disabled === true ? leaf.disabledReason : undefined]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' · ')
}

function defaultLeafForGroup<K extends string>(
  group: PageSectionGroup<K>,
): PageSectionLeaf<K> | undefined {
  return group.items.find((leaf) => leaf.disabled !== true) ?? group.items[0]
}

export function PageSectionNav<K extends string>({
  groups,
  active,
  renderDestination,
  onSelectCompact,
  presentation,
  inlineLayout = 'stacked',
  ariaLabel,
  idPrefix,
}: PageSectionNavProps<K>) {
  if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
    assertPageSectionNavModel(groups, active)
  }

  const [modeStore] = useState(createContainerModeStore)
  const previousActiveRef = useRef<K>(active)
  const routeFocusSourceRef = useRef<Element | null>(null)
  if (previousActiveRef.current !== active) {
    const navigation = modeStore.getElement()
    const focused = typeof document === 'undefined' ? null : document.activeElement
    const owner = navigation?.parentElement
    routeFocusSourceRef.current =
      focused instanceof Element &&
      owner?.contains(focused) === true &&
      navigation?.contains(focused) !== true
        ? focused
        : null
    previousActiveRef.current = active
  }
  const mode = useSyncExternalStore(
    modeStore.subscribe,
    modeStore.getSnapshot,
    modeStore.getServerSnapshot,
  )
  const flatSections = useMemo(() => flattenPageSectionGroups(groups), [groups])
  const visibleGroups = useMemo(() => groups.filter((group) => group.items.length > 0), [groups])
  const activeGroup =
    flatSections.find(({ leaf }) => leaf.key === active)?.group ?? visibleGroups[0]
  const compactOptions = useMemo<ReadonlyArray<SelectOption<K>>>(
    () =>
      flatSections.map(({ group, leaf }) => ({
        value: leaf.key,
        label: leaf.label,
        description: compactDescription(group, leaf),
        disabled: leaf.disabled,
        group: group.label,
        badge: leaf.badge,
        badgeTone: leaf.badgeTone,
        badgeAriaLabel: leaf.badgeAriaLabel,
        groupBadge: group.badge,
        groupBadgeTone: group.badgeTone,
        groupBadgeAriaLabel: group.badgeAriaLabel,
      })),
    [flatSections],
  )

  useLayoutEffect(() => {
    if (!modeStore.consumeFocusHandoff(mode)) return
    const container = modeStore.getElement()
    if (container === null) return

    const target =
      mode === 'compact'
        ? container.querySelector<HTMLElement>('[role="combobox"]')
        : container
            .querySelector<HTMLElement>('[data-page-section-active-leaf="true"]')
            ?.querySelector<HTMLElement>(
              'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
            )
    ;(target ?? container).focus()
  }, [mode, modeStore])

  useLayoutEffect(() => {
    const previousFocused = routeFocusSourceRef.current
    routeFocusSourceRef.current = null
    // URL Back/Forward may unmount the panel that owned focus.  Link/Select
    // activation already keeps focus inside the navigation, so this handoff is
    // deliberately limited to a disconnected former panel descendant.
    if (
      previousFocused === null ||
      (previousFocused.isConnected && !isInteractionHidden(previousFocused))
    ) {
      return
    }
    const container = modeStore.getElement()
    if (container === null) return
    const target =
      mode === 'compact'
        ? container.querySelector<HTMLElement>('[role="combobox"]')
        : container
            .querySelector<HTMLElement>('[data-page-section-active-leaf="true"]')
            ?.querySelector<HTMLElement>(
              'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
            )
    ;(target ?? container).focus()
  }, [active, mode, modeStore])

  const renderLeafDestination = (leaf: PageSectionLeaf<K>, className: string) => {
    const isActive = leaf.key === active
    const children = <LeafContent leaf={leaf} />
    if (leaf.disabled === true) {
      return (
        <span
          className={`${className} ${className}--disabled`}
          aria-current={isActive ? 'page' : undefined}
          aria-disabled="true"
        >
          {children}
        </span>
      )
    }
    return renderDestination(leaf.key, {
      className,
      ariaCurrent: isActive ? 'page' : undefined,
      children,
    })
  }

  const renderGroupDestination = (group: PageSectionGroup<K>, className: string) => {
    const defaultLeaf = defaultLeafForGroup(group)
    if (defaultLeaf === undefined) return null
    return renderDestination(defaultLeaf.key, {
      className,
      // A group trigger is never the exact URL leaf and therefore never gets
      // aria-current. Its active state is visual/data-only.
      children: <GroupContent group={group} />,
    })
  }

  return (
    <nav
      ref={modeStore.setElement}
      className={`page-section-nav page-section-nav--${
        mode === 'compact' ? 'compact' : presentation
      }${presentation === 'inline' ? ` page-section-nav--inline-${inlineLayout}` : ''}`}
      aria-label={ariaLabel}
      tabIndex={-1}
      data-mode={mode}
      data-presentation={presentation}
      data-inline-layout={presentation === 'inline' ? inlineLayout : undefined}
    >
      {mode === 'compact' ? (
        <div className="page-section-nav__compact">
          <span id={`${idPrefix}-compact-label`} className="page-section-nav__compact-label">
            {ariaLabel}
          </span>
          <Select
            value={active}
            options={compactOptions}
            onChange={onSelectCompact}
            ariaLabel={ariaLabel}
            data-testid={`${idPrefix}-compact-select`}
          />
        </div>
      ) : presentation === 'rail' ? (
        <div className="page-section-nav__rail">
          {visibleGroups.map((group) => {
            const headingId = `${idPrefix}-group-${group.key}`
            return (
              <section key={group.key} className="page-section-nav__group">
                <h2 id={headingId} className="page-section-nav__group-heading">
                  <GroupContent group={group} />
                </h2>
                <ul className="page-section-nav__leaf-list" aria-labelledby={headingId}>
                  {group.items.map((leaf) => {
                    const isActive = leaf.key === active
                    return (
                      <li
                        key={leaf.key}
                        className="page-section-nav__leaf-item"
                        data-page-section-active-leaf={isActive ? 'true' : undefined}
                      >
                        {renderLeafDestination(leaf, 'page-section-nav__leaf')}
                      </li>
                    )
                  })}
                </ul>
              </section>
            )
          })}
        </div>
      ) : (
        <div className="page-section-nav__inline">
          <ul className="page-section-nav__group-triggers">
            {visibleGroups.map((group) => {
              const isActiveGroup = group.key === activeGroup?.key
              return (
                <li
                  key={group.key}
                  className="page-section-nav__group-trigger-item"
                  data-active={isActiveGroup || undefined}
                >
                  {renderGroupDestination(
                    group,
                    `page-section-nav__group-trigger${
                      isActiveGroup ? ' page-section-nav__group-trigger--active' : ''
                    }`,
                  )}
                </li>
              )
            })}
          </ul>
          {activeGroup !== undefined && (
            <div className="page-section-nav__active-group">
              <span
                id={`${idPrefix}-active-group-label`}
                className="page-section-nav__active-group-label"
              >
                {activeGroup.label}
              </span>
              <ul
                className="page-section-nav__active-group-leaves"
                aria-labelledby={`${idPrefix}-active-group-label`}
              >
                {activeGroup.items.map((leaf) => {
                  const isActive = leaf.key === active
                  return (
                    <li
                      key={leaf.key}
                      className="page-section-nav__leaf-item"
                      data-page-section-active-leaf={isActive ? 'true' : undefined}
                    >
                      {renderLeafDestination(leaf, 'page-section-nav__leaf')}
                    </li>
                  )
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </nav>
  )
}
