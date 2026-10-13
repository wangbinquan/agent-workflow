import { useMemo, useRef, useState } from 'react'
import { Field, TextInput } from './Form'
import { TreeDisclosure } from './TreeDisclosure'
import './category-tree-editor.css'

export interface CategoryTreeLabels {
  addRoot: string
  addChild: string
  rename: string
  remove: string
  removeBranch: string
  name: string
  save: string
  cancel: string
  empty: string
  duplicate: string
  required: string
  limit: string
  changed: string
  expand: string
  collapse: string
}
interface Props {
  value: readonly (readonly string[])[]
  onChange(paths: string[][]): void
  ariaLabel: string
  labels: CategoryTreeLabels
  maxNodes: number
  maxNameLength: number
}
const keyOf = (path: readonly string[]) => JSON.stringify(path)
const isWithin = (path: readonly string[], parent: readonly string[]) =>
  parent.length <= path.length && parent.every((name, i) => path[i] === name)

interface CategoryRow {
  key: string
  path: string[]
  children: string[]
  position: number
  siblings: number
}

function categoryRows(paths: Props['value']) {
  const nodes = new Map<string, CategoryRow>()
  const roots: string[] = []
  for (const path of paths)
    for (let i = 1; i <= path.length; i++) {
      const prefix = path.slice(0, i),
        key = keyOf(prefix)
      if (nodes.has(key)) continue
      nodes.set(key, { key, path: prefix, children: [], position: 1, siblings: 1 })
      const siblings = i === 1 ? roots : nodes.get(keyOf(prefix.slice(0, -1)))!.children
      siblings.push(key)
    }
  const result: CategoryRow[] = []
  const stack = [...roots].reverse()
  while (stack.length) {
    const row = nodes.get(stack.pop()!)!
    const siblings =
      row.path.length === 1 ? roots : nodes.get(keyOf(row.path.slice(0, -1)))!.children
    row.position = siblings.indexOf(row.key) + 1
    row.siblings = siblings.length
    result.push(row)
    stack.push(...[...row.children].reverse())
  }
  return result
}

