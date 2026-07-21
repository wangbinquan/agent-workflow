// RFC-211 §12 — tour scripts.
//
// A step points at a real element (by `data-tour` OR an existing `data-testid`)
// and tells the user what to do. It advances one of two ways:
//   - `advanceOnRoute`: the user did the thing and the app moved them (saved an
//     agent → landed on its page). No Next button; the tour follows the action.
//   - otherwise: an explanatory / in-page step the user dismisses with Next.
//
// `route` is where the step's anchor lives; if the user isn't there, the bubble
// offers a "go to page" button instead of pointing at nothing.
//
// Anchors are defined ON the real components. tour-anchors.test.tsx fails if a
// referenced anchor has no `data-tour`/`data-testid` home.

export type TourId = 'first-task' | 'build-workflow' | 'use-workgroup'

export interface TourStep {
  /** CSS selector for the element to spotlight (a `[data-tour]`/`[data-testid]`). */
  anchor: string
  /** The route this step's anchor lives on (offers a "go here" nudge if away). */
  route?: string
  /** Auto-advance when the user reaches a route starting with this. */
  advanceOnRoute?: string
  /**
   * Advance only when the user CLICKS the highlighted element (no Next button).
   * Use this when the next step's anchor only exists AFTER this click — e.g.
   * switching to a tab, opening a picker — so a user who pressed Next instead
   * would land on a step whose target isn't on screen yet and the bubble would
   * float over nothing.
   */
  advanceOnClick?: boolean
  /**
   * Pre-fill a real form field so the user doesn't have to type. `selector`
   * targets an <input>/<textarea>; the tour sets its value the React-friendly
   * way (native setter + input event) when the step opens. The user can still
   * edit it — it's a head start, not a lock.
   */
  fill?: { selector: string; value: string }
  titleKey: string
  bodyKey: string
}

export interface Tour {
  id: TourId
  steps: readonly TourStep[]
}

/**
 * The canonical first run: build an agent (name + an output port), launch it,
 * and read the result — the whole build → run → result loop, done by hand on the
 * real screens.
 */
const FIRST_TASK: Tour = {
  id: 'first-task',
  steps: [
    {
      anchor: '[data-tour="nav-/agents"]',
      route: '/',
      advanceOnRoute: '/agents',
      titleKey: 'tour.firstTask.openAgents.title',
      bodyKey: 'tour.firstTask.openAgents.body',
    },
    {
      anchor: '[data-tour="split-new"]',
      route: '/agents',
      advanceOnRoute: '/agents/new',
      titleKey: 'tour.firstTask.newAgent.title',
      bodyKey: 'tour.firstTask.newAgent.body',
    },
    {
      anchor: '[data-tour="agent-name"]',
      route: '/agents/new',
      // Prefilled so the user just watches it land, then moves on.
      fill: { selector: '[data-tour="agent-name"] input', value: 'my-coder' },
      titleKey: 'tour.firstTask.name.title',
      bodyKey: 'tour.firstTask.name.body',
    },
    {
      anchor: '[data-testid="agent-tab-ports"]',
      route: '/agents/new',
      // The next step (add-output-port) only exists once the ports tab is open,
      // so require the click rather than offering a Next that would skip it.
      advanceOnClick: true,
      titleKey: 'tour.firstTask.portsTab.title',
      bodyKey: 'tour.firstTask.portsTab.body',
    },
    {
      anchor: '[data-testid="agent-output-port-add"]',
      route: '/agents/new',
      titleKey: 'tour.firstTask.addPort.title',
      bodyKey: 'tour.firstTask.addPort.body',
    },
    {
      anchor: '[data-tour="agent-save"]',
      route: '/agents/new',
      // Saving a new agent lands on /agents/$name.
      advanceOnRoute: '/agents/',
      titleKey: 'tour.firstTask.saveAgent.title',
      bodyKey: 'tour.firstTask.saveAgent.body',
    },
    {
      anchor: '[data-tour="agent-launch"]',
      route: '/agents/',
      advanceOnRoute: '/tasks/new',
      titleKey: 'tour.firstTask.launch.title',
      bodyKey: 'tour.firstTask.launch.body',
    },
    {
      // The launch entry deep-links with `tour=first-task`, so the wizard opens
      // on its Confirm step with a sample task name + prompt prefilled and a
      // scratch (no-repo) space — the submit button is on screen and enabled.
      // Advance on the CLICK, not on a `/tasks/` route: `/tasks/` is a prefix of
      // `/tasks/new`, so a route-advance here would fire the instant the wizard
      // loaded and skip this step (the bug that stranded the tour at launch).
      anchor: '[data-tour="task-submit"]',
      route: '/tasks/new',
      advanceOnClick: true,
      titleKey: 'tour.firstTask.submit.title',
      bodyKey: 'tour.firstTask.submit.body',
    },
    {
      anchor: '[data-tour="task-status"]',
      route: '/tasks/',
      titleKey: 'tour.firstTask.result.title',
      bodyKey: 'tour.firstTask.result.body',
    },
  ],
}

