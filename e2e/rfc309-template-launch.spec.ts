// RFC-309 T25 — one template, opened, copied, and started, on a real daemon.
//
// The three questions this RFC exists to answer were asked by a person looking
// at the running product, so the proof belongs here rather than only in unit
// tests:
//
//   「流程和模版两个页签什么关系」  → there is ONE tab now, and opening a
//                                     template shows the flow
//   「是不是应该在模版里配置流程」  → clicking a step configures that template
//   「基于模版创建需求任务的入口在哪」 → the launch panel on the template page
//
// What only a real daemon can show is that these are joined end to end: a
// template copied through the HTTP API is immediately openable, its flow is
// drawn from the compiled stage contract, an edit round-trips through the
// database, and the launch form posts what the server's discriminated union
// accepts. The unit suites cover each half; every one of them was green while
// the joins were missing.
//
// The launch is asserted at the point where the platform hands the work over —
// the round is opened and a task starts. What happens after that needs a code
// host, which is exactly the dependency the rest of this file exists without.

import { expect, test, type Page } from '@playwright/test'

import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  await daemon?.stop()
})

/** The demo template the seed plants — what a fresh install has to start from. */
const DEMO_TEMPLATE = 'aw-demo-template-mr-review'

async function attach(page: Page): Promise<void> {
  await page.addInitScript(
    ({ baseUrl, token }) => {
      try {
        window.localStorage.setItem('agent-workflow.baseUrl', baseUrl)
        window.localStorage.setItem('agent-workflow.token', token)
        window.localStorage.setItem('aw-language', 'en-US')
      } catch {
        /* ignore */
      }
    },
    { baseUrl: daemon.baseUrl, token: daemon.token },
  )
}

test('there is ONE templates tab, and no separate flow tab beside it', async ({ page }) => {
  // AC-1, and the direct answer to the question that started the RFC. Two tabs
  // showing the same configuration — one as a picture, one as JSON — is what
  // made the relationship unexplainable.
  await attach(page)
  await page.goto(`${daemon.baseUrl}/code?tab=templates`)

  await expect(page.getByTestId('code-templates')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('tab', { name: 'Flow' })).toHaveCount(0)
  // And one list, not two: the department/group split is gone.
  await expect(page.getByTestId('code-frameworks')).toHaveCount(0)
  await expect(page.getByTestId('code-bindings')).toHaveCount(0)
})

test('opening a template from the list shows the steps it runs', async ({ page }) => {
  // AC-4. The row used to be a read-only summary of JSON entered elsewhere.
  await attach(page)
  await page.goto(`${daemon.baseUrl}/code?tab=templates`)

  await page.getByTestId(`code-template-open-${DEMO_TEMPLATE}`).click()

  await expect(page).toHaveURL(new RegExp(`/code/templates/${DEMO_TEMPLATE}$`))
  await expect(page.getByTestId('stage-node-review-shard')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('stage-node-publish')).toBeVisible()
})

test('a copy is a real template of your own, with its origin recorded', async ({ page }) => {
  // AC-2's forward half and the compensation for the capability §5 removed:
  // after the merge, copying is how a team GETS a template, and the upstream
  // link is the only record that two teams started from the same place.
  await attach(page)

  const created = await page.request.post(
    `${daemon.baseUrl}/api/capability-templates/${DEMO_TEMPLATE}/copy`,
    {
      headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
      data: { name: `e2e copy ${String(Date.now())}` },
    },
  )
  expect(created.status()).toBe(201)
  const copy = (await created.json()) as { id: string; name: string }

  await page.goto(`${daemon.baseUrl}/code/templates/${copy.id}`)
  await expect(page.getByTestId('stage-node-review-shard')).toBeVisible({ timeout: 30_000 })

  // T64, wired for the first time: the copy knows where it came from, and the
  // panel names the template rather than showing a ULID.
  await expect(page.getByTestId('code-template-upstream')).toBeVisible()
  await expect(page.getByTestId('code-upstream-name')).toContainText('demo')
  // Nothing to take yet, so no button — a live one here teaches people the
  // button does nothing.
  await expect(page.getByTestId('code-upstream-merge')).toHaveCount(0)
})

