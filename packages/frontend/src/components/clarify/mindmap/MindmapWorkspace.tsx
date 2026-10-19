import {
  composeMindmapFollowup,
  mindmapFollowupLimit,
  restoreMindmapFollowup,
} from '@/lib/clarify/mindmap/followup'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  clarifyQuestionSetKey,
  clarifyFollowupContext,
  type ClarifyFollowupTarget,
  type ClarifyAnswer,
  type ClarifyQuestion,
} from '@agent-workflow/shared'
import { Dialog } from '@/components/Dialog'
import { Segmented } from '@/components/Segmented'
import {
  compressMindmapCategories,
  mindmapTargetNodeId,
  projectClarifyMindmap,
  visibleMindmapNodes,
} from '@/lib/clarify/mindmap/projection'
import { indexMindmapNavigation, mindmapAncestorPath } from '@/lib/clarify/mindmap/navigation'
import type { MindmapCamera } from '@/lib/clarify/mindmap/geometry'
import { MindmapCanvas } from './MindmapCanvas'
import { MindmapCounts } from './MindmapStatus'
import { MindmapOutline } from './MindmapOutline'
import { MindmapQuestionPane } from './MindmapQuestionPane'
import './mindmap.css'

interface Props {
  title: string
  focusRequest?: { questionId: string; sequence: number }
  onFollowupError?(error: unknown): void
  questions: readonly ClarifyQuestion[]
  answers: Readonly<Record<string, ClarifyAnswer>>
  locked: ReadonlySet<string>
  disabled: boolean
  roundStatus?: string
  followupPending: boolean
  /** RFC-372 O8: the target of the round's background generation, if any. */
  followupRunning?: ClarifyFollowupTarget
  /** RFC-372 O8: the round's last failed generation and its error. */
  followupFailure?: { target: ClarifyFollowupTarget; error: unknown; instruction?: string }
  onChange(questionId: string, answer: ClarifyAnswer): void
  onFollowup(target: ClarifyFollowupTarget, instruction: string): Promise<void>
  onCancelFollowup(): Promise<void>
  renderQuestion(question: ClarifyQuestion, index: number): ReactNode
}

