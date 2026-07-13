/**
 * 回归防护：任务列表「工作流」列——工作组任务的「工作组」badge 换行修复。
 *
 * 背景：任务列表（/tasks，routes/tasks.tsx）第 2 列列头是「工作流」。普通工作流任务
 * 该格放工作流名链接;工作组任务因 FK 锚定到内建 __workgroup_host__ 工作流,改为显示
 * 「组名链接 + 一个『工作组』StatusChip」来消歧。原实现把链接和 chip 直接行内排（中间
 * 一个裸空格 {' '}）。chip 是 .status-chip{display:inline-flex; white-space:nowrap},
 * 自身不断行,但作为行内元素紧跟链接;表格是 auto 布局、无固定列宽,当「组名+空格+badge」
 * 宽于该列被分到的宽度时,浏览器在空格处断行,把整个 badge 甩到组名下面一行——即用户看到的
 * 「工作组标签换行」。（工作流任务无此 badge,故只有工作组任务会换行。）
 *
 * 修复：把组名+badge 包进 .task-workflow-cell（inline-flex + 320px cap + min-width:0），
 * 组名用 .task-workflow-cell__name 单行省略号截断,badge 用 .task-workflow-cell__badge
 * 的 flex:0 0 auto 钉在同一行右侧。复用 .task-name-cell 既有的 cap+ellipsis 套路。
 *
 * CSS 布局无法在 jsdom 断言（vitest css:false、jsdom 不做布局），故以源码层文本断言兜底
 * 锁定 CSS 规则与 TSX 接线——改回裸行内排布 / 去掉任一 CSS 规则本测试即转红。
 *
 * 更新（RFC-164 follow-up）：组名/agent 名 + badge 的接线抽进了公共组件
 * components/TaskSubjectLink.tsx（列表 cell + 详情页共用同一份），tasks.tsx 现在
 * 只委托 <TaskSubjectLink>。故 wrapper class 的文本断言改读组件文件；行为覆盖见
 * tests/task-subject-link.test.tsx。CSS 规则断言不变。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

// `__dirname` (the pattern the repo's other source-guard tests use) — NOT
// `fileURLToPath(new URL(..., import.meta.url))`, which throws under vitest.
const css = readFileSync(resolve(__dirname, '..', '..', '..', 'styles.css'), 'utf8')
const tasksRoute = readFileSync(resolve(__dirname, '..', '..', '..', 'routes', 'tasks.tsx'), 'utf8')
const subjectLink = readFileSync(
  resolve(__dirname, '..', '..', '..', 'components', 'TaskSubjectLink.tsx'),
  'utf8',
)

function ruleBody(selector: string): string {
  const idx = css.indexOf(`${selector} {`)
  expect(idx, `missing CSS rule: ${selector}`).toBeGreaterThan(-1)
  return css.slice(idx, css.indexOf('}', idx))
}

describe('tasks list workflow-column workgroup badge one-line guard', () => {
  it('wraps group-name + badge in a single-line flex box (no wrap)', () => {
    expect(ruleBody('.task-workflow-cell')).toMatch(/display\s*:\s*inline-flex/)
  })

  it('ellipsizes the group name instead of pushing the badge to a new line', () => {
    const body = ruleBody('.task-workflow-cell__name')
    expect(body).toMatch(/white-space\s*:\s*nowrap/)
    expect(body).toMatch(/text-overflow\s*:\s*ellipsis/)
    expect(body).toMatch(/overflow\s*:\s*hidden/)
  })

  it('pins the badge beside the name so it never wraps off', () => {
    expect(ruleBody('.task-workflow-cell__badge')).toMatch(/flex\s*:\s*0\s+0\s+auto/)
  })

  it('TaskSubjectLink wires the group/agent name + badge through the wrapper', () => {
    expect(subjectLink).toContain('className="task-workflow-cell"')
    expect(subjectLink).toContain('task-workflow-cell__name')
    expect(subjectLink).toContain('task-workflow-cell__badge')
  })

  it('routes/tasks.tsx delegates the subject cell to <TaskSubjectLink>', () => {
    // The inline cell is gone — the list <td> renders the shared component,
    // so the wrapper classes above must live in TaskSubjectLink, not here.
    expect(tasksRoute).toContain('<TaskSubjectLink')
    expect(tasksRoute).not.toContain('task-workflow-cell__badge')
  })
})