/**
 * Chain agents into a pipeline. The canvas is a dynamic node graph, so the tour
 * guides to the editor and explains the moves rather than spotlighting each
 * (unstable) node — the reliable anchors are the entry points and the launch.
 */
const BUILD_WORKFLOW: Tour = {
  id: 'build-workflow',
  steps: [
    {
      anchor: '[data-tour="nav-/workflows"]',
      route: '/',
      advanceOnRoute: '/workflows',
      titleKey: 'tour.buildWorkflow.openWorkflows.title',
      bodyKey: 'tour.buildWorkflow.openWorkflows.body',
    },
    {
      anchor: '[data-testid="workflow-new-button"]',
      route: '/workflows',
      // Creating a workflow lands on its editor (/workflows/$id) where the next
      // step's anchor lives.
      advanceOnRoute: '/workflows/',
      titleKey: 'tour.buildWorkflow.newWorkflow.title',
      bodyKey: 'tour.buildWorkflow.newWorkflow.body',
    },
    {
      // The empty-canvas starter button — the header duplicate was removed;
      // a freshly created workflow always shows the empty state, so the
      // anchor is present exactly when this step runs (and the step copy
      // already says 「空画布上点…」).
      anchor: '[data-testid="workflow-empty-start-template"]',
      route: '/workflows/',
      titleKey: 'tour.buildWorkflow.template.title',
      bodyKey: 'tour.buildWorkflow.template.body',
    },
  ],
}

/** Form a squad, add members, and launch it. */
const USE_WORKGROUP: Tour = {
  id: 'use-workgroup',
  steps: [
    {
      anchor: '[data-tour="nav-/workgroups"]',
      route: '/',
      advanceOnRoute: '/workgroups',
      titleKey: 'tour.useWorkgroup.openWorkgroups.title',
      bodyKey: 'tour.useWorkgroup.openWorkgroups.body',
    },
    {
      anchor: '[data-testid="workgroup-new-button"]',
      route: '/workgroups',
      advanceOnRoute: '/workgroups/',
      titleKey: 'tour.useWorkgroup.newWorkgroup.title',
      bodyKey: 'tour.useWorkgroup.newWorkgroup.body',
    },
    {
      anchor: '[data-testid="workgroup-add-agent-member"]',
      route: '/workgroups/',
      titleKey: 'tour.useWorkgroup.addMember.title',
      bodyKey: 'tour.useWorkgroup.addMember.body',
    },
    {
      anchor: '[data-testid="workgroup-launch-button"]',
      route: '/workgroups/',
      titleKey: 'tour.useWorkgroup.launch.title',
      bodyKey: 'tour.useWorkgroup.launch.body',
    },
  ],
}

const TOURS: Record<TourId, Tour> = {
  'first-task': FIRST_TASK,
  'build-workflow': BUILD_WORKFLOW,
  'use-workgroup': USE_WORKGROUP,
}

export function getTour(id: TourId): Tour {
  return TOURS[id]
}

/**
 * Runtime guard for ids that arrive from OUTSIDE the type system — persisted
 * localStorage state survives renames/deletions of tours across upgrades, so
 * the restore path must domain-check before indexing TOURS (impl-gate P1-2:
 * an unknown id used to crash the whole app on every load until the key was
 * hand-deleted).
 */
export function isTourId(id: string): id is TourId {
  return Object.prototype.hasOwnProperty.call(TOURS, id)
}

export const ALL_TOUR_IDS: readonly TourId[] = Object.keys(TOURS) as TourId[]
