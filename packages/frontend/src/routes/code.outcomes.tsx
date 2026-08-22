// RFC-310 T212 — runtime outcomes live on digital-employee cards.
// Keep both historical URLs as redirects so bookmarks do not become 404s.

import { createRoute, redirect } from '@tanstack/react-router'

import { Route as RootRoute } from './__root'

export function validateOutcomesSearch(_search: Record<string, unknown>): Record<string, never> {
  return {}
}

const redirectToEmployees = () => {
  throw redirect({ to: '/digital-employees' })
}

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/outcomes',
  validateSearch: validateOutcomesSearch,
  beforeLoad: redirectToEmployees,
})

export const LegacyRoute = createRoute({
  getParentRoute: () => RootRoute,
  path: '/code/outcomes',
  beforeLoad: redirectToEmployees,
})