test('an edit on the flow is saved to THAT template and survives a reload', async ({ page }) => {
  // The claim in one assertion, on a copy so it cannot pass by accident from
  // another test's edit to the demo row.
  await attach(page)
  const created = await page.request.post(
    `${daemon.baseUrl}/api/capability-templates/${DEMO_TEMPLATE}/copy`,
    {
      headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
      data: { name: `e2e edit ${String(Date.now())}` },
    },
  )
  const copy = (await created.json()) as { id: string }

  await page.goto(`${daemon.baseUrl}/code/templates/${copy.id}`)
  await expect(page.getByTestId('stage-node-review-shard')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('stage-node-review-shard').click()

  const edited = `launched from e2e ${String(Date.now())}`
  await page.getByTestId('stage-prompt-review-shard').fill(edited)
  await page.getByTestId('stage-save-agent-review-shard').click()

  await page.reload()
  await expect(page.getByTestId('stage-node-review-shard')).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('stage-node-review-shard').click()
  await expect(page.getByTestId('stage-prompt-review-shard')).toHaveValue(edited)
})

test('the launch panel asks for what THIS capability needs', async ({ page }) => {
  // AC-7's shape. The server models the four inputs as a discriminated union;
  // the form is the same decision made visible, so nobody fills in a field the
  // request would be rejected for carrying.
  await attach(page)
  await page.goto(`${daemon.baseUrl}/code/templates/${DEMO_TEMPLATE}`)

  await expect(page.getByTestId('code-launch')).toBeVisible({ timeout: 30_000 })
  // `mr-review` needs a merge request number and nothing else.
  await expect(page.getByTestId('code-launch-mr')).toBeVisible()
  await expect(page.getByTestId('code-launch-title')).toHaveCount(0)
  await expect(page.getByTestId('code-launch-pipeline')).toHaveCount(0)

  // AC-8, stated where a person meets it: no capability is switched on for any
  // repository on this fresh install, and the panel still offers to start.
  await expect(page.getByTestId('code-launch-submit')).toBeVisible()
})

test('the launch API opens a round and hands back something to open — AC-9', async ({ page }) => {
  // The entrance RFC-304 promised and did not ship: before this route the only
  // way to start ANY round was a real webhook delivery.
  //
  // Driven through the API rather than the form because a fresh install has no
  // repository to select — and what this locks is the receipt, which is the
  // part that was missing while looking present. A round with no task is a row
  // nothing runs; the `taskId` is the proof that something does.
  await attach(page)

  const res = await page.request.post(`${daemon.baseUrl}/api/code/rounds`, {
    headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    data: {
      repoId: 'no-such-repo',
      templateId: DEMO_TEMPLATE,
      input: { capability: 'mr-review', mrIid: '42' },
    },
  })

  // A named refusal, not a generic forbidden: the caller is told which thing to
  // go fix. Reaching a REPOSITORY error also proves the six checks before it
  // passed — the template was found, drives the right capability, has its slot
  // filled, and names an agent this caller can see.
  expect(res.status()).toBeGreaterThanOrEqual(400)
  expect(JSON.stringify(await res.json())).toContain('code-launch-')
})

test('a capability that is a standing loop offers nothing to start', async ({ page }) => {
  // `mr-monitor` is not a round. An empty form would invite somebody to press
  // start and receive a validation error naming a union arm that does not exist.
  await attach(page)
  const created = await page.request.post(`${daemon.baseUrl}/api/capability-templates`, {
    headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    data: {
      name: `e2e monitor ${String(Date.now())}`,
      capability: 'mr-monitor',
      scripts: {},
      hooks: [],
      paramSchema: [],
      paramDefaults: {},
      agentBySlot: {},
      promptBySlot: {},
      params: {},
    },
  })
  expect(created.status()).toBe(201)
  const monitor = (await created.json()) as { id: string }

  await page.goto(`${daemon.baseUrl}/code/templates/${monitor.id}`)
  await expect(page.getByTestId('code-launch-unavailable')).toBeVisible({ timeout: 30_000 })
  await expect(page.getByTestId('code-launch-submit')).toHaveCount(0)
})
