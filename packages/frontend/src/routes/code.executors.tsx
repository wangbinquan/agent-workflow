import { createRoute, redirect } from '@tanstack/react-router'

import { Route as RootRoute } from './__root'

/** RFC-323: the hidden executor inventory has no UI; old bookmarks land at the owner surface. */
export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/code/executors',
  beforeLoad: () => {
    throw redirect({ to: '/digital-employees' })
  },
})
