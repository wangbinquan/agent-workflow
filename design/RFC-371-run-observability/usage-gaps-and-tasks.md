# 用量缺口说明与原任务定位

这是已批准 RFC-371 正式页面的修正。当前 not-ready 可能是历史调用、原生采集或用量记录缺失，不代表报告仍在后台生成；全部原记录已读取到 EOF 后形成的执行事实仍可显示。不得恢复旧有数字子集汇总、把缺失当零，或使展示分页决定统计人口。

## 同一个完整报告中的缺口任务

原 cohort 每个选中的物理 Task 使用其独立 build.fold.gaps，一种原因只登记一次。质量计数与 Task 关联都从这一原始集合产生，不从全报告遮罩后的 Task metrics 猜测。新增 quality-tasks section，parent 为原缺口 reason，行保持原 CompleteObservationTask 的 ID、名称、状态、attemptCount 和 timing。原任务外部排序后写入，和普通 Task 表同序。

完整工作区内保存每个 Task 的缺口关联，沿原 keyset traversal 到 EOF；任何关联源或原 Task 缺失必须失败。每个原因的准确 taskCount 必须等于实际写入该 parent 的行数，使用任意精度十进制计数。传输、seal、原 report owner CAS、计数双向一致、固定 generation/snapshot/section/parent/cursor 和项目/Actor 范围守卫全部保持。没有新增总任务、调用、关联或页数上限。

quality-tasks 属于完整执行事实 section。not-ready 仍只发布已封存事实；该新行的所有 Token 与金额 metrics 一律遮罩为 not-ready，不泄露任何已知子集数字。缺口原因保持原机器标识，不把无 accepted invocation 推断成无模型调用。旧 report 没有新 section 时不伪造关联或给零记录。

## 页面与返回

使用中英文原因说明，保留未知原因的原标识。not-ready 明确说明原用量有缺口、继续等待不会补齐、任务/执行/时间仍可核对。根缺口提示、Task/维度指标和质量表使用相同的原因翻译；四类 Token 与费用仍明确未知。

缺口表直接显示一种原因和受影响 Task 数，点击查看按完整 report 的 quality-tasks 分页。它是缺口定位入口，不重新添加用户已要求删除的泛化“需要关注的任务”卡片。复用共享 Card、Dialog、TableViewport、CompleteTaskRows、原分页与 useObservationReturn；Task 名称样式和普通列表相同，不添加框、更多筛选或 CSV。来自缺口的 Task 详情保留该原报告与页位置，返回后恢复缺口 Dialog、触发行、滚动和焦点；改变范围/页签/刷新清除原披露。

任何原页、计数或来源报告失败都撤下该报告内容，不保留旧事实或旧数值。无 facts 的 not-ready 只显示准确原因说明，不自造统计。

## 验证与门禁

真实 SQLite/PostgreSQL 构建回归核对超过 200 Task 的关联完整性、原因重叠不重复计数、分页 EOF、已无缺口 Task 不纳入某原因、原 parent count 与 quality 一致。前端覆盖中英文说明、超过 200 Task 的全部页、Task 点击与嵌套返回、改变范围、未知原因和页损坏。现有断言与时间预算保持；AW 不运行本机测试/类型/构建/服务，正式运行以发布确切 SHA 的 hosted CI 为准。

此修正不能替代原 native owner 接线、全部 producer 上限移除、历史原记录补录或真实模型/规模验收，也不关闭 RFC。
