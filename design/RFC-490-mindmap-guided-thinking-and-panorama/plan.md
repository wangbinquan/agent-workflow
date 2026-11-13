# RFC-490 执行计划

> Done（2026-11-13）。批准依据见 proposal 页首。按本计划一次完成全部实现与用例，再集中验证。

## 任务

| 任务 | 内容 | 依赖 |
| --- | --- | --- |
| RFC-490-T1 | shared：决定状态两个新取值、`isClarifySkipStatus`、规范形式（`withoutStaleClarifySkip` / `clarifySkipStatus`）、回答有效性与确认依据、两种跳过文案、三处提示词短句、`requestTarget` 与 `requestInstruction` 字段；对应 shared 用例 | — |
| RFC-490-T2 | backend：首轮空分类补题、保存追问来源、空分类请求里的既有题目标题、草稿保存与封存的归一、看板条目的跳过字段；双库用例 | T1 |
| RFC-490-T3 | 前端纯函数：列数、逐层可用宽度的换行布局与 `blocks`、面板开合的相机规则、空分组投影、搜索文本与命中片段、下一步建议、复核汇总与分组；对应用例 | T1 |
| RFC-490-T4 | 画布：列数接入、面板开合的相机处理、紧凑题卡、多行连线、空分类卡、缩略标签题号、帮助文字底色、四个可观察属性；对应用例 | T3 |
| RFC-490-T5 | 工作区：并排面板取代弹窗、Esc 与焦点、舞台宽度量取（列数与并排判定）、跳过前回答的会话内记忆、进度行建议入口；对应用例 | T3 T4 |
| RFC-490-T6 | 面板：来源卡、就地决定、跳过与恢复、子题列表、追问行与表单、确认并下一题、面板统一处理的回车、根节点的任务输入与建议；`DecisionDetails` 的 `inline` 布局；对应用例 | T1 T3 T5 |
| RFC-490-T7 | 复核弹窗：汇总、筛选、分组、粘性提交区；对应用例 | T3 |
| RFC-490-T8 | 路由与周边：预设分类（仅首轮）、任务输入、两个前端写入口归一、`QuestionForm` 的意图清除与自定义输入框精简、处理节点下拉精简、已封存页脚的任务结果入口、目录的空分类行与搜索片段、看板对跳过题的显示、文案与样式 | T5 T6 T7 |
| RFC-490-T9 | 改写既有组件用例（含 `overlay-ux-inventory`、`rfc372-mindmap-overview` 的标签断言；`rfc372-mindmap-canvas` 锁定的容器查询文本保持不变）与五份 RFC-372 e2e、RFC-396 e2e 的澄清步骤；新增一条 e2e 旅程 | T1～T8 |
| RFC-490-T10 | 集中验证：shared、backend（SQLite 本机，PostgreSQL 以 CI 为准）、frontend 全量、类型 / lint / 格式、干净导出构建后的 e2e；功能实现门；修复本人缺陷并复验受影响范围 | T9 |
| RFC-490-T11 | 按路径提交推送、确切提交的 CI 跟踪与归因、`STATE.md` 与 RFC 索引转 Done | T10 |

## PR 与提交

单个 RFC、不拆 PR，直接在 `main` 上提交：

1. 文档提交：本目录三件套、`design/plan.md` 索引行、`STATE.md` 进行中条目。
2. 实现提交：T1～T9 的全部源码与用例，一笔提交（跨包契约必须同时到位）。
3. 收口提交：验收记录、索引与 `STATE.md` 转 Done。

## 评审门

- 设计门：实现前由独立只读评审按本目录三件套与所引源码检视，只审功能。已完成（2026-11-12）：结论为需修改，16 条意见全部折入，处置对照见 design §11。
- 实现门：全部实现与用例写完后，由独立只读评审按确切文件清单检视，只审功能（与集中验证针对同一候选内容并行进行）。已完成（2026-11-12）：结论为需修改，一条 P2、四条 P3 与一处时序风险全部处理并复验，处置对照见 design §12。

两个门都不做任何安全相关检视。

## 验收清单

- [x] AC01～AC15（proposal §5）逐项有用例或实测记录（见下表）
- [x] 能力影响清单 C1～C13（proposal §4）交付时逐项回报并得到用户确认：2026-11-13 用户逐组作答，全部保留（见 proposal 页首「交付确认」）
- [x] 普通问答相关既有用例未改动且通过
- [x] 提示词预算用例通过（未放宽预算）
- [x] 干净导出构建的 e2e 实际运行通过（7 份 spec、12 个用例）
- [x] 确切提交的 GitHub Actions 结果如实记录（见「验证与 CI 记录」）

