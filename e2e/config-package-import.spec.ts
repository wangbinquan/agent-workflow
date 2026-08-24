// RFC-319 B27 —— RES-39：配置包导入（预览 → 逐项决策 → 提交）。
//
// 这条链路此前**整条零 e2e**：`POST /api/resource-packages/preview`、
// `/commit` 与七个 `:id/export-package` 端点，一条都没有被任何 e2e 打到过。
// 而它是本产品里**唯一一条会一次性写入多个资源**的用户动作，判错的形态很重：
//
//   * 预览要是顺手写了库，用户只是「看一眼这个包里有什么」就已经改了本机资源；
//   * 逐项决策要是没逐项生效，选了「新建」却覆盖掉同名的既有资源——那是别人
//     正在用的东西，而界面上什么都不会说；
//   * 依赖要是没跟着改接线，新建出来的代理会指向**旧**技能：它看着建成功了，
//     一旦有人改旧技能，新代理跟着变，而没有任何地方记录过这层关系。
//
// 因此判据分三段，每段都从服务端读回来核对，不看界面上的提示语：
//   ① 预览之后、提交之前，本机资源集合**逐字不变**（干跑）；
//   ② 两项都选「新建」⇒ 新建两份，且新代理指向**新**技能（依赖重新接线）；
//   ③ 代理选「新建」、技能选「复用既有」⇒ 只新建代理，且它指向**既有**技能。
//
// ②③ 用的是同一个包、同一个界面，只有那一格选择不同——这正是「逐项决策」
// 这件事本身的判据：换一格选择，落库结果必须跟着换。
//
// 判据取自源码单一事实源：
//   routes/resourcePackages.ts:321-337   preview 明写 no writes
//   routes/resourcePackages.ts:343-410   commit 逐条重算 allowedActions
//   components/ResourcePackageImportDialog.tsx:1120-1210  逐项 Segmented + 目标选择

import { expect, test, type Page } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { startDaemon, type DaemonHandle } from './harness'

test.describe.configure({ mode: 'serial' })
test.setTimeout(180_000)

let daemon: DaemonHandle
let workDir: string
let sourceSkillId: string
let sourceAgentId: string
let packagePath: string
let sequence = 0

const SKILL_NAME = 'rfc319-res39-skill'
const AGENT_NAME = 'rfc319-res39-agent'

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${daemon.baseUrl}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${daemon.token}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })
  const body = await res.text()
  expect(res.ok, `${path}: ${res.status} ${body}`).toBe(true)
  return JSON.parse(body) as T
}

interface AgentRow {
  id: string
  name: string
  skills: Array<{ kind: string; skillId?: string; name?: string }>
}

const listAgents = (): Promise<AgentRow[]> => api<AgentRow[]>('/api/agents')
const listSkills = (): Promise<Array<{ id: string; name: string }>> =>
  api<Array<{ id: string; name: string }>>('/api/skills')

test.beforeAll(async () => {
  daemon = await startDaemon()
  workDir = mkdtempSync(join(tmpdir(), 'rfc319-res39-'))

  sourceSkillId = (
    await api<{ id: string }>('/api/skills', {
      method: 'POST',
      body: JSON.stringify({
        name: SKILL_NAME,
        description: 'RFC-319 RES-39 fixture skill',
        bodyMd: '# fixture\n',
      }),
    })
  ).id
  sourceAgentId = (
    await api<{ id: string }>('/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: AGENT_NAME,
        description: 'RFC-319 RES-39 fixture agent',
        outputs: ['answer'],
        outputKinds: { answer: 'markdown' },
        readonly: true,
        bodyMd: '# fixture agent\n',
        skills: [{ kind: 'managed', skillId: sourceSkillId }],
      }),
    })
  ).id

  const exported = await fetch(
    `${daemon.baseUrl}/api/agents/${encodeURIComponent(sourceAgentId)}/export-package`,
    { headers: { Authorization: `Bearer ${daemon.token}` } },
  )
  expect(exported.status, 'export-package 必须回一个包').toBe(200)
  packagePath = join(workDir, 'rfc319-res39.zip')
  writeFileSync(packagePath, Buffer.from(await exported.arrayBuffer()))
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

async function openImportTab(page: Page): Promise<void> {
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
  await page.goto(`${daemon.baseUrl}/agents/new`)
  await page.getByTestId('agents-create-package-tab').click()
  await page.getByTestId('package-import-file').setInputFiles(packagePath)
  await page.getByTestId('package-import-preview').click()
  await expect(page.getByTestId('package-import-commit')).toBeVisible()
}

/** 预览渲染出来的每条目：从 Segmented 选项的 testid 反推 localSlug。 */
async function previewSlugs(page: Page): Promise<string[]> {
  const ids = await page
    .locator('[data-testid^="package-action-"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid') ?? ''))
  const slugs = new Set<string>()
  for (const id of ids) {
    const withoutPrefix = id.slice('package-action-'.length)
    const cut = withoutPrefix.lastIndexOf('-')
    if (cut > 0) slugs.add(withoutPrefix.slice(0, cut))
  }
  return [...slugs].sort()
}

