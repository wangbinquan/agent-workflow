// RFC-190 — the capability-portal homepage rendered at `/` for non-first-run
// environments (was RFC-032's three-section task dashboard).
//
// Layout:
//   - Hero (HomepageGreeting): greeting + runtime status + task pulse +
//     CTAs on the left, the animated PipelineHero mini-canvas on the right.
//   - CapabilityGrid: six capability tiles with live per-actor counts
//     (/api/overview) — the platform's capability map.
//   - TaskFeed: the three former task sections merged into one card
//     (all RFC-032 testids/order/inbox-button contracts preserved).

import { CapabilityGrid } from './CapabilityGrid'
import { HomepageGreeting } from './HomepageGreeting'
import { TaskFeed } from './TaskFeed'

export function Homepage() {
  return (
    <div className="page homepage" data-testid="homepage">
      <HomepageGreeting />
      <CapabilityGrid />
      <TaskFeed />
    </div>
  )
}