| 验收项 | 证据 |
| --- | --- |
| AC01 就地依据与成熟度 | 前端 `rfc490-question-pane`、`rfc490-decision-details`、`rfc490-workspace-panel`（摆放随面板高宽）；e2e 新旅程 |
| AC02 跳过与恢复 | 前端 `rfc490-mindmap-guidance`（纯函数）、`rfc490-question-pane`、`rfc490-workspace-panel`；后端整轮提交接受已确认的跳过；e2e 新旅程 |
| AC03 跳过状态不丢、真实回答优先 | shared `rfc490-skip-and-origin`；后端 `rfc490-mindmap-followup-targets`（草稿与封存归一、看板）；前端 `rfc490-centralized-reanswer`、`rfc490-clarify-route`、`rfc490-task-question-board`；e2e 新旅程（刷新后保留、最终提示词两种文案） |
| AC04 来源与子题 | 前端 `rfc490-question-pane`；后端保存来源目标与指引；e2e 新旅程与 RFC-372 旅程 |
| AC05 首轮空分类 | 后端 `rfc490-mindmap-followup-targets`（首轮可补、非首轮与未配置仍 404、随整张图关闭）；前端 `rfc490-mindmap-guidance`、`rfc490-workspace-panel`、`rfc490-clarify-route`、`rfc490-mindmap-draw`；e2e 新旅程 |
| AC06 下一步建议 | 前端 `rfc490-mindmap-guidance`、`rfc490-next-steps`、`rfc490-workspace-panel`；e2e 新旅程 |
| AC07 复核汇总、筛选、分组 | 前端 `rfc490-mindmap-guidance`、`rfc490-decision-review`；e2e 新旅程与 `rfc372-recorded-directions` |
| AC08 不需横向平移、窄屏单列 | 前端 `rfc490-mindmap-layout`；e2e `rfc372-recorded-directions` 与新旅程（`data-world-width` × 0.85 不超过画布宽、390 宽为 1 列）；浏览器实测 1440 下 3 列、总宽 808 ≤ 812 |
| AC09 大图与不重排 | 前端 `rfc490-mindmap-layout`（5000 节点、300 同级、100 层）、`rfc372-mindmap-canvas`（布局只随拓扑与列数变化）；e2e `rfc372-mindmap` 大图 |
| AC10 面板与视口 | 前端 `rfc490-mindmap-layout`（相机规则）、`rfc372-mindmap-canvas`、`rfc490-workspace-panel`；e2e 新旅程（并排、Esc、焦点、相机复原、1024 宽占满时焦点交还）与 `rfc372-recorded-mindmap` |
| AC11 一个说法、确认并下一题、回车 | 前端 `rfc490-question-pane`、`rfc372-workspace-ux`、`rfc378-decision`；e2e 全部脑图旅程 |
| AC12 搜索选项与回答 | 前端 `rfc490-mindmap-guidance`、`rfc490-workspace-panel` |
| AC13 已封存页脚入口 | 前端 `rfc490-clarify-route`；e2e 新旅程与 `rfc372-recorded-mindmap` |
| AC14 普通问答不变 | shared 普通模式提示词逐字不变；前端 `rfc490-question-form`、`rfc490-question-handler`、`rfc490-decision-details` 的默认行为用例；普通问答既有用例未改动且通过 |
| AC15 e2e 旅程 | 五份 RFC-372 旅程、RFC-396 四个用例与新旅程在干净导出构建的二进制上通过 |

## 验证与 CI 记录

- 集中验证在「HEAD + 本次路径」的干净导出上进行：类型检查、lint、格式、依赖检查通过；shared 2362 / 2362；前端全量 7536 / 7536（其后只调整依据的摆放条件，受影响的 28 个文件 318 个用例复跑通过）；与本次改动相关的后端 151 个文件 1425 个用例里 1422 通过，另 3 个与本次改动无关并已单独复核；e2e 12 / 12；四种视口的真实浏览器实测无控制台报错。
- 后端全量本机因负载未能得出结论（四个分片均撞到 45 分钟上限），以 CI 为准。
- 实现提交 `aff2c86e3` 的 exact SHA 主 CI run 43391298633：70 个 job 里 68 个成功；`Backend tests (ubuntu-latest shard 20/44)` 失败于 `rfc359-w8-t28-lost-update` L6 [postgresql] 的 40001 序列化冲突，即 `docs/audit-backlog.md` 第十二条登记的既有偶发，本提交不触及其代码路径；未以重跑追绿。
- 后端全量由后继 CI 验证：`cf948fd5c`（run 43396166831）与 `65e57fab7`（run 43396518679）相对 `aff2c86e3` 只改 5 个文档文件（`packages/`、`e2e/`、`scripts/`、`.github/` 无差异），两轮各 70 个 job 全部通过，后端 44 片与真实 PostgreSQL 全绿，含上面那一格。
- 同条件对照（2026-11-13，本机一次性 PostgreSQL，负载 55～85）：只跑 L6 [postgresql]，在实现提交之前的 `33661e100` 与 `aff2c86e3` 的干净导出上交替各 40 次——前者失败 13 次，后者失败 11 次，失败处相同（用例的 `waitForQueued` 等不到并发删除排到写锁上）。该用例在没有本次改动的代码上同样不稳定。
- 那格红的处置（2026-11-13，用户当日授权修这条用例）：根因是终态维护认领的 `transition` 走 SERIALIZABLE——两笔互不相干的认领互判读写依赖，对方提交未完成期间 10 次重放全败（那次 run 的数据库日志：1 次 COMMIT + 9 次 UPDATE，79 ms）。改为普通事务 + 认领行的聚合根锁 + 原有 CAS，并新增双引擎回归用例、收紧 L6 的等待屏障。与 RFC-490 的实现无关，按 bug 修复单独提交；细节与验证见 `docs/audit-backlog.md` 第十二条。
- 修复提交 `008794d3d` 的 exact SHA 主 CI run 43467559383：L6 所在的 `Backend tests (ubuntu-latest shard 20/44)` 1306 / 1306 通过（L6 [postgresql] 494 ms），新回归用例在 `shard 44/44` 6 / 6。该 run 70 个 job 里 66 个成功，未绿的三格（后端 `shard 43/44` 一条调度用例超时、两个 macOS e2e 分片被取消）不在这次改动的路径上，证据在 `docs/audit-backlog.md` 第十四条与第九条 2026-11-13 补记（汇总格 `CI required` 写本条时还在排队、尚无结果）；未以重跑追绿。