function slugOf(slugs: string[], kind: 'agent' | 'skill'): string {
  const found = slugs.find((slug) => slug.includes(kind))
  expect(found, `预览里没有 ${kind} 这一条（实测 slug: ${slugs.join(', ')}）`).toBeTruthy()
  return found as string
}

test('预览是干跑：只问不写，连一次提交请求都不许发出去', async ({ page }) => {
  const agentsBefore = (await listAgents()).map((row) => row.name).sort()
  const skillsBefore = (await listSkills()).map((row) => row.name).sort()

  // 两层判据。**动作层**（下面这个记录器）比效果层更早、更严：提交请求哪怕被
  // 服务端以任何理由回绝，「预览这一步问过服务端能不能写」本身就已经是缺陷——
  // 只断言「资源没变」的话，一次发出去但恰好失败的提交会被记成通过。
  const packageRequests: string[] = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/resource-packages/')) {
      packageRequests.push(`${request.method()} ${url.pathname}`)
    }
  })

  await openImportTab(page)
  const slugs = await previewSlugs(page)
  expect(slugs.length, '一个引用了技能的代理，包里应当有代理与技能两条').toBe(2)

  expect(packageRequests, '预览这一步只该问 preview 一个端点').toEqual([
    'POST /api/resource-packages/preview',
  ])
  expect(
    (await listAgents()).map((row) => row.name).sort(),
    '「看一眼这个包里有什么」不该改变本机的任何东西',
  ).toEqual(agentsBefore)
  expect((await listSkills()).map((row) => row.name).sort()).toEqual(skillsBefore)
})

test('两项都选「新建」：新建两份，且新代理指向新技能而不是原来那个', async ({ page }) => {
  const run = ++sequence
  const agentName = `rfc319-res39-new-agent-${run}`
  const skillName = `rfc319-res39-new-skill-${run}`

  await openImportTab(page)
  const slugs = await previewSlugs(page)
  const agentSlug = slugOf(slugs, 'agent')
  const skillSlug = slugOf(slugs, 'skill')

  await page.getByTestId(`package-action-${agentSlug}-new`).click()
  await page.getByTestId(`package-name-${agentSlug}`).fill(agentName)
  await page.getByTestId(`package-action-${skillSlug}-new`).click()
  await page.getByTestId(`package-name-${skillSlug}`).fill(skillName)

  await page.getByTestId('package-import-commit').click()
  await expect(page.getByTestId('package-import-report')).toBeVisible()

  const skills = await listSkills()
  const createdSkill = skills.find((row) => row.name === skillName)
  expect(createdSkill, '选了「新建」却没有新建技能').toBeTruthy()
  expect(
    skills.find((row) => row.name === SKILL_NAME)?.id,
    '选「新建」不许动同名的既有资源——那是别人正在用的东西',
  ).toBe(sourceSkillId)

  const agents = await listAgents()
  const createdAgent = agents.find((row) => row.name === agentName)
  expect(createdAgent, '选了「新建」却没有新建代理').toBeTruthy()
  expect(agents.find((row) => row.name === AGENT_NAME)?.id).toBe(sourceAgentId)
  expect(
    createdAgent?.skills,
    '新代理必须指向**新**技能：指回旧技能的话，日后有人改旧技能新代理会跟着变，' +
      '而这层关系没有任何地方记录过',
  ).toEqual([{ kind: 'managed', skillId: createdSkill?.id }])
})

test('技能改选「复用既有」：只新建代理，它指向的是本机原来那个技能', async ({ page }) => {
  const run = ++sequence
  const agentName = `rfc319-res39-reuse-agent-${run}`
  const skillsBefore = (await listSkills()).map((row) => row.id).sort()

  await openImportTab(page)
  const slugs = await previewSlugs(page)
  const agentSlug = slugOf(slugs, 'agent')
  const skillSlug = slugOf(slugs, 'skill')

  await page.getByTestId(`package-action-${agentSlug}-new`).click()
  await page.getByTestId(`package-name-${agentSlug}`).fill(agentName)
  await page.getByTestId(`package-action-${skillSlug}-reuse`).click()

  await page.getByTestId('package-import-commit').click()
  await expect(page.getByTestId('package-import-report')).toBeVisible()

  expect(
    (await listSkills()).map((row) => row.id).sort(),
    '选了「复用既有」还是建了一份新的 ⇒ 逐项决策没有逐项生效',
  ).toEqual(skillsBefore)

  const createdAgent = (await listAgents()).find((row) => row.name === agentName)
  expect(createdAgent).toBeTruthy()
  expect(createdAgent?.skills).toEqual([{ kind: 'managed', skillId: sourceSkillId }])
})
