// Code-based TanStack Router tree. M1 keeps it small — file-based routing
// is overkill until the workflow editor (M2) adds nested layouts.

import { createRoute, createRouter, redirect } from '@tanstack/react-router'
import { Route as accountRoute } from '@/routes/account'
import { IndexRoute as agentsIndexRoute, Route as agentsRoute } from '@/routes/agents'
import { Route as agentDetailRoute } from '@/routes/agents.detail'
import { Route as agentByIdRoute } from '@/routes/agents.by-id'
import { Route as agentNewRoute } from '@/routes/agents.new'
import { Route as authRoute } from '@/routes/auth'
import { Route as indexRoute } from '@/routes/index'
import { Route as usersRoute } from '@/routes/users'
import { Route as rootRoute } from '@/routes/__root'
import { Route as settingsRoute } from '@/routes/settings'
import { IndexRoute as mcpsIndexRoute, Route as mcpsRoute } from '@/routes/mcps'
import { Route as mcpDetailRoute } from '@/routes/mcps.detail'
import { Route as mcpNewRoute } from '@/routes/mcps.new'
import { IndexRoute as pluginsIndexRoute, Route as pluginsRoute } from '@/routes/plugins'
import { Route as pluginDetailRoute } from '@/routes/plugins.detail'
import { Route as pluginNewRoute } from '@/routes/plugins.new'
import { IndexRoute as skillsIndexRoute, Route as skillsRoute } from '@/routes/skills'
import { Route as skillDetailRoute } from '@/routes/skills.detail'
import { Route as skillNewRoute } from '@/routes/skills.new'
import { Route as tasksRoute } from '@/routes/tasks'
import { TaskWizardRoute as taskWizardRoute } from '@/routes/tasks.new'
import { Route as scheduledRoute } from '@/routes/scheduled'
import { Route as scheduledDetailRoute } from '@/routes/scheduled.$id'
import { Route as taskDetailRoute } from '@/routes/tasks.detail'
import { Route as taskPreviewRoute } from '@/routes/tasks.preview'
import { Route as reviewsRoute } from '@/routes/reviews'
import { Route as reviewDetailRoute } from '@/routes/reviews.detail'
import { Route as clarifyRoute } from '@/routes/clarify'
import { Route as clarifyDetailRoute } from '@/routes/clarify.detail'
import {
  NewRedirectRoute as workflowNewRedirectRoute,
  Route as workflowsRoute,
} from '@/routes/workflows'
import { Route as workgroupsRoute } from '@/routes/workgroups'
import { Route as workgroupDetailRoute } from '@/routes/workgroups.detail'
import { Route as workgroupByIdRoute } from '@/routes/workgroups.by-id'
import { EditRoute as workflowEditRoute } from '@/routes/workflows.edit'
import { ReposRoute as reposRoute } from '@/routes/repos'
import { Route as memoryRoute } from '@/routes/memory'
import { Route as memoryDistillJobDetailRoute } from '@/routes/memory.distill-jobs.$jobId'
import { Route as fusionDetailRoute } from '@/routes/fusions.detail'
import { workflowLaunchWizardSearch } from '@/lib/workflow-launch-handoff'

// RFC-165 (T14): both legacy launcher pages are retired — their URLs redirect
// into the /tasks/new wizard with the object pre-picked (deep links land on
// Step 2; `?editScheduled` carries through so old bookmarks keep working).
const workflowLaunchRedirect = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workflows/$id/launch',
  beforeLoad: ({ params, search }) => {
    const launchSearch = search as { editScheduled?: string; version?: unknown }
    throw redirect({
      to: '/tasks/new',
      search: workflowLaunchWizardSearch(params.id, launchSearch),
    })
  },
})

const workgroupLaunchRedirect = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workgroups/launch',
  beforeLoad: ({ search }) => {
    const name = (search as { name?: string }).name
    throw redirect({
      to: '/tasks/new',
      search: name !== undefined && name !== '' ? { kind: 'workgroup', workgroup: name } : {},
    })
  },
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  authRoute,
  // RFC-177: /agents/by-id/$id — id→name resolver + redirect (root child, so it
  // bypasses the split layout). Two-segment path is arity-distinct from
  // /agents/$name, so a "by-id"-named agent still resolves normally.
  agentByIdRoute,
  // RFC-169: /agents is now a split (master-detail) layout route; new / detail /
  // index are its children. '/agents/new' literal still precedes '/agents/$name'
  // (belt-and-suspenders — TanStack scores the literal higher anyway).
  agentsRoute.addChildren([agentNewRoute, agentDetailRoute, agentsIndexRoute]),
  // RFC-169: /skills split (master-detail) layout route with nested children.
  skillsRoute.addChildren([skillNewRoute, skillDetailRoute, skillsIndexRoute]),
  // RFC-169: /mcps split (master-detail) layout route with nested children.
  mcpsRoute.addChildren([mcpNewRoute, mcpDetailRoute, mcpsIndexRoute]),
  // RFC-169: /plugins split (master-detail) layout route with nested children.
  pluginsRoute.addChildren([pluginNewRoute, pluginDetailRoute, pluginsIndexRoute]),
  // Workflow creation is a quick-create dialog on the list page; the retired
  // '/workflows/new' literal only redirects there, and must precede
  // '/workflows/$id' so "new" never resolves as a workflow id.
  workflowNewRedirectRoute,
  workflowLaunchRedirect,
  workflowEditRoute,
  workflowsRoute,
  // RFC-164: creation is a list-page dialog — list + detail + launch routes.
  // '/workgroups/launch' literal must precede '/workgroups/$name' so "launch"
  // never resolves as a workgroup name.
  workgroupLaunchRedirect,
  // RFC-177: /workgroups/by-id/$id — id→name resolver + redirect (arity-distinct
  // from /workgroups/$name).
  workgroupByIdRoute,
  workgroupDetailRoute,
  workgroupsRoute,
  // RFC-105: '/tasks/$id/preview' (longer literal) before '/tasks/$id'.
  taskPreviewRoute,
  taskDetailRoute,
  tasksRoute,
  taskWizardRoute,
  // RFC-159: '/scheduled/$id' literal must precede '/scheduled'.
  scheduledDetailRoute,
  scheduledRoute,
  // '/reviews/$nodeRunId' must come before '/reviews' so the literal wins.
  reviewDetailRoute,
  reviewsRoute,
  // RFC-023: same rule — `$nodeRunId` literal needs to win over the index.
  clarifyDetailRoute,
  clarifyRoute,
  reposRoute,
  // RFC-043: admin distill job detail. Must come BEFORE /memory so the
  // longer literal segment wins the match.
  memoryDistillJobDetailRoute,
  // RFC-041 PR4: platform memory tab.
  memoryRoute,
  // RFC-101: memory→skill fusion detail + approval gate.
  fusionDetailRoute,
  settingsRoute,
  // RFC-036
  accountRoute,
  usersRoute,
])

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  scrollRestoration: true,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
