// RFC-307 — identifying the sample content the platform seeds on first start.
//
// This exists because the demo turned out to be visible somewhere it should not
// be, and the fix needs BOTH sides to agree on what "a sample" is. A fresh
// install seeds one agent and two workflows so that `/code` has something to
// open; the home page's first-run check reads "no agents and no workflows" and
// therefore decided every new install had already been set up, and the
// onboarding screen — the platform's entire first impression — stopped
// appearing. Caught by `e2e/a11y.spec.ts` ("on a clean daemon / renders the
// first-run Onboarding"), which is the only place that assertion lived.
//
// "First run" means THE USER HAS CREATED NOTHING. Rows the platform put there
// itself do not count, and a shared prefix is what lets the seeder and the
// check say that the same way.
//
// The prefix is also deliberately readable: someone who wants every trace of
// the demo gone can grep for it.

export const DEMO_RESOURCE_ID_PREFIX = 'aw-demo-'

/**
 * True for a row the platform seeded as sample content, not one a user made.
 *
 * Anything unrecognisable answers FALSE — "this is the user's". That direction
 * is the safe one: mistaking a user's row for a sample would hide their real
 * setup behind a first-run screen, while mistaking a sample for a user row only
 * costs them the onboarding they can reach from the menu anyway. The parameter
 * is typed `unknown` rather than `string` because the caller reads it off wire
 * data, and a missing field must not throw inside a render.
 */
export function isDemoResourceId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith(DEMO_RESOURCE_ID_PREFIX)
}
