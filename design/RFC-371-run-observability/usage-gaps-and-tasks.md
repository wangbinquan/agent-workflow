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


## 2026-10-04 修正完整 Task 被全范围缺口遮罩的回归

实际本机同一原范围有8个Task和14次受理调用；7个Task自己的完整生命周期报告已ready，1个历史Task原采集缺失。当前 `completeReportFactRow` 把原来独立ready的7个物理Task也改成全范围not-ready，导致已核对的四桶Token和人民币估值不能在任务列表显示。这是当前已授权数据恢复的范围错误，不能以任意一个Task缺口否定其他Task已经成立的完整资格。

原同一snapshot、全部Task及每Task原调用/采集/数值来源EOF、完整fold、有序spool seal/count/digest、原owner CAS和读取核验全部保持。只对普通 `tasks` 行保留原 `buildCompleteObservationTask` 已得出的完整metrics联合：ready是该物理Task自身全部原输入完整且精确的统计，not-ready保持该Task自身原缺口，not-applicable保持原执行资格；不从已知allocation子集重算。它不会把父Task下的子Task用量重复加回物理行，也不会将未知或不适用当作零。

整份报告summary及rootTask范围汇总仍保留not-ready；趋势、维度贡献、quality-tasks、attempt、invocation和span披露继续当前遮罩，不凭一个原行ready推断整个分组完整。此次不增加数值collection、不改变任何源总量限制或统计人口。完整原Task行虽可显示自己的已核数字，仍不得在前端相加成全范围小计或把whole report状态改为ready。这一精确的普通Task行例外取代上文对所有Task metrics无差别遮罩的要求，其余缺口资格保持。

原requestKey加入任务独立资格版本，令同actor/query/sourceRevision的新请求离开旧整体遮罩缓存；旧immutable reportId及字节不改。中英文提示说明哪些范围仍有缺口和独立完整Task的呈现，现有Task详情、返回/焦点、四桶/CNY组件保持。回归用同一真实SQLite/PostgreSQL snapshot的两个Task核对：一个原capture缺失保持未知，另一个原完整Task四桶/CNY与其独立生命周期报告一致；整份人口、缺口与汇总保持，损坏行仍拒绝。AW只在GitHub执行这些用例；所有原用例和时限保留。

实际服务首次核对发现原文件spool还保留“全部child metrics必须not-ready”旧条件，报告以 `Incomplete original statistics cannot expose child subtotals` 失败；此失败回执保留。spool同样只允许普通 `tasks` 行保留原Task自己的完整metrics，其余原数值collection、span和child汇总拒绝条件均保持。资格版本更新为 `task-scope-metrics/2`，避免复用修复期间的失败缓存；既有双provider回归使用真实文件spool并验证完整seal/publish/read链路。
