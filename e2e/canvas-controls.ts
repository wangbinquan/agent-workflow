// 画布控件的点击边界 —— 「被盖住」要当场说清楚，而不是等 15 秒超时。
//
// 背景（RFC-319，2026-08-24）：`rfc250-workflow-camera` 的 `desktop complex
// workflow…` 在 **Linux** 上稳定红，报 `locator.click: Timeout 15000ms`，调用日志
// 只说「有个 workflow-validation-summary 挡着」，既不给两者的坐标、也不给谁在
// 最上层。macOS 的 chromium 与 webkit 都复现不了，于是这条红在 Windows 腿被
// 整文件排除、在 Linux 腿一直挂着，没人能从日志里推进一步。
//
// 这个 helper 把「点不到」从一次沉默的超时变成一条带坐标的断言：点击前先用
// `elementFromPoint` 做一次命中测试，被挡住就立刻抛出——包含目标与拦截者各自的
// 矩形、z-index、定位方式。下一次 CI 红的时候，日志里就有定位它所需的全部信息。
//
// 它不放宽任何判据：命中干净时行为与 `locator.click()` 逐字一致（不用
// `force`，不改点击语义）。

import { expect, type Page } from '@playwright/test'

interface HitProbe {
  readonly target: Rect | null
  readonly hit: Described | null
  readonly clear: boolean
}

interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly z: string
  readonly pos: string
}

interface Described extends Rect {
  readonly desc: string
}

/**
 * 点击一个画布控件；若点击点上盖着别的东西，立刻带现场信息失败。
 *
 * `testId` 是控件自己的 `data-testid`。命中测试沿用浏览器真实的
 * `elementFromPoint`——与 Playwright 的可操作性判定同一套依据，所以这里报出的
 * 拦截者就是那 15 秒超时会碰到的同一个。
 */
export async function clickCanvasControl(page: Page, testId: string): Promise<void> {
  // Keep Playwright's normal render wait before the synchronous hit probe.
  // ReactFlow mounts its controls after the canvas becomes visible; probing
  // document.querySelector immediately made slower WebKit runners report a
  // missing control even though the real locator would have waited for it.
  const control = page.getByTestId(testId)
  await expect(control, `画布控件 [data-testid=${testId}] 未在等待窗口内挂载`).toBeAttached()

  const probe = await page.evaluate((id: string): HitProbe => {
    const describe = (e: Element | null): Described | null => {
      if (e === null) return null
      const b = e.getBoundingClientRect()
      const cs = getComputedStyle(e)
      const tid = e.getAttribute('data-testid')
      return {
        x: Math.round(b.x),
        y: Math.round(b.y),
        w: Math.round(b.width),
        h: Math.round(b.height),
        z: cs.zIndex,
        pos: cs.position,
        desc: `${e.tagName.toLowerCase()}${tid === null ? '' : `[data-testid=${tid}]`}.${
          typeof e.className === 'string' ? e.className : ''
        }`.trim(),
      }
    }
    const el = document.querySelector(`[data-testid="${id}"]`)
    if (el === null) return { target: null, hit: null, clear: false }
    const b = el.getBoundingClientRect()
    const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)
    const target = describe(el)!
    return {
      target,
      hit: describe(hit),
      // 命中自己或自己的后代都算干净（按钮里的 <span> 很常见）。
      clear: hit !== null && (hit === el || el.contains(hit)),
    }
  }, testId)

  expect(
    probe.target,
    `画布控件 [data-testid=${testId}] 不在 DOM 里 —— 点击前它就该存在`,
  ).not.toBeNull()
  expect(
    probe.clear,
    `画布控件 [data-testid=${testId}] 被盖住了，点击到不了它。\n` +
      `  目标：${JSON.stringify(probe.target)}\n` +
      `  实际命中：${JSON.stringify(probe.hit)}\n` +
      `两个绝对定位的浮层撞在一起时，z-index 大的那个赢——把这两个矩形贴进 issue 即可定位。`,
  ).toBe(true)

  await control.click()
}
