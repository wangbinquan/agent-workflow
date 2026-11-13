import {
  composeMindmapFollowup,
  mindmapFollowupLimit,
  restoreMindmapFollowup,
} from '@/lib/clarify/mindmap/followup'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  clarifyQuestionSetKey,
  clarifyFollowupContext,
  clarifySkipStatus,
  type ClarifyFollowupTarget,
  type ClarifyAnswer,
  type ClarifyQuestion,
  type ClarifySkipStatus,
} from '@agent-workflow/shared'
import { Segmented } from '@/components/Segmented'
import {
  compressMindmapCategories,
  mindmapTargetNodeId,
  projectClarifyMindmap,
  visibleMindmapNodes,
} from '@/lib/clarify/mindmap/projection'
import { indexMindmapNavigation, mindmapAncestorPath } from '@/lib/clarify/mindmap/navigation'
import { mindmapColumns } from '@/lib/clarify/mindmap/layout'
import {
  explainClarifySkip,
  resumeClarifyAnswer,
  skipClarifyAnswer,
} from '@/lib/clarify/mindmap/skip'
import { suggestMindmapSteps, type MindmapSuggestion } from '@/lib/clarify/mindmap/suggestions'
import type { MindmapCamera } from '@/lib/clarify/mindmap/geometry'
import { MindmapCanvas } from './MindmapCanvas'
import { MindmapCounts } from './MindmapStatus'
import { MindmapOutline } from './MindmapOutline'
import { MindmapQuestionPane } from './MindmapQuestionPane'
import './mindmap.css'

/** RFC-490: below this stage width the panel replaces the canvas instead of sharing it. */
export const MINDMAP_SPLIT_MIN = 760
/** RFC-490: a panel at least this tall, and wide enough to put the reason and the
 *  maturity on one row, keeps them beside its confirm button. A smaller one (a phone, a
 *  small laptop, the narrow side panel) leaves that room to the options. */
export const MINDMAP_ROOMY_MIN = 560
export const MINDMAP_ROOMY_WIDTH = 460
/** How wide the panel is beside the canvas: mindmap.css, `[data-split='side']`. */
const sidePanelWidth = (stageWidth: number) => Math.min(620, Math.max(420, stageWidth * 0.46))

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
  /** RFC-490: category paths configured on the frozen clarify node. A configured
   *  path nobody asked about yet still shows, so the gap is visible. */
  categoryPaths?: readonly (readonly string[])[]
  /** RFC-490: the task's launch inputs, readable from the root node. */
  taskInputs?: readonly { label: string; value: string }[]
  onChange(questionId: string, answer: ClarifyAnswer): void
  onFollowup(target: ClarifyFollowupTarget, instruction: string): Promise<void>
  onCancelFollowup(): Promise<void>
  renderQuestion(question: ClarifyQuestion, index: number): ReactNode
}
const NO_PATHS: readonly (readonly string[])[] = []

