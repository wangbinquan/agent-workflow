import { useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  clarifyAnswerBasis,
  clarifyQuestionSetKey,
  isClarifyAnswerConfirmed,
  isClarifyAnswerValid,
  type ClarifyAnswer,
  type ClarifyQuestion,
} from '@agent-workflow/shared'
import { Segmented } from '@/components/Segmented'
import { Field, TextArea, TextInput } from '@/components/Form'
import { ErrorBanner } from '@/components/ErrorBanner'
import { VirtualList } from '@/components/VirtualList'
import {
  projectClarifyMindmap,
  visibleMindmapNodes,
  type MindmapNodeSummary,
} from '@/lib/clarify/mindmap/projection'
import type { MindmapCamera } from '@/lib/clarify/mindmap/geometry'
import { MindmapCanvas } from './MindmapCanvas'
import { MindmapCounts, MindmapStatus } from './MindmapStatus'
import './mindmap.css'

interface Props {
  title: string
  questions: readonly ClarifyQuestion[]
  answers: Readonly<Record<string, ClarifyAnswer>>
  locked: ReadonlySet<string>
  disabled: boolean
  followupPending: boolean
  onChange(questionId: string, answer: ClarifyAnswer): void
  onFollowup(questionId: string, instruction: string): Promise<void>
  onCancelFollowup(): Promise<void>
  renderQuestion(question: ClarifyQuestion, index: number): ReactNode
}
export function MindmapWorkspace(props: Props) {
  const { t } = useTranslation()
  const [view, setView] = useState<'panorama' | 'focus'>('panorama')
  const [mobile, setMobile] = useState<'map' | 'outline' | 'detail'>('map')
  const [selected, setSelected] = useState('root')
  const [camera, setCamera] = useState<MindmapCamera | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [search, setSearch] = useState('')
  const [highlight, setHighlight] = useState(false)
  const [instruction, setInstruction] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [reveal, setReveal] = useState<{ id: string; sequence: number } | null>(null)
  const nodes = useMemo(
    () => projectClarifyMindmap(props.questions, props.answers, props.locked, props.title),
    [props.questions, props.answers, props.locked, props.title],
  )
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const visible = useMemo(() => visibleMindmapNodes(nodes, collapsed), [nodes, collapsed])
  const topologyRevision = useMemo(
    () => clarifyQuestionSetKey(props.questions) + JSON.stringify([...collapsed]),
    [props.questions, collapsed],
  )
  const selectedNode = byId.get(selected) ?? nodes[0]!
  const selectedQuestion = props.questions.find((q) => q.id === selectedNode.questionId)
  const answer = selectedQuestion ? props.answers[selectedQuestion.id] : undefined
  const isLocked = selectedQuestion ? props.locked.has(selectedQuestion.id) : false
  const children = nodes.filter((n) => n.parentId === selectedNode.id)
  const ancestors: MindmapNodeSummary[] = []
  let parent = selectedNode.parentId ? byId.get(selectedNode.parentId) : undefined
  while (parent) {
    ancestors.unshift(parent)
    parent = parent.parentId ? byId.get(parent.parentId) : undefined
  }
  const query = search.trim().toLocaleLowerCase()
  const outline = query ? nodes.filter((n) => n.title.toLocaleLowerCase().includes(query)) : visible
  const select = (id: string, locate = false) => {
    setSelected(id)
    setError(null)
    if (locate) {
      const next = new Set(collapsed)
      let node = byId.get(id)
      while (node?.parentId) {
        next.delete(node.parentId)
        node = byId.get(node.parentId)
      }
      setCollapsed(next)
      setReveal({ id, sequence: Date.now() })
    }
  }
  const list = (items: readonly MindmapNodeSummary[], searchResults = false) => (
    <VirtualList
      items={items}
      itemKey={(n) => n.id}
      estimateSize={72}
      height="100%"
      scrollResetKey={searchResults ? query : selectedNode.id}
      containerProps={{ role: 'list', 'aria-label': t('mindmap.outline') }}
      rowRole="listitem"
      renderItem={(n) => (
        <button
          className="mindmap-workspace__branch"
          type="button"
          aria-pressed={selectedNode.id === n.id}
          onClick={() => {
            select(n.id, searchResults)
            setMobile('detail')
          }}
        >
          <span>{n.title}</span>
          <MindmapCounts counts={n.counts} />
        </button>
      )}
    />
  )
  return (
    <section
      className={`mindmap-workspace mindmap-workspace--${mobile}`}
      aria-label={t('mindmap.workspace')}
    >
      <div className="mindmap-workspace__toolbar">
        <Segmented
          value={view}
          onChange={(v) => {
            setView(v)
            setMobile('map')
          }}
          options={[
            { value: 'panorama', label: t('mindmap.panorama') },
            { value: 'focus', label: t('mindmap.focus') },
          ]}
          ariaLabel={t('mindmap.view')}
        />
        <TextInput
          value={search}
          onChange={setSearch}
          placeholder={t('mindmap.search')}
          aria-label={t('mindmap.search')}
        />
        <button
          className="btn btn--sm"
          type="button"
          aria-pressed={highlight}
          onClick={() => setHighlight(!highlight)}
        >
          {t('mindmap.highlight')}
        </button>
        <button
          className="btn btn--sm"
          type="button"
          onClick={() => {
            const pending = nodes.filter((n) => n.questionId && n.ownStatus !== 'done')
            const index = pending.findIndex((n) => n.id === selected)
            const next = pending[(index + 1) % pending.length]
            if (next) {
              select(next.id, true)
              setMobile('detail')
            }
          }}
          disabled={nodes[0]!.counts.done === props.questions.length}
        >
          {t('mindmap.nextPending')}
        </button>
      </div>
      <div className="mindmap-workspace__progress" role="status">
        <MindmapCounts counts={nodes[0]!.counts} />
        {nodes[0]!.status === 'done' ? t('mindmap.reviewComplete') : t('mindmap.confirmHint')}
      </div>
      <Segmented
        className="mindmap-workspace__mobile"
        value={mobile}
        onChange={setMobile}
        options={[
          { value: 'map', label: t(`mindmap.${view}`) },
          { value: 'outline', label: t('mindmap.outline') },
          { value: 'detail', label: t('mindmap.detail') },
        ]}
        ariaLabel={t('mindmap.workspace')}
      />
      <div
        className={`mindmap-workspace__body${view === 'panorama' && selectedNode.id === 'root' ? ' mindmap-workspace__body--overview' : ''}`}
      >
        <nav className="mindmap-workspace__outline">{list(outline, !!query)}</nav>
        <div className="mindmap-workspace__map">
          {view === 'panorama' ? (
            <MindmapCanvas
              rootId="root"
              topologyRevision={topologyRevision}
              nodes={visible}
              selectedId={selectedNode.id}
              camera={camera}
              onCameraChange={setCamera}
              onSelect={(id) => {
                select(id)
                setMobile('detail')
              }}
              onFocusView={() => setView('focus')}
              highlightPending={highlight}
              revealRequest={reveal}
              onRevealHandled={() => setReveal(null)}
            />
          ) : (
            <div className="mindmap-workspace__focus">
              <h3>{selectedNode.title}</h3>
              {list(children.length ? children : [selectedNode])}
            </div>
          )}
        </div>
        <div className="mindmap-workspace__detail">
          <nav className="mindmap-workspace__breadcrumbs" aria-label={t('mindmap.path')}>
            {ancestors.map((n) => (
              <button
                key={n.id}
                className="btn btn--sm btn--ghost"
                type="button"
                onClick={() => select(n.id)}
              >
                {n.title}
              </button>
            ))}
          </nav>
          <h3>{selectedNode.title}</h3>
          <MindmapStatus status={selectedNode.status} />
          {children.length > 0 && (
            <button
              className="btn btn--sm"
              type="button"
              aria-expanded={!collapsed.has(selectedNode.id)}
              onClick={() =>
                setCollapsed((prev) => {
                  const next = new Set(prev)
                  if (next.has(selectedNode.id)) next.delete(selectedNode.id)
                  else next.add(selectedNode.id)
                  return next
                })
              }
            >
              {t(collapsed.has(selectedNode.id) ? 'mindmap.expand' : 'mindmap.collapse')}
            </button>
          )}
          {selectedQuestion ? (
            <>
              {props.renderQuestion(selectedQuestion, props.questions.indexOf(selectedQuestion))}
              {!props.disabled && !isLocked && answer && (
                <>
                  <button
                    className="btn btn--primary"
                    type="button"
                    disabled={
                      !isClarifyAnswerValid(selectedQuestion, answer) ||
                      isClarifyAnswerConfirmed(selectedQuestion, answer)
                    }
                    onClick={() =>
                      props.onChange(selectedQuestion.id, {
                        ...answer,
                        confirmedBasis: clarifyAnswerBasis(selectedQuestion, answer),
                      })
                    }
                  >
                    {t(
                      isClarifyAnswerConfirmed(selectedQuestion, answer)
                        ? 'mindmap.confirmed'
                        : 'mindmap.confirm',
                    )}
                  </button>
                  <Field label={t('mindmap.followupHint')}>
                    <TextArea
                      rows={2}
                      maxLength={2000}
                      value={instruction}
                      onChange={setInstruction}
                    />
                  </Field>
                  <button
                    className="btn"
                    type="button"
                    disabled={props.followupPending}
                    onClick={() => {
                      setError(null)
                      void props.onFollowup(selectedQuestion.id, instruction).catch(setError)
                    }}
                  >
                    {t(props.followupPending ? 'mindmap.generating' : 'mindmap.followup')}
                  </button>
                </>
              )}
            </>
          ) : (
            <p className="muted">{t('mindmap.groupHint')}</p>
          )}
          {props.followupPending && (
            <button
              className="btn"
              type="button"
              onClick={() => {
                void props.onCancelFollowup().catch(setError)
              }}
            >
              {t('mindmap.cancelFollowup')}
            </button>
          )}
          {error != null && <ErrorBanner error={error} />}
        </div>
      </div>
    </section>
  )
}
