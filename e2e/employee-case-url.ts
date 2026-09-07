// 案例详情页 URL 的等待与解析——四处 spec 共用一份，别再各写各的。
//
// 为什么需要这个 helper：案例详情路由挂载后会把默认 tab **规范化进 URL**
// （`packages/frontend/src/routes/employee-cases.$caseId.tsx:552-558` 的
// `navigate({ replace: true, ...tab='overview' })`）。所以 launch 之后 URL 有两个形态，
// 且是先后关系：
//   1. `/tasks/employee-cases/{id}`               ← 落地瞬间，只存在一次 effect flush
//   2. `/tasks/employee-cases/{id}?tab=overview`  ← 规范化之后的稳定形态（replace 掉了 1）
//
// 于是有两个坑，两个都真实红过：
//   - **等待**：用 `/…\/[0-9A-Z]+$/` 把裸路径锚死，等于赌 Playwright 恰好在那一次 flush 之前
//     采样到 URL。满载 runner 上赌输就是 30s `waitForURL` 超时，且因为形态 1 已被 replace 掉，
//     它永远等不到第二次机会。实红两次：`1aaae33a6`（2026-09-06）与 `a5d387ac0`（2026-09-07）
//     的 `Playwright e2e (macos-latest shard 2/3)`，都挂在 DE-X1。
//   - **解析**：`page.url()` 是在 `waitForURL` 返回**之后**才读的。即便等到的是形态 1，规范化
//     也可能在这两步之间落地，`split('/').at(-1)` 于是变成 `{id}?tab=overview`——它会被原样
//     拼进 SQL（`WHERE case_id = '…'` 查不到行）或接口路径，报出来的错和真正的原因毫无关系。
//
// 两个坑的正解都不是加超时，而是**接受两种形态**并从 pathname 取 id。
// 这个写法最早由 `07c7d37b4` 在 rfc310-digital-employee-journey.spec.ts 就地修出来，
// 当时漏掉了其余三处；抽成 helper 就是为了不再漏第四处。

import type { Page } from '@playwright/test'

/** 两种形态都接受：规范化之前的裸路径，和规范化之后带默认 tab 的那份。 */
export const EMPLOYEE_CASE_URL_PATTERN = /\/tasks\/employee-cases\/[0-9A-Z]+(?:\?tab=overview)?$/

/**
 * 等到案例详情页（两种 URL 形态任一）并回传 caseId。
 * id 一律从 pathname 取，不受 tab 规范化是否已经落地影响。
 */
export async function waitForEmployeeCaseUrl(page: Page): Promise<string> {
  await page.waitForURL(EMPLOYEE_CASE_URL_PATTERN)
  return new URL(page.url()).pathname.split('/').at(-1)!
}