export function MindmapWorkspace(props: Props) {
  const { t } = useTranslation()
  const workspace = useRef<HTMLElement>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const [view, setView] = useState<'panorama' | 'focus'>('panorama')
  const [mobile, setMobile] = useState<'map' | 'outline' | 'detail'>('map')
  const [outlineOpen, setOutlineOpen] = useState(true)
  const [panelOpen, setPanelOpen] = useState(false)
  const [selected, setSelected] = useState('root')
  const [camera, setCamera] = useState<MindmapCamera | null>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [search, setSearch] = useState('')
  const [highlight, setHighlight] = useState(false)
  const [quotes, setQuotes] = useState<Record<string, string>>({})
  const [instructions, setInstructions] = useState<Record<string, string>>({})
  const [followupOpen, setFollowupOpen] = useState<Set<string>>(() => new Set())
  const [errors, setErrors] = useState<Record<string, unknown>>({})
  const [pendingParent, setPendingParent] = useState<string | null>(null)
  const [failedParent, setFailedParent] = useState<string | null>(null)
  const [added, setAdded] = useState<string[]>([])
  const seen = useRef(new Set(props.questions.map((question) => question.id)))
  const [reveal, setReveal] = useState<{ id: string; sequence: number } | null>(null)
  const nodes = useMemo(
    () => projectClarifyMindmap(props.questions, props.answers, props.locked, props.title),
    [props.questions, props.answers, props.locked, props.title],
  )
  const navigation = useMemo(() => indexMindmapNavigation(nodes), [nodes])
  const visible = useMemo(
    () => compressMindmapCategories(visibleMindmapNodes(nodes, collapsed), new Set([selected])),
    [nodes, collapsed, selected],
  )
  const topologyRevision = useMemo(
    () => clarifyQuestionSetKey(props.questions) + JSON.stringify([...collapsed]) + selected,
    [props.questions, collapsed, selected],
  )
  const selectedNode = navigation.byId.get(selected) ?? nodes[0]!
  const selectedQuestion = props.questions.find(
    (question) => question.id === selectedNode.questionId,
  )
  const children = (navigation.children.get(selectedNode.id) ?? []).map(
    (id) => navigation.byId.get(id)!,
  )
  const ancestors = mindmapAncestorPath(selectedNode.id, navigation.byId)
  const pending = props.followupPending || pendingParent !== null
  // A refreshed page or another member only knows the generation from the round.
  const generating =
    pendingParent ??
    (props.followupRunning === undefined ? null : mindmapTargetNodeId(props.followupRunning))
  const reported = props.followupFailure
  const reportedFailure =
    !pending && reported
      ? { id: mindmapTargetNodeId(reported.target), error: reported.error }
      : null
  useEffect(() => {
    if (reported?.instruction === undefined) return
    const id = mindmapTargetNodeId(reported.target)
    const restored = restoreMindmapFollowup(reported.instruction)
    setInstructions((previous) =>
      Object.hasOwn(previous, id) ? previous : { ...previous, [id]: restored.instruction },
    )
    setQuotes((previous) =>
      Object.hasOwn(previous, id) ? previous : { ...previous, [id]: restored.quote },
    )
  }, [reported?.instruction, reported?.target])
  const failed = failedParent ?? reportedFailure?.id ?? null
  const errorFor = (id: string) =>
    errors[id] ?? (reportedFailure?.id === id ? reportedFailure.error : undefined)
  const pendingQuestions = nodes.filter((node) => node.questionId && node.ownStatus !== 'done')
  const paneVisible = view === 'focus' || panelOpen
  const target: ClarifyFollowupTarget =
    selectedQuestion?.id ??
    [...ancestors, selectedNode]
      .filter((node) => node.kind === 'group' && node.id !== 'root')
      .map((node) => node.title)
  const locked = selectedQuestion
    ? props.locked.has(selectedQuestion.id)
    : !clarifyFollowupContext(props.questions, {}, target).some(
        ({ question }) => !props.locked.has(question.id),
      )

  useEffect(() => {
    const next = props.questions
      .filter((question) => !seen.current.has(question.id))
      .map((question) => question.id)
    if (next.length) setAdded(next)
    seen.current = new Set(props.questions.map((question) => question.id))
  }, [props.questions])

  const select = (id: string, locate = false, open = true) => {
    setSelected(id)
    if (open && view === 'panorama') {
      if (!panelOpen) {
        const active = document.activeElement
        if (active instanceof HTMLElement && workspace.current?.contains(active))
          trigger.current = active
      }
      setPanelOpen(true)
    }
    if (view === 'focus' && open) setMobile('detail')
    if (locate) {
      setCollapsed((previous) => {
        const next = new Set(previous)
        for (const ancestor of mindmapAncestorPath(id, navigation.byId)) next.delete(ancestor.id)
        return next
      })
      setReveal({ id, sequence: Date.now() })
    }
  }
  useEffect(() => {
    if (!props.focusRequest) return
    setSelected(`q:${props.focusRequest.questionId}`)
    setView('focus')
    setMobile('detail')
    setPanelOpen(false)
  }, [props.focusRequest])
  const nextPending = () => {
    const index = pendingQuestions.findIndex((node) => node.id === selected)
    const next = pendingQuestions[(index + 1) % pendingQuestions.length]
    if (next) select(next.id, true)
  }
  const toggle = (id: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const returnToMap = () => {
    setView('panorama')
    setPanelOpen(false)
    setMobile('map')
  }
  const startFollowup = async () => {
    if (props.disabled || locked || pending) return
    const nodeId = selectedNode.id
    const quote = quotes[nodeId] ?? ''
    const instruction = instructions[nodeId] ?? ''
    const limit = mindmapFollowupLimit(quote, instruction)
    if (limit) {
      setErrors((previous) => ({
        ...previous,
        [nodeId]: new Error(t(`mindmap.quote.${limit}Limit`)),
      }))
      return
    }
    setInstructions((previous) => ({ ...previous, [nodeId]: instruction }))
    props.onFollowupError?.(null)
    setPendingParent(selectedNode.id)
    setFailedParent(null)
    setErrors((previous) => ({ ...previous, [nodeId]: null }))
    try {
      await props.onFollowup(target, composeMindmapFollowup(quote, instruction))
    } catch (error) {
      setErrors((previous) => ({ ...previous, [nodeId]: error }))
      setFailedParent(nodeId)
      props.onFollowupError?.(error)
    } finally {
      setPendingParent(null)
    }
  }
  const cancelFollowup = () => {
    void props.onCancelFollowup().catch((error: unknown) => {
      const id = generating ?? selectedNode.id
      if (id) setErrors((previous) => ({ ...previous, [id]: error }))
    })
  }
  // Same condition as the pane's direction form: a closed branch is only read.
  const dialogTitle = selectedQuestion
    ? `${t('mindmap.detail')} · Q${props.questions.indexOf(selectedQuestion) + 1}`
    : props.disabled || locked
      ? selectedNode.title
      : t('mindmap.categoryGuidance')
  const progressKey =
    props.roundStatus === 'answered'
      ? 'mindmap.submitted'
      : props.roundStatus && props.roundStatus !== 'awaiting_human'
        ? 'mindmap.closed'
        : props.questions.length > 0 &&
            props.questions.every((question) => props.locked.has(question.id))
          ? 'mindmap.handled'
          : pending
            ? 'mindmap.generating'
            : nodes[0]!.status === 'done'
              ? 'mindmap.reviewComplete'
              : 'mindmap.confirmHint'

  const pane = (
    <MindmapQuestionPane
      node={selectedNode}
      ancestors={ancestors}
      children={children}
      question={selectedQuestion}
      questionIndex={selectedQuestion ? props.questions.indexOf(selectedQuestion) : -1}
      answer={selectedQuestion ? props.answers[selectedQuestion.id] : undefined}
      disabled={props.disabled}
      locked={locked}
      modal={view === 'panorama'}
      onFocusWorkspace={() => {
        setPanelOpen(false)
        setView('focus')
        setMobile('detail')
      }}
      onCancelFollowup={cancelFollowup}
      pending={pending}
      pendingHere={pending && generating === selectedNode.id}
      canAdvance={pendingQuestions.length > 0}
      collapsed={collapsed.has(selectedNode.id)}
      instruction={instructions[selectedNode.id] ?? ''}
      quote={quotes[selectedNode.id] ?? ''}
      onQuote={(value) => {
        setQuotes((previous) => ({ ...previous, [selectedNode.id]: value }))
        setFollowupOpen((previous) => new Set(previous).add(selectedNode.id))
      }}
      onPrompt={(value) => {
        if (value) setInstructions((previous) => ({ ...previous, [selectedNode.id]: value }))
        setFollowupOpen((previous) => new Set(previous).add(selectedNode.id))
      }}
      followupOpen={!selectedQuestion || followupOpen.has(selectedNode.id)}
      error={errorFor(selectedNode.id)}
      canRetryFollowup={Object.hasOwn(instructions, selectedNode.id)}
      onSelect={select}
      onToggle={() => toggle(selectedNode.id)}
      onReturn={returnToMap}
      onAdvance={nextPending}
      onChange={(answer) => {
        if (selectedQuestion) props.onChange(selectedQuestion.id, answer)
      }}
      onInstruction={(value) => {
        setInstructions((previous) => ({ ...previous, [selectedNode.id]: value }))
      }}
      onFollowupOpen={() => {
        setFollowupOpen((previous) => {
          const next = new Set(previous)
          if (next.has(selectedNode.id)) next.delete(selectedNode.id)
          else next.add(selectedNode.id)
          return next
        })
      }}
      onFollowup={() => {
        void startFollowup()
      }}
      renderQuestion={props.renderQuestion}
    />
  )

  return (
    <section
      ref={workspace}
      tabIndex={-1}
      onPointerDownCapture={(event) => {
        if (!panelOpen && event.target instanceof Element)
          trigger.current =
            event.target.closest<HTMLElement>('[data-node-id], canvas, button') ?? workspace.current
      }}
      className={`mindmap-workspace mindmap-workspace--${mobile}`}
      aria-label={t('mindmap.workspace')}
    >
      <div className="mindmap-workspace__toolbar">
        <Segmented
          value={view}
          onChange={(value) => {
            setView(value)
            setMobile(value === 'focus' ? 'detail' : 'map')
            if (value === 'panorama') setPanelOpen(false)
            if (value === 'focus' && selectedNode.id === 'root') {
              const first = pendingQuestions[0] ?? nodes.find((node) => node.questionId)
              if (first) select(first.id)
            }
          }}
          options={[
            { value: 'panorama', label: t('mindmap.panorama') },
            { value: 'focus', label: t('mindmap.focus') },
          ]}
          ariaLabel={t('mindmap.view')}
        />
        <button
          type="button"
          className="btn btn--sm btn--ghost mindmap-workspace__outline-control"
          aria-expanded={outlineOpen}
          onClick={() => setOutlineOpen(!outlineOpen)}
        >
          {t(outlineOpen ? 'mindmap.hideOutline' : 'mindmap.showOutline')}
        </button>
        <div className="mindmap-workspace__toolbar-actions">
          <button
            className="btn btn--sm"
            type="button"
            aria-pressed={highlight}
            onClick={() => setHighlight(!highlight)}
          >
            {t('mindmap.highlight')}
          </button>
          {!(paneVisible && selectedQuestion) && (
            <button
              className="btn btn--sm"
              type="button"
              onClick={nextPending}
              disabled={!pendingQuestions.length}
            >
              {t('mindmap.nextPending')} →
            </button>
          )}
        </div>
      </div>
      <div className="mindmap-workspace__progress" role="status">
        <MindmapCounts counts={nodes[0]!.counts} />
        <span className="mindmap-workspace__progress-hint">{t(progressKey)}</span>
        <span>
          {t('mindmap.decision.progress', {
            provisional: props.questions.filter(
              (q) => props.answers[q.id]?.decision?.status === 'provisional',
            ).length,
            unmarked: props.questions.filter((q) => !props.answers[q.id]?.decision?.status).length,
          })}
        </span>
        {pending && generating && (
          <button
            className="btn btn--sm btn--ghost"
            type="button"
            onClick={() => select(generating)}
          >
            {t('mindmap.viewGenerating')}
          </button>
        )}
        {pending && (
          <button className="btn btn--sm btn--ghost" type="button" onClick={cancelFollowup}>
            {t('mindmap.cancelFollowup')}
          </button>
        )}
        {!pending && added.length > 0 && (
          <button
            className="btn btn--sm btn--ghost"
            type="button"
            onClick={() => {
              select(`q:${added[0]!}`, true)
              setAdded([])
            }}
          >
            {t('mindmap.addedQuestions', { count: added.length })}
          </button>
        )}
        {!pending && failed && failed !== selectedNode.id && (
          <button className="btn btn--sm btn--ghost" type="button" onClick={() => select(failed)}>
            {t('mindmap.viewFailed')}
          </button>
        )}
      </div>
      <Segmented
        className="mindmap-workspace__mobile"
        value={mobile}
        onChange={(value) => {
          setMobile(value)
          if (value === 'map') returnToMap()
          if (value === 'detail') {
            setView('focus')
            setPanelOpen(true)
          }
        }}
        options={[
          { value: 'outline', label: t('mindmap.outline') },
          { value: 'map', label: t('mindmap.panorama') },
          { value: 'detail', label: t('mindmap.detail') },
        ]}
        ariaLabel={t('mindmap.workspace')}
      />
      <div
        className={`mindmap-workspace__body${outlineOpen ? '' : ' mindmap-workspace__body--no-outline'}`}
      >
        <MindmapOutline
          nodes={nodes}
          selectedId={selectedNode.id}
          collapsed={collapsed}
          search={search}
          onSearch={setSearch}
          onSelect={select}
          onToggle={toggle}
        />
        <div className={`mindmap-workspace__stage mindmap-workspace__stage--${view}`}>
          <div className="mindmap-workspace__map" hidden={view !== 'panorama'}>
            <MindmapCanvas
              rootId="root"
              topologyRevision={topologyRevision}
              nodes={visible}
              selectedId={selectedNode.id}
              camera={camera}
              onCameraChange={setCamera}
              onSelect={select}
              onFocusView={() => {
                setView('focus')
                setMobile('detail')
              }}
              highlightPending={highlight}
              revealRequest={reveal}
              onRevealHandled={() => setReveal(null)}
            />
          </div>
          {view === 'focus' && (
            <div className="mindmap-workspace__detail" aria-label={t('mindmap.detail')}>
              {pane}
            </div>
          )}
        </div>
      </div>
      <Dialog
        open={view === 'panorama' && panelOpen}
        onClose={() => setPanelOpen(false)}
        title={dialogTitle}
        size="lg"
        panelClassName="mindmap-question-dialog"
        overlayClassName="mindmap-question-dialog-overlay"
        triggerRef={trigger}
        restoreFocusFallbackRef={workspace}
      >
        <div className="mindmap-workspace__detail">{pane}</div>
      </Dialog>
    </section>
  )
}
