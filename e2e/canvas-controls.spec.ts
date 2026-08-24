// RFC-319 —— `clickCanvasControl` 的自证（守卫必须能证明自己会红）。
//
// 这个 helper 存在的理由是：画布控件被浮层盖住时，`locator.click()` 会安静地耗
// 完 15 秒超时，日志只丢下一行「有个 X 挡着」，既没有坐标也没有 z-index——
// `rfc250-workflow-camera` 在 Linux 上就是这样红了很久而无人能推进。
//
// 所以 helper 本身也需要一条负 fixture：人为造一个遮罩，断言它**当场**报错、
// **点名**拦截者、并带上两个矩形。不这么做的话，helper 有没有生效无人知晓，
// 它只是又一层可能恒真的包装。

import { expect, test } from '@playwright/test'

import { clickCanvasControl } from './canvas-controls'
import { startDaemon, type DaemonHandle } from './harness'

test.setTimeout(90_000)

let daemon: DaemonHandle

test.beforeAll(async () => {
  daemon = await startDaemon()
})

test.afterAll(async () => {
  if (daemon !== undefined) await daemon.stop()
})

test('RFC-319: clickCanvasControl names the element that covers a control instead of timing out', async ({
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
  await page.goto(`${daemon.baseUrl}/agents`)

  // 一个可点的目标，和一个盖在它上面、z-index 更高的浮层——就是两个绝对定位
  // 工具条撞车时的形状。
  await page.evaluate(() => {
    const target = document.createElement('button')
    target.setAttribute('data-testid', 'rfc319-hit-target')
    target.style.cssText = 'position:fixed;top:100px;left:100px;width:80px;height:30px;z-index:1'
    document.body.append(target)
    const veil = document.createElement('div')
    veil.setAttribute('data-testid', 'rfc319-hit-veil')
    veil.style.cssText = 'position:fixed;top:90px;left:90px;width:200px;height:60px;z-index:9'
    document.body.append(veil)
  })

  const startedAt = Date.now()
  let message = ''
  try {
    await clickCanvasControl(page, 'rfc319-hit-target')
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  const elapsedMs = Date.now() - startedAt

  expect(message, '控件被盖住却没有报错 ⇒ helper 是恒真的包装').toContain('被盖住了')
  expect(message, '报错里没有点名拦截者 ⇒ 下一次 CI 红的时候，日志依旧推进不了任何事').toContain(
    'rfc319-hit-veil',
  )
  expect(message, '报错里没有目标的矩形').toMatch(/"x":100/)
  expect(elapsedMs, '仍然走的是慢超时 ⇒ 每条被盖住的用例继续白等 15 秒').toBeLessThan(5_000)

  // 正向对照：把遮罩移开之后，同一个 helper 必须正常点得下去。
  // 少了它，上面四条断言只证明「这个 helper 总是抛错」。
  await page.evaluate(() => {
    document.querySelector('[data-testid="rfc319-hit-veil"]')?.remove()
    const target = document.querySelector('[data-testid="rfc319-hit-target"]')
    target?.addEventListener('click', () => {
      target.setAttribute('data-rfc319-clicked', 'yes')
    })
  })
  await clickCanvasControl(page, 'rfc319-hit-target')
  await expect(page.getByTestId('rfc319-hit-target')).toHaveAttribute('data-rfc319-clicked', 'yes')
})
