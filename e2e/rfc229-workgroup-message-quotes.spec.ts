// RFC-229 — workgroup message-turn replies preserve and render their trigger.
//
// Backend integration tests own trigger resolution and persistence. This real
// daemon/browser seam proves the room consumes that pointer as a familiar,
// one-level quote: it previews the parent, jumps back to it with focus +
// transient highlight, and remains contained on a narrow viewport.

import { join } from 'node:path'
import AxeBuilder from '@axe-core/playwright'
import { expect, test, type Page } from '@playwright/test'

import { runSqlite } from './command'
import { startDaemon, type DaemonHandle } from './harness'

let daemon: DaemonHandle
let taskId = ''
let parentMessageId = ''
let childMessageId = ''

const PARENT_BODY =
  'Please inspect the authentication boundary and report the smallest safe change before editing.'
const CHILD_BODY = 'Authentication boundary reviewed; the scoped guard is now covered by tests.'

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${daemon.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`RFC-229 fixture ${path} failed (${response.status}): ${await response.text()}`)
  }
  return response.json() as Promise<T>
}

async function primeAuth(page: Page): Promise<void> {
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

async function setDaemonTheme(theme: 'light' | 'dark'): Promise<void> {
  const response = await fetch(`${daemon.baseUrl}/api/config`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ theme }),
  })
  expect(response.ok).toBe(true)
}

async function expectQuoteAxeClean(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .include(`[data-testid="wg-msg-${childMessageId}"]`)
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze()
  const blocking = result.violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious',
  )
  expect(
    blocking.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    })),
    'RFC-229 quote axe violations',
  ).toEqual([])
}

async function waitForTaskToSettle(): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const response = await fetch(`${daemon.baseUrl}/api/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
    })
    if (response.ok) {
      const task = (await response.json()) as { status: string }
      if (
        ['done', 'failed', 'canceled', 'interrupted', 'awaiting_review', 'awaiting_human'].includes(
          task.status,
        )
      ) {
        return
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('RFC-229 fixture task did not settle in 30s')
}

test.beforeAll(async () => {
  daemon = await startDaemon()
  const leadAgent = await postJson<{ id: string }>('/api/agents', {
    name: 'rfc229-browser-lead',
    description: 'RFC-229 browser fixture leader',
    outputs: ['answer'],
    outputKinds: { answer: 'markdown' },
    readonly: true,
    bodyMd: '',
  })
  const builderAgent = await postJson<{ id: string }>('/api/agents', {
    name: 'rfc229-browser-builder',
    description: 'RFC-229 browser fixture member',
    outputs: ['answer'],
    outputKinds: { answer: 'markdown' },
    readonly: true,
    bodyMd: '',
  })
  const workgroup = await postJson<{
    id: string
    members: Array<{ id: string; displayName: string }>
  }>('/api/workgroups', {
    name: 'rfc229-browser-workgroup',
    description: 'Message trigger quote browser fixture',
    instructions: '',
    mode: 'leader_worker',
    leaderDisplayName: 'Lead',
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 2,
    completionGate: false,
    clarifyBudget: 0,
    fanOut: false,
    members: [
      {
        memberType: 'agent',
        agentId: leadAgent.id,
        displayName: 'Lead',
        roleDesc: 'Coordinates the task.',
      },
      {
        memberType: 'agent',
        agentId: builderAgent.id,
        displayName: 'Builder',
        roleDesc: 'Implements the task.',
      },
    ],
  })
  const task = await postJson<{ id: string }>(`/api/workgroups/${workgroup.id}/tasks`, {
    name: 'RFC-229 browser task',
    goal: 'Prove trigger message quote navigation.',
    scratch: true,
  })
  taskId = task.id
  await waitForTaskToSettle()

  const lead = workgroup.members.find((member) => member.displayName === 'Lead')
  const builder = workgroup.members.find((member) => member.displayName === 'Builder')
  if (lead === undefined || builder === undefined) {
    throw new Error('RFC-229 fixture workgroup response omitted its members')
  }

  parentMessageId = 'z:rfc229:parent'
  const fillerIds = Array.from(
    { length: 14 },
    (_, index) => `z:rfc229:progress:${String(index + 1).padStart(2, '0')}`,
  )
  childMessageId = 'z:rfc229:reply'
  const now = Date.now()
  const rows = [
    `(${sqlLiteral(parentMessageId)},${sqlLiteral(taskId)},1,'member',${sqlLiteral(lead.id)},NULL,'chat',${sqlLiteral(PARENT_BODY)},'[]',NULL,NULL,${now})`,
    ...fillerIds.map(
      (id, index) =>
        `(${sqlLiteral(id)},${sqlLiteral(taskId)},1,'system',NULL,NULL,'system',${sqlLiteral(`Progress marker ${index + 1}: enough history to exercise quote navigation.`)},'[]',NULL,NULL,${now + index + 1})`,
    ),
    `(${sqlLiteral(childMessageId)},${sqlLiteral(taskId)},1,'member',${sqlLiteral(builder.id)},NULL,'result',${sqlLiteral(CHILD_BODY)},'[]',NULL,${sqlLiteral(parentMessageId)},${now + fillerIds.length + 1})`,
  ]
  runSqlite(
    join(daemon.home, 'db.sqlite'),
    `PRAGMA foreign_keys=ON;
     BEGIN IMMEDIATE;
     INSERT INTO workgroup_messages (
       id, task_id, round, author_kind, author_member_id, author_user_id,
       kind, body_md, mentions_json, assignment_id, trigger_message_id, created_at
     ) VALUES ${rows.join(',')};
     COMMIT;`,
  )
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

test('quote preview jumps to, focuses, and highlights the triggering message', async ({ page }) => {
  await setDaemonTheme('light')
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/tasks/${taskId}?tab=chatroom`)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  const reference = page.getByTestId(`wg-msg-reference-${childMessageId}`)
  await expect(reference).toBeVisible()
  await expect(reference).toContainText('Replying to @Lead')
  await expect(reference).toContainText(PARENT_BODY)

  const parent = page.getByTestId(`wg-msg-${parentMessageId}`)
  const child = page.getByTestId(`wg-msg-${childMessageId}`)
  await expect(child).toBeVisible()
  expect(
    await parent.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return rect.bottom > 0 && rect.top < window.innerHeight
    }),
  ).toBe(false)

  await reference.click()
  await expect(parent).toBeFocused()
  await expect(parent).toHaveClass(/workgroup-room__msg--highlighted/)
  await expect
    .poll(async () => {
      const parentBox = await parent.boundingBox()
      const logBox = await page.getByTestId('workgroup-room-log').boundingBox()
      if (parentBox === null || logBox === null) return Number.POSITIVE_INFINITY
      return Math.abs(parentBox.y + parentBox.height / 2 - (logBox.y + logBox.height / 2))
    })
    .toBeLessThan(180)

  const jumpLatest = page.getByTestId('workgroup-room-jump-latest')
  await jumpLatest.click()
  await expect(jumpLatest).toBeHidden()
  await expect
    .poll(() =>
      child.evaluate((element) => {
        const log = element.parentElement
        if (!(log instanceof HTMLElement)) return false
        const childRect = element.getBoundingClientRect()
        const logRect = log.getBoundingClientRect()
        const viewportTop = logRect.top + log.clientTop
        const viewportBottom = viewportTop + log.clientHeight
        return childRect.top >= viewportTop && childRect.bottom <= viewportBottom
      }),
    )
    .toBe(true)
})

