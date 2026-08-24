// RFC-319 —— 画布工具条与校验摘要抢同一片区域时，主操作必须在上层（回归锁）。
//
// 事故形态（2026-08-24，由 e2e-full-nightly 的 Linux 腿实测坐标定位）：
//   相机按钮  x=408..516  y=86..114  z-index: auto  （react-flow top-right Panel 内）
//   校验摘要  x=301..479  y=78..110  z-index: 7     （position: absolute）
// 两者水平重叠 408..479、垂直重叠 86..110，`z-index: 7` 的摘要压住了工具条，
// 于是「View full graph」这个主操作**物理上点不到**——点击落在摘要按钮上。
//
// 为什么本机看不到：画布左沿两边都是 253，差异全在右沿——CI 上检查器栏展开、
// 画布只剩约 578px 宽，两个分别锚在左上/右上的浮层就撞到了一起；macOS 那次画布
// 有约 994px，相距 371px。所以这不是字体差，是**窄画布下的真实布局缺陷**。
//
// 这条用例不依赖任何字体度量或画布宽度：它**直接把摘要撑宽**造出确定性的重叠，
// 再断言相机控件仍然拿得到点击。少了它，修复只能靠下一次 Linux CI 才知道成没成。

import { expect, test } from '@playwright/test'

import { clickCanvasControl } from './canvas-controls'
import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(120_000)

let daemon: DaemonHandle

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

test('RFC-319: the canvas toolbar stays clickable when the validation summary overlaps it', async ({
  page,
}) => {
  await page.addInitScript(
    ({ url, tok }) => {
      window.localStorage.setItem('agent-workflow.baseUrl', url)
      window.localStorage.setItem('agent-workflow.token', tok)
      window.localStorage.setItem('aw-language', 'en-US')
    },
    { url: daemon.baseUrl, tok: daemon.token },
  )

  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const res = await fetch(`${daemon.baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${daemon.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    expect(res.ok, `${path}: ${res.status} ${text}`).toBe(true)
    return JSON.parse(text) as Record<string, unknown>
  }

  const suffix = Date.now().toString(36)
  const agent = await post('/api/agents', {
    name: `rfc319-collision-agent-${suffix}`,
    description: 'RFC-319 toolbar collision fixture',
    outputs: ['answer'],
    readonly: true,
    bodyMd: 'body',
  })
  const workflow = await post('/api/workflows', {
    name: `rfc319-collision-${suffix}`,
    description: '',
    definition: {
      $schema_version: 3,
      inputs: [{ kind: 'text', key: 'topic', label: 'Topic', required: true }],
      nodes: [
        { id: 'in_1', kind: 'input', inputKey: 'topic', position: { x: 0, y: 0 } },
        {
          id: 'writer',
          kind: 'agent-single',
          agentId: agent['id'] as string,
          agentName: agent['name'] as string,
          promptTemplate: 'Answer {{topic}}.',
          position: { x: 320, y: 0 },
        },
        // 一个 inputSource 指向不存在节点的评审门：让校验产生问题，摘要文案
        // 因此变成「! N validation issue(s)」而不是短短的「✓ …」。CI 上正是
        // 这个长度（Linux 178px / macOS 152px）把它推进了工具条的横带里。
        {
          id: 'gate',
          kind: 'review',
          title: 'rfc319 collision fixture',
          description: '',
          inputSource: { nodeId: 'no_such_node', portName: 'answer' },
          rerunnableOnReject: [],
          rerunnableOnIterate: [],
          rollbackFilesOnReject: false,
          rollbackFilesOnIterate: false,
          position: { x: 640, y: 0 },
        },
      ],
      edges: [
        {
          id: 'e_in_writer',
          source: { nodeId: 'in_1', portName: 'topic' },
          target: { nodeId: 'writer', portName: 'topic' },
        },
      ],
    },
  })
  const id = workflow['id'] as string

  await page.goto(`${daemon.baseUrl}/workflows/${id}`)
  await expect(page.getByTestId('workflow-validate')).toBeVisible({ timeout: 30_000 })

  // 让校验摘要出现（它只在拿到校验回执后才挂载）。
  await page.getByTestId('workflow-validate').click()
  await expect(page.getByTestId('workflow-validation-summary')).toBeVisible({ timeout: 30_000 })
  await page.keyboard.press('Escape')

  // 再按**真实成因**把画布挤窄：选中一个节点会展开右侧检查器栏，画布随之
  // 从约 1000px 缩到几百px——这正是 Linux CI 上那次失败的形状（左沿两边都是
  // 253，差异全在右沿）。不用人为改样式，走用户真会走的那条路。
  await page.locator('.react-flow__node[data-id="writer"]').click()
  await page.waitForTimeout(500)

  // 再把窗口收窄一点。CI 上（Linux 字体更宽）1280px 就够撞了；macOS 的字体
  // 窄约 26px，正好差一点点。收窄窗口把几何推进确定性区间，模型的仍是同一件
  // 真实处境——「窗口不够宽 + 检查器栏展开」，而不是靠字体度量碰运气。

  const geometry = await page.evaluate(() => {
    const rect = (sel: string) => {
      const e = document.querySelector(sel)
      if (e === null) return null
      const b = e.getBoundingClientRect()
      return {
        left: Math.round(b.left),
        right: Math.round(b.right),
        top: Math.round(b.top),
        bottom: Math.round(b.bottom),
      }
    }
    return {
      summary: rect('[data-testid="workflow-validation-summary"]'),
      camera: rect('[data-testid="workflow-camera-overview"]'),
    }
  })
  // 不变量：状态芯片与主操作工具条**不得有任何重叠**。
  //
  // 判据用「矩形相交」而不是「中心被盖住」，因为两者只擦到边缘时点击照样成功——
  // 那种情况下用例会绿，而缺陷只是差几个像素没发作。Linux 上字体宽约 26px，
  // 正好把「擦到边缘」推成「盖住中心」：CI 实测相机按钮中心 462 落进摘要
  // （301..479），本机同一时刻还差 26px。所以判据必须比「点得到」更严，
  // 否则这条锁在 macOS 上永远看不见问题。
  expect(geometry.summary, '校验摘要没渲染 —— 前提不成立').not.toBeNull()
  expect(geometry.camera, '相机控件没渲染 —— 前提不成立').not.toBeNull()
  const overlaps =
    geometry.summary!.left < geometry.camera!.right &&
    geometry.camera!.left < geometry.summary!.right &&
    geometry.summary!.top < geometry.camera!.bottom &&
    geometry.camera!.top < geometry.summary!.bottom
  expect(
    overlaps,
    '窄画布下校验摘要与画布工具条重叠了。`.react-flow` 是 z-index:0 的层叠上下文，' +
      '工具条在它内部**抢不到**层级，重叠即意味着主操作被 z=7 的摘要吃掉点击。' +
      `实测：${JSON.stringify(geometry)}`,
  ).toBe(false)

  // 主操作必须仍然拿得到点击。没有修复时这里当场报「被盖住了」并点名摘要。
  await clickCanvasControl(page, 'workflow-camera-overview')
  await expect(page.locator('.workflow-canvas')).toHaveAttribute('data-camera-mode', 'overview')
})
