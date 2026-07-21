// RFC-211 §12 — the onboarding tour launches a task in a prefilled, ready-to-
// submit state so it can walk build → run → result without the user typing.
//
// The launch entry deep-links `/tasks/new?...&tour=first-task`; the wizard then
// forces a scratch space (no repo), seeds a sample name + prompt, and opens on
// its Confirm step so the spotlight lands on a real, ENABLED launch button.
//
// This locks the two ends that a full render test can't cheaply cover: the wire
// param survives validateSearch (only the exact literal), and the route source
// actually wires `fromTour` into the space / step / prefill initializers (a
// source assertion — the giant wizard component is impractical to mount here).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { TaskWizardRoute } from '../src/routes/tasks.new'

describe('RFC-211 task wizard tour param', () => {
  const validate = TaskWizardRoute.options.validateSearch as (
    raw: Record<string, unknown>,
  ) => Record<string, unknown>

  test('the exact tour literal is accepted and carried through', () => {
    const out = validate({ kind: 'agent', agent: 'my-coder', tour: 'first-task' })
    expect(out).toMatchObject({ kind: 'agent', agent: 'my-coder', tour: 'first-task' })
  })

  test('any other tour value is dropped (only first-task is a real mode)', () => {
    expect(validate({ tour: 'bogus' }).tour).toBeUndefined()
    expect(validate({ tour: true }).tour).toBeUndefined()
    expect(validate({}).tour).toBeUndefined()
  })
})

describe('RFC-211 task wizard tour seeding is wired into the source', () => {
  const src = readFileSync(resolve(__dirname, '..', 'src', 'routes', 'tasks.new.tsx'), 'utf8')

  test('fromTour derives from the search flag and is not an edit/relaunch', () => {
    expect(src).toContain("search.tour === 'first-task' && !isEdit && !isRelaunch")
  })

  test('fromTour forces a scratch space, seeds name + prompt, and opens on Confirm', () => {
    // Scratch (no repo) so a zero-repo fresh install can submit.
    expect(src).toContain("defaultWizardSpace(fromTour ? 'scratch'")
    // Sample name + prompt come from the tour i18n bundle.
    expect(src).toContain("fromTour ? t('tour.firstTask.seedTaskName') : ''")
    expect(src).toContain("fromTour ? t('tour.firstTask.seedTaskPrompt') : ''")
    // Start on Confirm so the launch button (data-tour="task-submit") is present.
    expect(src).toContain('fromTour ? STEP_CONFIRM :')
  })
})