export function MindmapWorkspace(props: Props) {
  const { t } = useTranslation()
  const workspace = useRef<HTMLElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const detail = useRef<HTMLElement>(null)
  const trigger = useRef<HTMLElement | null>(null)
  // Kept current by the pane: the answer form of an answerable question, else its heading.
  const paneFocus = useRef<HTMLElement | null>(null)
  const [view, setView] = useState<'panorama' | 'focus'>('panorama')
  const [mobile, setMobile] = useState<'map' | 'outline' | 'detail'>('map')
  const [outlineOpen, setOutlineOpen] = useState(true)
  const [panelOpen, setPanelOpen] = useState(false)
  const [selected, setSelected] = useState('root')
  const [camera, setCamera] = useState<MindmapCamera | null>(null)
  // Measured from the stage, never the canvas: the panel must not change either value.
  const [stageFit, setStageFit] = useState<{
    columns: number
    wide: boolean
    /** The panel has the room when it takes the whole stage / when it shares it. */
    roomy: boolean
    sideRoomy: boolean
  } | null>(null)
  // In-session only: what a question held before it was skipped, for "answer instead".
  const beforeSkip = useRef(new Map<string, ClarifyAnswer>())
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
  const [focusSequence, setFocusSequence] = useState(0)
  const seen = useRef(new Set(props.questions.map((question) => question.id)))
  const [reveal, setReveal] = useState<{ id: string; sequence: number } | null>(null)
  const categoryPaths = props.categoryPaths ?? NO_PATHS
  const nodes = useMemo(
    () =>
      projectClarifyMindmap(
        props.questions,
        props.answers,
        props.locked,
        props.title,
        categoryPaths,
      ),
    [props.questions, props.answers, props.locked, props.title, categoryPaths],
  )
  const navigation = useMemo(() => indexMindmapNavigation(nodes), [nodes])
  const visible = useMemo(
    () => compressMindmapCategories(visibleMindmapNodes(nodes, collapsed), new Set([selected])),
    [nodes, collapsed, selected],
  )
  const topologyRevision = useMemo(
    () =>
      clarifyQuestionSetKey(props.questions) +
      JSON.stringify(categoryPaths) +
      JSON.stringify([...collapsed]) +
      selected,
    [props.questions, categoryPaths, collapsed, selected],
  )
  const suggestions = useMemo(
    () =>
      props.disabled
        ? []
        : suggestMindmapSteps({
            questions: props.questions,
            answers: props.answers,
            locked: props.locked,
            categoryPaths,
          }),
    [props.disabled, props.questions, props.answers, props.locked, categoryPaths],
  )
  const selectedNode = navigation.byId.get(selected) ?? nodes[0]!
  const selectedQuestion = props.questions.find(
    (question) => question.id === selectedNode.questionId,
  )
  const children = (navigation.children.get(selectedNode.id) ?? []).map(
    (id) => navigation.byId.get(id)!,
  )
  const ancestors = mindmapAncestorPath(selectedNode.id, navigation.byId)
  const parentNode = ancestors.at(-1)
  const parentQuestion =
    parentNode?.kind === 'question'
      ? props.questions.find((question) => question.id === parentNode.questionId)
      : undefined
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
  const split = view === 'panorama' && panelOpen
  // Beside the canvas when the stage has the room; otherwise the panel takes its place.
  const side = split && (stageFit?.wide ?? true)
  const target: ClarifyFollowupTarget =
    selectedQuestion?.id ??
    [...ancestors, selectedNode]
      .filter((node) => node.kind === 'group' && node.id !== 'root')
      .map((node) => node.title)
  // A branch is closed once every question in it is sealed. An empty configured category
  // has none of its own, so it follows the map: open while any question is still open.
  const locked = selectedQuestion
    ? props.locked.has(selectedQuestion.id)
    : !(
        selectedNode.empty
          ? props.questions.map((question) => ({ question }))
          : clarifyFollowupContext(props.questions, {}, target)
      ).some(({ question }) => !props.locked.has(question.id))

  useEffect(() => {
    const next = props.questions
      .filter((question) => !seen.current.has(question.id))
      .map((question) => question.id)
    if (next.length) setAdded(next)
    seen.current = new Set(props.questions.map((question) => question.id))
  }, [props.questions])
  // Before the first paint, so the canvas is laid out once with the right column count.
  useLayoutEffect(() => {
    const element = stage.current
    if (!element) return
    const apply = (width: number, height: number) => {
      // A hidden stage reports nothing; the last real measurement stands.
      if (!(width > 0)) return
      const tall = height >= MINDMAP_ROOMY_MIN
      const next = {
        columns: mindmapColumns(width),
        wide: width > MINDMAP_SPLIT_MIN,
        roomy: tall && width >= MINDMAP_ROOMY_WIDTH,
        sideRoomy: tall && sidePanelWidth(width) >= MINDMAP_ROOMY_WIDTH,
      }
      setStageFit((previous) =>
        previous?.columns === next.columns &&
        previous.wide === next.wide &&
        previous.roomy === next.roomy &&
        previous.sideRoomy === next.sideRoomy
          ? previous
          : next,
      )
    }
    const box = element.getBoundingClientRect()
    apply(box.width, box.height)
    // Nothing to measure yet (a hidden tab, no layout): estimate from the window.
    setStageFit(
      (previous) =>
        previous ?? {
          columns: mindmapColumns(window.innerWidth),
          wide: true,
          roomy: true,
          sideRoomy: true,
        },
    )
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect
      apply(rect?.width ?? 0, rect?.height ?? 0)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (focusSequence) paneFocus.current?.focus({ preventScroll: true })
  }, [focusSequence])
  // After the panel is gone, not before: while it covers the stage the canvas is not
  // rendered and cannot take focus. The element that opened the panel comes first; if
  // it is not showing any more (a phone's outline tab), the canvas, then the workspace.
  const restoreOnClose = useRef(false)
  useLayoutEffect(() => {
    if (!restoreOnClose.current || paneVisible) return
    restoreOnClose.current = false
    for (const element of [
      trigger.current,
      workspace.current?.querySelector<HTMLElement>('.mindmap-canvas__surface'),
      workspace.current,
    ]) {
      if (!element?.isConnected) continue
      element.focus({ preventScroll: true })
      if (document.activeElement === element) return
    }
  })

  /** `focus` hands the keyboard to the panel (a canvas pick, "next pending", moving on
   *  from inside the panel). The outline keeps it, so its arrow keys go on working. */
  const select = (
    id: string,
    options: { locate?: boolean; open?: boolean; focus?: boolean } = {},
  ) => {
    const { locate = false, open = true, focus = false } = options
    setSelected(id)
    if (open) {
      const active = document.activeElement
      if (
        active instanceof HTMLElement &&
        workspace.current?.contains(active) &&
        !detail.current?.contains(active)
      )
        trigger.current = active
      if (view === 'panorama') setPanelOpen(true)
      setMobile('detail')
      if (focus) setFocusSequence((value) => value + 1)
    }
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
    setFocusSequence((value) => value + 1)
  }, [props.focusRequest])
  const nextPending = () => {
    const index = pendingQuestions.findIndex((node) => node.id === selected)
    const next = pendingQuestions[(index + 1) % pendingQuestions.length]
    if (next) select(next.id, { locate: true, focus: true })
  }
  const toggle = (id: string) =>
    setCollapsed((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const returnToMap = () => {
    // Only a keyboard that was in the panel is handed back; one that never entered it
    // (an outline row, the canvas) stays where it is.
    restoreOnClose.current = detail.current?.contains(document.activeElement) ?? false
    setView('panorama')
    setPanelOpen(false)
    setMobile('map')
  }
  const openFollowup = (id: string, instruction?: string) => {
    if (instruction)
      setInstructions((previous) => ({ ...previous, [id]: previous[id] || instruction }))
    setFollowupOpen((previous) => new Set(previous).add(id))
  }
  const applySuggestion = (suggestion: MindmapSuggestion) => {
    const go = (id: string) => select(id, { locate: true, focus: true })
    if (suggestion.kind === 'empty-category') go(mindmapTargetNodeId(suggestion.path))
    else if (suggestion.kind === 'recommendation-unexamined') {
      openFollowup(`q:${suggestion.questionId}`, t('mindmap.prompts.evidenceText'))
      go(`q:${suggestion.questionId}`)
    } else if (suggestion.kind === 'provisional-unplanned') go(`q:${suggestion.questionId}`)
    else go(`q:${suggestion.questionIds[0]!}`)
  }
  const selectedAnswer = selectedQuestion ? props.answers[selectedQuestion.id] : undefined
  const skip = (status: ClarifySkipStatus) => {
    if (!selectedQuestion || !selectedAnswer) return
    if (!clarifySkipStatus(selectedAnswer))
      beforeSkip.current.set(selectedQuestion.id, selectedAnswer)
    props.onChange(selectedQuestion.id, skipClarifyAnswer(selectedQuestion, selectedAnswer, status))
  }
  const resume = () => {
    if (!selectedQuestion || !selectedAnswer) return
    const before = beforeSkip.current.get(selectedQuestion.id)
    beforeSkip.current.delete(selectedQuestion.id)
    props.onChange(selectedQuestion.id, resumeClarifyAnswer(selectedAnswer, before))
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
  const decisionCount = (status: string) =>
    props.questions.filter((q) => props.answers[q.id]?.decision?.status === status).length
  const skipped = { na: decisionCount('not-applicable'), deferred: decisionCount('deferred') }
  const answered = props.questions.filter((q) => {
    const answer = props.answers[q.id]
    return !!answer && (answer.selectedOptionIndices.length > 0 || !!answer.customText.trim())
  })

  return (
    <section
      ref={workspace}
      tabIndex={-1}
      onPointerDownCapture={(event) => {
        // Whatever the user last pressed outside the pane is where focus returns to.
        if (event.target instanceof Element && !detail.current?.contains(event.target))
          trigger.current =
            event.target.closest<HTMLElement>('[data-node-id], canvas, button') ?? workspace.current
      }}
      onKeyDown={(event) => {
        // The panel is not a modal: Escape anywhere in the workspace puts it away,
        // unless a child layer (a form, a list, the search box) already used the key.
        if (event.key !== 'Escape' || event.defaultPrevented || !split) return
        event.preventDefault()
        returnToMap()
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
              if (first) select(first.id, { focus: true })
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
            provisional: decisionCount('provisional'),
            unmarked: answered.filter((q) => !props.answers[q.id]?.decision?.status).length,
          })}
          {skipped.na + skipped.deferred > 0 && <> · {t('mindmap.decision.skipped', skipped)}</>}
        </span>
        {pending && generating && (
          <button
            className="btn btn--sm btn--ghost"
            type="button"
            onClick={() => select(generating, { focus: true })}
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
              select(`q:${added[0]!}`, { locate: true, focus: true })
              setAdded([])
            }}
          >
            {t('mindmap.addedQuestions', { count: added.length })}
          </button>
        )}
        {!pending && failed && failed !== selectedNode.id && (
          <button
            className="btn btn--sm btn--ghost"
            type="button"
            onClick={() => select(failed, { focus: true })}
          >
            {t('mindmap.viewFailed')}
          </button>
        )}
        {!pending && nodes[0]!.status === 'done' && suggestions.length > 0 && (
          <button
            className="btn btn--sm btn--ghost"
            type="button"
            data-testid="mindmap-suggestions-open"
            onClick={() => select('root', { focus: true })}
          >
            {t('mindmap.suggestions.count', { count: suggestions.length })}
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
          onSelect={(id, locate, open) => select(id, { locate, open })}
          onToggle={toggle}
        />
        <div ref={stage} className={`mindmap-workspace__stage mindmap-workspace__stage--${view}`}>
          <div
            className="mindmap-workspace__panes"
            data-split={split ? (side ? 'side' : 'full') : undefined}
          >
            <div className="mindmap-workspace__map" hidden={view !== 'panorama'}>
              {stageFit && (
                <MindmapCanvas
                  rootId="root"
                  topologyRevision={topologyRevision}
                  columns={stageFit.columns}
                  panelOpen={side}
                  nodes={visible}
                  selectedId={selectedNode.id}
                  camera={camera}
                  onCameraChange={setCamera}
                  onSelect={(id) => select(id, { focus: true })}
                  onFocusView={() => {
                    setView('focus')
                    setMobile('detail')
                  }}
                  highlightPending={highlight}
                  revealRequest={reveal}
                  onRevealHandled={() => setReveal(null)}
                />
              )}
            </div>
            {paneVisible && (
              <section
                ref={detail}
                className="mindmap-workspace__detail"
                aria-label={t('mindmap.detail')}
              >
                <MindmapQuestionPane
                  node={selectedNode}
                  ancestors={ancestors}
                  children={children}
                  question={selectedQuestion}
                  questionIndex={selectedQuestion ? props.questions.indexOf(selectedQuestion) : -1}
                  answer={selectedAnswer}
                  questions={props.questions}
                  parentQuestion={parentQuestion}
                  parentAnswer={parentQuestion ? props.answers[parentQuestion.id] : undefined}
                  disabled={props.disabled}
                  locked={locked}
                  side={side}
                  decisionInBar={(side ? stageFit?.sideRoomy : stageFit?.roomy) ?? true}
                  focusTargetRef={paneFocus}
                  suggestions={selectedNode.id === 'root' ? suggestions : undefined}
                  taskInputs={selectedNode.id === 'root' ? props.taskInputs : undefined}
                  onSuggestion={applySuggestion}
                  onFocusWorkspace={() => {
                    setPanelOpen(false)
                    setView('focus')
                    setMobile('detail')
                    setFocusSequence((value) => value + 1)
                  }}
                  onCancelFollowup={cancelFollowup}
                  pending={pending}
                  pendingHere={pending && generating === selectedNode.id}
                  canAdvance={pendingQuestions.length > 0}
                  othersPending={pendingQuestions.some((node) => node.id !== selectedNode.id)}
                  collapsed={collapsed.has(selectedNode.id)}
                  instruction={instructions[selectedNode.id] ?? ''}
                  quote={quotes[selectedNode.id] ?? ''}
                  onQuote={(value) => {
                    setQuotes((previous) => ({ ...previous, [selectedNode.id]: value }))
                    openFollowup(selectedNode.id)
                  }}
                  onPrompt={(value) => {
                    if (value)
                      setInstructions((previous) => ({ ...previous, [selectedNode.id]: value }))
                    openFollowup(selectedNode.id)
                  }}
                  followupOpen={!selectedQuestion || followupOpen.has(selectedNode.id)}
                  error={errorFor(selectedNode.id)}
                  canRetryFollowup={Object.hasOwn(instructions, selectedNode.id)}
                  onSelect={(id) => select(id, { focus: true })}
                  onToggle={() => toggle(selectedNode.id)}
                  onReturn={returnToMap}
                  onAdvance={nextPending}
                  onChange={(answer) => {
                    if (selectedQuestion) props.onChange(selectedQuestion.id, answer)
                  }}
                  onSkip={skip}
                  onSkipNote={(note) => {
                    if (selectedQuestion && selectedAnswer)
                      props.onChange(
                        selectedQuestion.id,
                        explainClarifySkip(selectedQuestion, selectedAnswer, note),
                      )
                  }}
                  onResume={resume}
                  onFollowupClose={() =>
                    setFollowupOpen((previous) => {
                      const next = new Set(previous)
                      next.delete(selectedNode.id)
                      return next
                    })
                  }
                  onInstruction={(value) => {
                    setInstructions((previous) => ({ ...previous, [selectedNode.id]: value }))
                  }}
                  onFollowup={() => {
                    void startFollowup()
                  }}
                  renderQuestion={props.renderQuestion}
                />
              </section>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