/** Controlled path editor. Only a committed name/action changes the caller's configuration. */
export function CategoryTreeEditor({
  value,
  onChange,
  ariaLabel,
  labels,
  maxNodes,
  maxNameLength,
}: Props) {
  const rows = useMemo(() => categoryRows(value), [value])
  const [selectedKey, setSelectedKey] = useState('')
  const selected = rows.find((row) => row.key === selectedKey) ?? rows[0]
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const visible = rows.filter(
    (row) => !row.path.slice(0, -1).some((_, i) => collapsed.has(keyOf(row.path.slice(0, i + 1)))),
  )
  const [draft, setDraft] = useState<{
    kind: 'add' | 'rename'
    target: string[]
    name: string
  } | null>(null)
  const [error, setError] = useState('')
  const focusTarget = useRef<string | null>(null)
  const focusAddRoot = useRef(false)
  const visibleSelection =
    visible.find((row) => row.key === selected?.key) ??
    [...visible].reverse().find((row) => selected && isWithin(selected.path, row.path)) ??
    visible[0]
  const select = (key: string) => {
    focusTarget.current = key
    setSelectedKey(key)
  }
  const toggle = (key: string) => {
    select(key)
    setCollapsed((old) => {
      const next = new Set(old)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  const begin = (kind: 'add' | 'rename', target: string[]) => {
    setError('')
    setDraft({ kind, target, name: kind === 'rename' ? target.at(-1)! : '' })
  }
  const save = () => {
    if (!draft) return
    const name = draft.name.trim()
    if (!name) {
      setError(labels.required)
      return
    }
    if (name.length > maxNameLength) {
      setError(labels.limit)
      return
    }
    if (draft.target.length && !rows.some((row) => row.key === keyOf(draft.target))) {
      setError(labels.changed)
      return
    }
    const nextPath = [...(draft.kind === 'add' ? draft.target : draft.target.slice(0, -1)), name]
    const nextKey = keyOf(nextPath)
    if (
      rows.some(
        (row) =>
          row.key === nextKey && !(draft.kind === 'rename' && row.key === keyOf(draft.target)),
      )
    ) {
      setError(labels.duplicate)
      return
    }
    if (draft.kind === 'add' && rows.length >= maxNodes) {
      setError(labels.limit)
      return
    }
    const paths = rows.map((row) => row.path)
    const next =
      draft.kind === 'add'
        ? [...paths, nextPath]
        : paths.map((path) =>
            isWithin(path, draft.target) ? [...nextPath, ...path.slice(draft.target.length)] : path,
          )
    setCollapsed(
      (old) =>
        new Set(
          [...old].filter((key) => {
            const path = JSON.parse(key) as string[]
            return (
              !isWithin(nextPath, path) &&
              !(draft.kind === 'rename' && isWithin(path, draft.target))
            )
          }),
        ),
    )
    select(nextKey)
    setDraft(null)
    setError('')
    onChange(next)
  }
  const remove = () => {
    if (!selected) return
    const remaining = rows.filter((row) => !isWithin(row.path, selected.path))
    const parentKey = keyOf(selected.path.slice(0, -1))
    focusAddRoot.current = remaining.length === 0
    select(remaining.find((row) => row.key === parentKey)?.key ?? remaining[0]?.key ?? '')
    setDraft(null)
    setError('')
    onChange(remaining.map((row) => row.path))
  }
  return (
    <div className="category-tree-editor">
      {rows.length ? (
        <div role="tree" aria-label={ariaLabel} className="category-tree-editor__tree">
          {visible.map((row, index) => (
            <div
              key={row.key}
              role="treeitem"
              aria-label={row.path.at(-1)}
              aria-level={row.path.length}
              aria-posinset={row.position}
              aria-setsize={row.siblings}
              aria-expanded={row.children.length ? !collapsed.has(row.key) : undefined}
              aria-selected={selected?.key === row.key}
              tabIndex={visibleSelection?.key === row.key ? 0 : -1}
              className="category-tree-editor__row"
              style={{ paddingLeft: `${4 + Math.min(row.path.length - 1, 5) * 14}px` }}
              ref={(element) => {
                if (element && focusTarget.current === row.key) {
                  element.focus()
                  focusTarget.current = null
                }
              }}
              onClick={(event) => {
                event.currentTarget.focus()
                select(row.key)
              }}
              onKeyDown={(event) => {
                let next: string | undefined
                if (event.key === 'ArrowDown') next = visible[index + 1]?.key
                else if (event.key === 'ArrowUp') next = visible[index - 1]?.key
                else if (event.key === 'Home') next = visible[0]?.key
                else if (event.key === 'End') next = visible.at(-1)?.key
                else if (event.key === 'ArrowRight') {
                  if (collapsed.has(row.key)) toggle(row.key)
                  else next = row.children[0]
                } else if (event.key === 'ArrowLeft') {
                  if (row.children.length && !collapsed.has(row.key)) toggle(row.key)
                  else next = keyOf(row.path.slice(0, -1))
                } else if (event.key === 'Enter' || event.key === 'F2') {
                  begin('rename', row.path)
                } else return
                event.preventDefault()
                if (next && rows.some((candidate) => candidate.key === next)) select(next)
              }}
            >
              {row.children.length ? (
                <TreeDisclosure
                  expanded={!collapsed.has(row.key)}
                  label={`${collapsed.has(row.key) ? labels.expand : labels.collapse} ${row.path.at(-1)}`}
                  onToggle={() => toggle(row.key)}
                />
              ) : (
                <span className="category-tree-editor__spacer" aria-hidden="true" />
              )}
              <span className="category-tree-editor__name" title={row.path.join(' / ')}>
                {row.path.at(-1)}
              </span>
              {row.path.length > 6 && (
                <span className="muted" aria-hidden="true">
                  {row.path.length}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="category-tree-editor__empty muted">{labels.empty}</p>
      )}
      <div className="category-tree-editor__actions">
        <button
          ref={(element) => {
            if (element && focusAddRoot.current) {
              element.focus()
              focusAddRoot.current = false
            }
          }}
          type="button"
          className="btn btn--sm"
          onClick={() => begin('add', [])}
          disabled={rows.length >= maxNodes}
        >
          {labels.addRoot}
        </button>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => selected && begin('add', selected.path)}
          disabled={!selected || rows.length >= maxNodes}
        >
          {labels.addChild}
        </button>
        <span className="category-tree-editor__count muted">
          {rows.length}/{maxNodes}
        </span>
      </div>
      {selected && !draft && (
        <div className="category-tree-editor__selection">
          <span className="category-tree-editor__path" title={selected.path.join(' / ')}>
            {selected.path.join(' / ')}
          </span>
          <button
            type="button"
            className="btn btn--ghost btn--xs"
            onClick={() => begin('rename', selected.path)}
          >
            {labels.rename}
          </button>
          <button type="button" className="btn btn--ghost btn--xs" onClick={remove}>
            {selected.children.length ? labels.removeBranch : labels.remove}
          </button>
        </div>
      )}
      {draft && (
        <div className="category-tree-editor__edit">
          {draft.target.length > 0 && (
            <span className="category-tree-editor__path">{draft.target.join(' / ')}</span>
          )}
          <Field label={labels.name} error={error}>
            <TextInput
              key={`${draft.kind}:${keyOf(draft.target)}`}
              autoFocus
              aria-label={labels.name}
              value={draft.name}
              maxLength={maxNameLength}
              onChange={(name) => {
                setDraft({ ...draft, name })
                setError('')
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  save()
                }
              }}
            />
          </Field>
          <div className="category-tree-editor__actions">
            <button type="button" className="btn btn--primary btn--sm" onClick={save}>
              {labels.save}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                if (selected) focusTarget.current = selected.key
                setDraft(null)
                setError('')
              }}
            >
              {labels.cancel}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
