// Code-based TanStack Router tree. M1 keeps it small — file-based routing
// is overkill until the workflow editor (M2) adds nested layouts.

import { createRoute, createRouter, redirect } from '@tanstack/react-router'
import { Route as accountRoute } from '@/routes/account'
import { Route as agentsRoute } from '@/routes/agents'
import { Route as agentDetailRoute } from '@/routes/agents.detail'
import { Route as agentNewRoute } from '@/routes/agents.new'
import { Route as authRoute } from '@/routes/auth'
import { Route as indexRoute } from '@/routes/index'
import { Route as usersRoute } from '@/routes/users'
import { Route as rootRoute } from '@/routes/__root'
import { Route as settingsRoute } from '@/routes/settings'
import { Route as mcpsRoute } from '@/routes/mcps'
import { Route as mcpDetailRoute } from '@/routes/mcps.detail'
import { Route as mcpNewRoute } from '@/routes/mcps.new'
import { Route as pluginsRoute } from '@/routes/plugins'
import { Route as pluginDetailRoute } from '@/routes/plugins.detail'
import { Route as pluginNewRoute } from '@/routes/plugins.new'
import { Route as skillsRoute } from '@/routes/skills'
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
import { EditRoute as workflowEditRoute } from '@/routes/workflows.edit'
import { ReposRoute as reposRoute } from '@/routes/repos'
import { Route as memoryRoute } from '@/routes/memory'
import { Route as memoryDistillJobDetailRoute } from '@/routes/memory.distill-jobs.$jobId'
import { Route as fusionDetailRoute } from '@/routes/fusions.detail'

// RFC-165 (T14): both legacy launcher pages are retired — their URLs redirect
// into the /tasks/new wizard with the object pre-picked (deep links land on
// Step 2; `?editScheduled` carries through so old bookmarks keep working).
const workflowLaunchRedirect = createRoute({
  getParentRoute: () => rootRoute,
  path: '/workflows/$id/launch',
  beforeLoad: ({ params, search }) => {
    const editScheduled = (search as { editScheduled?: string }).editScheduled
    throw redirect({
      to: '/tasks/new',
      search:
        editScheduled !== undefined ? { editScheduled } : { kind: 'workflow', workflow: params.id },
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
  // '/agents/new' must come before '/agents/$name' so the literal wins.
  agentNewRoute,
  agentDetailRoute,
  agentsRoute,
  skillNewRoute,
  skillDetailRoute,
  skillsRoute,
  // '/mcps/new' literal must precede '/mcps/$name' so the literal wins.
  mcpNewRoute,
  mcpDetailRoute,
  mcpsRoute,
  // RFC-031: '/plugins/new' literal must precede '/plugins/$id' so the literal wins.
  pluginNewRoute,
  pluginDetailRoute,
  pluginsRoute,
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
