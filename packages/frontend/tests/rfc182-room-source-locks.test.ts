// RFC-182 —— 源级回归锁（design §6.6）。为什么存在：这些接线藏在运行时组件里，
// 行为级断言难以稳定覆盖（jsdom 无真实滚动高度、drawer 内部历史归并跨 tab），
// 按仓规以源级文本断言兜底：
//   1. render②（跑完即消失的合成活跃行）已被持久回合卡取代——不得回潮；
//   2. drawer runs 必须按成员作用域过滤（跨成员串台修复，D7）且恒含选中 run；
//   3. 滚动锚定接线（onScroll + 回到最新浮标）不得退回无条件贴底。
// RFC-217 T10 拆分后落点：drawer 作用域在壳（room/WorkgroupRoom.tsx），滚动
// 锚定在 room/RoomTimeline.tsx；两文件并读，锁的语义不变。
import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const shell = readFileSync(
  resolve(__dirname, '../src/components/workgroup/room/WorkgroupRoom.tsx'),
  'utf8',
)
const timeline = readFileSync(
  resolve(__dirname, '../src/components/workgroup/room/RoomTimeline.tsx'),
  'utf8',
)
const room = shell + timeline

describe('RFC-182 源级锁', () => {
  test('合成活跃行已删除（回合卡取代 render②）', () => {
    expect(room.includes('streamActiveExecutions')).toBe(false)
    expect(room.includes('wg-active-executions')).toBe(false)
  })

  test('drawer runs 成员作用域（含选中 run 兜底）', () => {
    expect(shell).toContain('ids.add(drawerRunId)')
    expect(shell).toContain('runs={drawerRuns}')
  })

  test('滚动锚定接线：onScroll + atBottom 条件贴底 + 回到最新浮标', () => {
    expect(timeline).toContain('onScroll={onLogScroll}')
    expect(timeline).toContain('workgroup-room__jump')
    expect(timeline.includes('el !== null && atBottom')).toBe(true)
  })
})
