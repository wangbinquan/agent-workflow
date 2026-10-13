import { useMemo, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { TextInput } from '@/components/Form'
import { TreeDisclosure } from '@/components/TreeDisclosure'
import { VirtualList } from '@/components/VirtualList'
import type { MindmapNodeSummary } from '@/lib/clarify/mindmap/projection'
import {
  indexMindmapNavigation,
  mindmapAncestorPath,
  pendingMindmapDescendants,
} from '@/lib/clarify/mindmap/navigation'
import { MindmapStatus } from './MindmapStatus'

interface Props {
  nodes: readonly MindmapNodeSummary[]
  selectedId: string
  collapsed: ReadonlySet<string>
  search: string
  onSearch(value: string): void
  onSelect(id: string, locate?: boolean, open?: boolean): void
  onToggle(id: string): void
}

export function MindmapOutline(props: Props) {
  const { t } = useTranslation()
  const navigation = useMemo(() => indexMindmapNavigation(props.nodes), [props.nodes])
  // Clicking disclosure keeps selection intact, but leaves a reachable tree Tab stop.
  const [focusOverride, setFocusOverride] = useState<{
    id: string
    selectedId: string
    search: string
  } | null>(null)
  const query = props.search.trim().toLocaleLowerCase()
  const rows = useMemo(() => {
    const hidden = new Set<string>()
    return navigation.rows.filter(({ node }) => {
      if (node.id === 'root') return false
      if (query) return node.title.toLocaleLowerCase().includes(query)
      if (node.parentId && (props.collapsed.has(node.parentId) || hidden.has(node.parentId))) {
        hidden.add(node.id)
        return false
      }
      return true
    })
  }, [navigation, query, props.collapsed])
  const visibleIds = new Set(rows.map(({ node }) => node.id))
  const preferredId =
    focusOverride?.selectedId === props.selectedId && focusOverride.search === props.search
      ? focusOverride.id
      : props.selectedId
  const tabStop = visibleIds.has(preferredId)
    ? preferredId
    : query
      ? rows[0]?.node.id
      : (mindmapAncestorPath(props.selectedId, navigation.byId)
          .reverse()
          .find((node) => visibleIds.has(node.id))?.id ?? rows[0]?.node.id)
  const keyboardSelect = (id: string) => {
    setFocusOverride(null)
    props.onSelect(id, true, false)
    // The virtual row can mount after navigation. Its own ref restores focus.
    focusTarget.current = id
  }
  const focusTarget = useRef<string | null>(null)
  return (
    <nav className="mindmap-workspace__outline" aria-label={t('mindmap.outline')}>
      <div className="mindmap-outline__header">
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => props.onSelect('root')}
        >
          {t('mindmap.outline')}
        </button>
        <span className="muted">
          {t('mindmap.questionCount', {
            count:
              props.nodes[0]!.counts.done +
              props.nodes[0]!.counts.needs_detail +
              props.nodes[0]!.counts.needs_confirmation,
          })}
        </span>
      </div>
      <div className="mindmap-outline__search">
        <TextInput
          value={props.search}
          onChange={props.onSearch}
          placeholder={t('mindmap.search')}
          aria-label={t('mindmap.search')}
        />
        {query && <span className="muted">{t('mindmap.searchCount', { count: rows.length })}</span>}
      </div>
      <VirtualList
        items={rows}
        itemKey={({ node }) => node.id}
        estimateSize={44}
        scrollResetKey={query}
        scrollToKey={tabStop}
        containerProps={{
          className: 'mindmap-outline__tree',
          role: query ? 'listbox' : 'tree',
          'aria-label': t(query ? 'mindmap.searchResults' : 'mindmap.outline'),
        }}
        renderItem={(row, index) => {
          const { node, parent } = row
          const expandable = row.children.length > 0
          const pending = pendingMindmapDescendants(node)
          const total = node.counts.done + node.counts.needs_confirmation + node.counts.needs_detail
          const path = query ? mindmapAncestorPath(node.id, navigation.byId).slice(1) : []
          return (
            <div
              ref={(element) => {
                if (element && focusTarget.current === node.id) {
                  element.focus({ preventScroll: true })
                  focusTarget.current = null
                }
              }}
              role={query ? 'option' : 'treeitem'}
              aria-selected={props.selectedId === node.id}
              aria-level={query ? undefined : row.depth}
              aria-posinset={query ? index + 1 : row.position}
              aria-setsize={query ? rows.length : row.siblings}
              aria-expanded={!query && expandable ? !props.collapsed.has(node.id) : undefined}
              tabIndex={tabStop === node.id ? 0 : -1}
              className={`mindmap-outline__row mindmap-outline__row--${node.kind}`}
              data-node-id={node.id}
              data-parent-id={node.parentId ?? ''}
              data-depth={row.depth}
              data-last-sibling={row.position === row.siblings}
              data-compressed={row.depth > 6 && !query}
              style={
                {
                  '--mindmap-indent': `${query ? 0 : Math.min(5, Math.max(0, row.depth - 1)) * 14}px`,
                } as CSSProperties
              }
              onClick={(event) => {
                event.currentTarget.focus({ preventScroll: true })
                setFocusOverride(null)
                props.onSelect(node.id, !!query)
              }}
              onKeyDown={(event) => {
                const move = (id: string | undefined) => {
                  if (id) keyboardSelect(id)
                }
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  move(rows[index + (event.key === 'ArrowDown' ? 1 : -1)]?.node.id)
                } else if (event.key === 'Home' || event.key === 'End') {
                  event.preventDefault()
                  move(event.key === 'Home' ? rows[0]?.node.id : rows.at(-1)?.node.id)
                } else if (event.key === 'ArrowRight' && !query) {
                  event.preventDefault()
                  if (expandable && props.collapsed.has(node.id)) props.onToggle(node.id)
                  else move(row.children[0])
                } else if (event.key === 'ArrowLeft' && !query) {
                  event.preventDefault()
                  if (expandable && !props.collapsed.has(node.id)) props.onToggle(node.id)
                  else if (parent?.id !== 'root') move(parent?.id)
                } else if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  props.onSelect(node.id, !!query)
                }
              }}
            >
              {!query && row.depth > 1 && (
                <span className="mindmap-outline__guides" aria-hidden="true">
                  {row.guideDepths.map((depth) => (
                    <span
                      key={depth}
                      className="mindmap-outline__rail"
                      style={{ left: `${(depth - 1) * 14 + 16}px` }}
                    />
                  ))}
                  <span className="mindmap-outline__elbow" />
                </span>
              )}
              <div className="mindmap-outline__line">
                {expandable && !query ? (
                  <TreeDisclosure
                    className="mindmap-outline__toggle"
                    expanded={!props.collapsed.has(node.id)}
                    label={`${t(props.collapsed.has(node.id) ? 'mindmap.expand' : 'mindmap.collapse')} ${node.title}`}
                    onToggle={() => {
                      focusTarget.current = node.id
                      setFocusOverride({
                        id: node.id,
                        selectedId: props.selectedId,
                        search: props.search,
                      })
                      props.onToggle(node.id)
                    }}
                  />
                ) : (
                  <span className="mindmap-outline__toggle-space" aria-hidden="true" />
                )}
                <span className="mindmap-outline__text">
                  {node.kind === 'question' && (
                    <span className="mindmap-outline__number">Q{node.order + 1}</span>
                  )}
                  <span className="mindmap-outline__title" title={node.title}>
                    {node.title}
                  </span>
                </span>
                <span className="mindmap-outline__meta">
                  {node.kind === 'group' && (
                    <span
                      className="mindmap-outline__count"
                      title={`${node.counts.done} / ${total} ${t('mindmap.confirmed')}`}
                    >
                      {node.counts.done}
                      <span aria-hidden="true">/</span>
                      <span className="sr-only"> / </span>
                      {total}
                    </span>
                  )}
                  {node.kind === 'question' && pending > 0 && (
                    <span
                      className="mindmap-outline__pending"
                      title={t('mindmap.pendingChildren', { count: pending })}
                    >
                      <svg
                        aria-hidden="true"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      >
                        <path
                          d="M4 3v5a3 3 0 0 0 3 3h5m-3-3 3 3-3 3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      <span aria-hidden="true">{pending}</span>
                      <span className="sr-only">
                        {t('mindmap.pendingChildren', { count: pending })}
                      </span>
                    </span>
                  )}
                  <MindmapStatus
                    status={node.kind === 'group' ? node.status : node.ownStatus!}
                    compact
                  />
                </span>
              </div>
              {row.depth > 6 && !query && (
                <span className="mindmap-outline__path">
                  {t('mindmap.depth', { depth: row.depth })} ·{' '}
                  {parent?.kind === 'question'
                    ? t('mindmap.parentQuestion', { number: parent.order + 1 })
                    : parent?.title}
                </span>
              )}
              {query && (
                <span className="mindmap-outline__path">
                  {path
                    .map((n) => (n.kind === 'question' ? `Q${n.order + 1}` : n.title))
                    .join(' / ')}
                </span>
              )}
            </div>
          )
        }}
      />
      {rows.length === 0 && (
        <p className="mindmap-outline__empty muted">{t('mindmap.noResults')}</p>
      )}
    </nav>
  )
}
