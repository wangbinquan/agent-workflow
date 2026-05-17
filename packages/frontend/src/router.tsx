// Code-based TanStack Router tree. M1 keeps it small — file-based routing
// is overkill until the workflow editor (M2) adds nested layouts.

import { createRouter } from '@tanstack/react-router'
import { Route as agentsRoute } from '@/routes/agents'
import { Route as agentDetailRoute } from '@/routes/agents.detail'
import { Route as agentNewRoute } from '@/routes/agents.new'
import { Route as authRoute } from '@/routes/auth'
import { Route as indexRoute } from '@/routes/index'
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
import { Route as taskDetailRoute } from '@/routes/tasks.detail'
import { Route as reviewsRoute } from '@/routes/reviews'
import { Route as reviewDetailRoute } from '@/routes/reviews.detail'
import { Route as clarifyRoute } from '@/routes/clarify'
import { Route as clarifyDetailRoute } from '@/routes/clarify.detail'
import { Route as workflowsRoute } from '@/routes/workflows'
import {
  EditRoute as workflowEditRoute,
  NewRoute as workflowNewRoute,
} from '@/routes/workflows.edit'
import { LaunchRoute as workflowLaunchRoute } from '@/routes/workflows.launch'
import { ReposRoute as reposRoute } from '@/routes/repos'

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
  workflowNewRoute,
  workflowLaunchRoute,
  workflowEditRoute,
  workflowsRoute,
  taskDetailRoute,
  tasksRoute,
  // '/reviews/$nodeRunId' must come before '/reviews' so the literal wins.
  reviewDetailRoute,
  reviewsRoute,
  // RFC-023: same rule — `$nodeRunId` literal needs to win over the index.
  clarifyDetailRoute,
  clarifyRoute,
  reposRoute,
  settingsRoute,
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