test('quote stays contained at 390px without widening the chat bubble', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await setDaemonTheme('dark')
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/tasks/${taskId}?tab=chatroom`)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')

  const reference = page.getByTestId(`wg-msg-reference-${childMessageId}`)
  const child = page.getByTestId(`wg-msg-${childMessageId}`)
  await expect(reference).toBeVisible()
  const geometry = await reference.evaluate((element) => {
    const parent = element.parentElement
    const rect = element.getBoundingClientRect()
    const parentRect = parent?.getBoundingClientRect()
    const body = element.querySelector<HTMLElement>('.message-reference__body')
    return {
      width: rect.width,
      parentWidth: parentRect?.width ?? 0,
      overflow: element.scrollWidth - element.clientWidth,
      lineClamp: body === null ? '' : getComputedStyle(body).webkitLineClamp,
    }
  })
  expect(geometry.width).toBeLessThanOrEqual(geometry.parentWidth)
  expect(geometry.overflow).toBeLessThanOrEqual(1)
  expect(geometry.lineClamp).toBe('2')
  expect(
    await child.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1)
  await expectQuoteAxeClean(page)
})

test('keyboard jump is immediate when reduced motion is requested', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await setDaemonTheme('light')
  await primeAuth(page)
  await page.goto(`${daemon.baseUrl}/tasks/${taskId}?tab=chatroom`)

  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(
    true,
  )
  const reference = page.getByTestId(`wg-msg-reference-${childMessageId}`)
  const parent = page.getByTestId(`wg-msg-${parentMessageId}`)
  const log = page.getByTestId('workgroup-room-log')
  await reference.focus()
  await page.keyboard.press('Enter')

  await expect(parent).toBeFocused()
  const [parentBox, logBox] = await Promise.all([parent.boundingBox(), log.boundingBox()])
  if (parentBox === null || logBox === null) {
    throw new Error('RFC-229 quote target or room log lost its layout box after keyboard jump')
  }
  const logCenter = logBox.y + logBox.height / 2
  // Font metrics differ across browser hosts, so a fixed pixel epsilon makes
  // this portability check depend on the runner. The UX contract is stronger
  // and layout-relative: the synchronous jump must place the log's center line
  // inside the focused target bubble.
  expect(logCenter).toBeGreaterThanOrEqual(parentBox.y)
  expect(logCenter).toBeLessThanOrEqual(parentBox.y + parentBox.height)
})
