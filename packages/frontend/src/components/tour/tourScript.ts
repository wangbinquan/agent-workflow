// RFC-211 §12 — tour scripts.
//
// A step points at a real element by its `data-tour` name and tells the user
// what to do. It advances one of two ways:
//   - `advanceOnRoute`: the user did the thing and the app moved them (saved an
//     agent → landed on its page). No Next button; the tour follows the action.
//   - otherwise: an explanatory step the user dismisses with Next.
//
// `route` is where the step's anchor lives; if the user isn't there, the bubble
// offers a "go to page" button instead of pointing at nothing.
//
// Anchors are defined ON the real components (search the codebase for the
// matching `data-tour="…"`). Keep this script and those attributes in lockstep
// — tour-anchors.test.tsx fails if a referenced anchor has no home.

export type TourId = 'first-task'

export interface TourStep {
  /** CSS selector for the element to spotlight (a `[data-tour="…"]`). */
  anchor: string
  /** The route this step's anchor lives on (offers a "go here" nudge if away). */
  route?: string
  /** Auto-advance when the user reaches a route starting with this. */
  advanceOnRoute?: string
  titleKey: string
  bodyKey: string
}

export interface Tour {
  id: TourId
  steps: readonly TourStep[]
}

/**
 * The canonical first run: build an agent, wire it into a workflow, launch it,
 * and read the result — the whole Code→(review)→result loop, done by hand on
 * the real screens.
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
      titleKey: 'tour.firstTask.name.title',
      bodyKey: 'tour.firstTask.name.body',
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
      anchor: '[data-tour="task-submit"]',
      route: '/tasks/new',
      advanceOnRoute: '/tasks/',
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

const TOURS: Record<TourId, Tour> = {
  'first-task': FIRST_TASK,
}

export function getTour(id: TourId): Tour {
  return TOURS[id]
}

export const ALL_TOUR_IDS: readonly TourId[] = Object.keys(TOURS) as TourId[]
