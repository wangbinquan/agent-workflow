// RFC-357 —— 任务列表对 WS 帧的**就地更新**判据（纯函数，直接可断言）。
//
// 之前每一帧任务级事件都让整棵 `['task-operations']` 缓存失效、把已加载的每一页重取一遍。
// 后端那半（RFC-357 PR-1～PR-3）已经把单次重取降到 O(页)，所以这里要拿回来的不是吞吐，
// 是**延迟与重取次数**：状态 chip 能在帧到达的那一刻就变，而权威数字的重取可以从每秒一次
// 放慢一个量级。
//
// 刻意**不**用 patch 去替代重取，只用它去掩盖重取的延迟：
//
//   · 行的 status / 结束时间可以就地改——帧里带着它，改完就是对的；
//   · 四个页签计数**不在这里算**。facets 的分母是「所有非-view 匹配行」，含当前页看不见的
//     行、也含子行；缓存里只有当前几页的根行，据此加减出来的数字在一部分情况下必然是错的。
//     用户 2026-09-04 报的第一个问题就是「页签数字乱跳」，拿一个会漂的数字去换一点延迟是
//     倒退。数字仍由重取给出，只是重取变稀疏了。
//
// 所以这个模块只做两件确定正确的事：改一行的状态、删掉一行。其余帧（新建任务、成员变更、
// 生命周期告警）算不出来，照旧走失效。

import type { TaskCatalogPage, TaskStatus } from '@agent-workflow/shared'

/** react-query 的 InfiniteData 形状，避免为一个 3 行的类型引 @tanstack 的内部导出。 */
export interface TaskListPages {
  readonly pages: readonly TaskCatalogPage[]
  readonly pageParams: readonly unknown[]
}

export type PatchableTaskListFrame =
  | { readonly type: 'task.status'; readonly taskId: string; readonly status: TaskStatus }
  | { readonly type: 'task.deleted'; readonly taskId: string }

/**
 * 把一帧应用到已加载的各页上。**返回 null 表示这一帧对这份缓存没有影响**——调用方据此
 * 跳过写回，于是不相关的 queryKey 不会因为一次无关的帧而重渲染。
 */
export function applyTaskListFrame(
  data: TaskListPages,
  frame: PatchableTaskListFrame,
): TaskListPages | null {
  let touched = false
  const pages = data.pages.map((page) => {
    if (frame.type === 'task.deleted') {
      const items = page.items.filter((item) => item.id !== frame.taskId)
      if (items.length === page.items.length) return page
      touched = true
      // `facets` 保持原值：它的分母不在这份缓存里，见文件头注释。
      return { ...page, items }
    }
    let pageTouched = false
    const items = page.items.map((item) => {
      if (item.id !== frame.taskId || item.status === frame.status) return item
      pageTouched = true
      return { ...item, status: frame.status }
    })
    if (!pageTouched) return page
    touched = true
    return { ...page, items }
  })
  return touched ? { ...data, pages } : null
}

/** 这一帧能不能就地应用。不能的一律回落到失效重取。 */
export function isPatchableTaskListFrame(frame: {
  readonly type: string
}): frame is PatchableTaskListFrame {
  return frame.type === 'task.status' || frame.type === 'task.deleted'
}
