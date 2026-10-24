# RFC-396 实现候选验收记录

## 2026-10-23 大图测量发现的真实节点交互缺陷

对 `abcacb0166fc2434d406ef59b43bddf45e4f0b01` 的准确 GitHub macOS artifact 进行固定大图测量，三个场景均在首个局部 SVG 的可交互节点等待处失败，未记录为性能通过。独立有界 DOM 诊断确认 200 元素视图的生产缺陷：`GraphModelView` 在所有 `[id],[data-id]` 上用 `id.includes(renderId)` 取首个匹配，而 Mermaid 连线 ID 同时包含两个端点 ID。两个语义节点因此命中同一 `path`，后者覆盖前者的可访问名称，真实 `g.node` 没有点击或键盘入口。

直接观察到 **199 个 `role=button` 全部为连线 `path`，首节点的普通/含隐藏可访问查询及 CSS 标签查询均为 0**。SVG 在约 **478.33 ms** 出现；随后 **12 秒**内经过两次约5秒轮询，SVG ID 未改变，没有有效 SVG 替换。因此本次不是超过60秒的绘图耗时，也不是轮询不断销毁图。原测量仍保留完整失败；直接 DOM 因果证据限于200元素视图，不能从它声称另外两种规模已完成验收。诊断退出码0，浏览器、daemon和fixture服务均清理。[机器可读诊断](./graph-interaction-diagnostic-2026-10-23.json)包含准确产物身份、两端误映射、轮询和原始记录摘要。

修复已精确识别 flow/state/data 节点容器及 sequence 参与者容器，让点击、Enter/空格与 `aria-pressed` 使用同一映射；连线、生命线和标签不能成为语义节点的替身。绑定按完整 ID 查表，保留时序图上下镜像，更新选择不重绘，并在重绘/卸载时清理监听。组件回归 **10 passed / 0 failed，1.85s**，覆盖真实 DOM 顺序、render ID 前缀碰撞、每次操作只触发目标、镜像同步、监听清理、过时异步结果和 Markdown 切换；前端 `tsc --noEmit` 与相关 ESLint 均退出0。证据：`/tmp/rfc396-graph-model-view-tests.log`、`/tmp/rfc396-graph-model-view-types.log`、`/tmp/rfc396-graph-model-view-lint.log`。

新增独立 E2E 通过普通 `/changes` 接口创建四种有连线的图，验证目标节点独立选择、语义列表同步以及时序图上下镜像同步，原三条 MR 旅程保持。E2E 静态语法、格式与 ESLint 检查通过；准确新 artifact 的四类真实 SVG 验收和大图测量仍待执行，组件 fixture 不代签真实渲染结果。

类型夹具修复提交 `338babd1f08aa281c7d2a532431ca1dcc1fd2a6a` 已随共享 `main` 发布。包含它的后继 `9a900aaa5709b147838f3ea64420050e28468895` 已核对祖先关系及三个修复路径内容保留；[CI 40054322444](https://github.com/wangbinquan/agent-workflow/actions/runs/40054322444)仍待终态。原 `abcacb` 的 Typecheck 失败保留，不能以本地类型复验替代后继 hosted 结果。

## 2026-10-23 无变化重验候选发布与直接恢复旅程

候选 `abcacb0166fc2434d406ef59b43bddf45e4f0b01` 已按12个准确路径发布。[CI 40053286328](https://github.com/wangbinquan/agent-workflow/actions/runs/40053286328) 的功能检查job `120750501934` 在Typecheck失败：新增测试 `publishedFixture()` 的 `publication` 回执字段被 `...f` 传入应用工厂，与其同名 `publication.remoteUrl` 依赖冲突，出现三处 `TS2345`。这是本会话测试配套问题，不能归为环境或其他会话。现已只将该fixture字段改名 `publishedDelivery` 并更新引用，未加类型断言/抑制、未改生产；后端 `NODE_OPTIONS=--max-old-space-size=8192 bun run typecheck` 退出0。原失败日志 `/tmp/rfc396-abcacb-functional-lint-job.log` 与修后 `/tmp/rfc396-noop-backend-types-repair.log` 保留，hosted修复结果等待后继准确SHA。Static scans失败仅记录状态。

该候选的GitHub macOS artifact **12544371859**（压缩包digest `sha256:1aedd2d339a625ab30afb4180ae08e2b059e725da54b29e2b0ab9887735fd49d`）已校验。新增通知MR恢复旅程实际 **1 passed / 0 failed / 0 skipped / 0 flaky，96.7s**：MR发布后关闭全部页面，SIGKILL daemon，在服务离线期间只改变外部fixture的MR状态；使用原数据目录重启后，真实observer在没有页面打开时消费closed终态，原MR ref/编号/source/target/head保持且没有重复MR，随后重开页面检查终态。退出时daemon与fixture服务清理完成。原始结果为 `/tmp/rfc396-abcacb-recovery.json`、日志 `/tmp/rfc396-abcacb-recovery.log`，artifact身份为 `/tmp/rfc396-abcacb-artifact-provenance.json`。代码托管与模型为受控fixture，此结果证明直接恢复接线，不替代企业连接验收。

后继测试字段更名未改变生产或E2E内容，上述准确artifact证据按其范围复用；有限大图测量单独记录。

## 2026-10-23 接续候选与外部验收前提

文档提交 `5912ec43b94a7c3646fbb41a6892c418f709f913` 的 [CI 39978754925](https://github.com/wangbinquan/agent-workflow/actions/runs/39978754925) 已完成 **47 success / 2 failure**。所有功能 jobs 成功，失败为 Static scans（job `120500185914`）及派生汇总（job `120513349817`）；仅读取状态元数据。该提交保留 `ae210` 的源码和测试内容，提供后继功能 CI 证据；没有据此抹去或归因原 `ae210` 的 macOS 超时，整条 CI 仍为 failure。

本轮代码收尾覆盖已发布 MR 无变化重验的 `candidate-empty`、重复提交和回执重放，并将浏览器关闭、daemon 崩溃后以同一持久目录恢复 MR 的直接旅程补入原通知 E2E。新增生产、回归用例和有限大图测量均先写齐，再集中验证；以下历史通过结果不代签这一新候选。

本轮集中SQLite验证覆盖7文件、77个用例：首轮 **74 pass / 3 fail，468 assertions，62.52s**。三项均为新增测试构造/期望错误：提交标题遗漏生产 `aw:` 前缀、材料列表遗漏原始需求，以及repair复用原reaction round导致候选唯一约束拒绝入库。修正后两个受影响文件 **32 pass / 1 fail，256 assertions，54.17s**；最后一个夹具仍把两个round同时置为running，触发Case单writer约束。最终通过正式 `settleRound` 完成原handoff后再建repair，并只复验该用例 **1 pass / 0 fail**。生产内容未因这些测试错误修改，其余未变用例复用有效成功结果；不声称最后又跑了一次77/0全套。原失败日志分别保留在 `/tmp/rfc396-noop-sqlite.log`、`/tmp/rfc396-noop-sqlite-repair.log`，末次结果为 `/tmp/rfc396-noop-owner-repair.log`。任务文件ESLint、Prettier、diff检查通过。独立只读功能复核已确认重放、真实tree变化和同tree发布身份变化的完整分支；不将静态复核代签运行结果。

PostgreSQL与原生三平台结果等待本候选GitHub CI；新增浏览器离线/daemon崩溃恢复旅程和多视图/深依赖测量等待该精确SHA构建产物。没有启动额外全量本地gate。

真实企业连接与新版本托管验收当前有明确外部前提：[只读就绪记录](./hosted-readiness-2026-10-23.json)。原 green 服务在容器可写层创建应用目录时直接报 `ENOSPC`，节点 fs/imageFs/containerFs 的 `availableBytes` 均为0；task parent仍运行旧镜像。CS、GitLab和registry分别返回500或有界请求失败，没有认定它们与满盘共享同一根因。尚未部署新graph@2、创建真实MR或触发真实CI。旧图@1的 `publication:null` 仍只证明原内部候选流程。

清理核对发现三个本RFC历史 `tail -F` 日志跟随进程遗漏，现已结束并保留日志，纠正此前进程清理不完整的记录。没有清理集群缓存：跨namespace镜像引用查询被自动审批拒绝，且registry可恢复性未获证实；没有绕过拒绝或删除其他项目内容。

## 2026-10-23 最新修复接受与 CI 边界

源码修复 `ae210a8399964b249e68c8cc2c4b5de230c0aec5` 的 [主 CI 39972466454](https://github.com/wangbinquan/agent-workflow/actions/runs/39972466454) 已终态 **46 success / 2 failure / 1 cancelled**。类型/lint/格式、后端/前端、三平台构建、九个 E2E 分片及链接检查成功；Static scans 的 dependency audit gate 失败（只读步骤状态），macOS E2E 2/3 触发既有20分钟 job上限取消，`CI required` 因此失败。没有称整条 CI 全绿，没有重跑旧 CI 覆盖失败。

- [Linux 图所在分片](https://github.com/wangbinquan/agent-workflow/actions/runs/39972466454/job/120479370593)：167 passed；三个图旅程首轮36.6s / 53.4s / 17.5s。
- [Windows 图所在分片](https://github.com/wangbinquan/agent-workflow/actions/runs/39972466454/job/120482288428)：137 passed / 1 flaky；三个图旅程首轮1.9m / 3.0m / 1.6m。另一个普通任务 `running-api` 首次10秒仍pending，重试通过；保留其未知归属，不把分片成功记成无波动。
- [macOS 2/3](https://github.com/wangbinquan/agent-workflow/actions/runs/39972466454/job/120483333367)：check-run 明确 `The job has exceeded the maximum execution time of 20m0s`。取消前 `rfc319-worktree-and-commit` 的 beforeAll 初次和重试均90000ms超时，另有 `rfc372-mindmap` 大图用例失败，重试未完成。没有 RFC-396 完成结果；也不能根据没有结果行断言未开始。取消机制明确，耗时和失败根因仍未确定。相关 specs、harness和CI配置与上一候选fb99为相同Git blob，后端未变；这些事实不足以直接排除共享负载影响。未改这些用例、超时或其他会话产出。
- [视觉回归39972466358](https://github.com/wangbinquan/agent-workflow/actions/runs/39972466358)：同一SHA completed/success。

该准确SHA的GitHub macOS artifact **12509828093**（压缩包digest `sha256:7033d28d92f6ada2ed56199011ae56441fa36d243eb530cbaa773dfebe4e6bdd`）本地真实浏览器三旅程 **3 passed / 0 failed / 0 skipped / 0 flaky，131.9s**。预约完整经过员工创建、任务受理、原始澄清/暂定决定及后续图、审核、实现、验证、MR和合入；其余两个旅程保留API准备。确认页自动MR分支说明、390/320px HTML和文本Range可见边界断言全部通过。实际读取确认页、两种窄屏、MR等待、合入、关闭六张截图，确认新说明、控件换行和终态区别；SVG保留自己的横向滚动。模型/代码托管仍为受控fixture，不能替代企业连接和模型质量接受。

原始证据为 `/tmp/rfc396-ae210-{main,visual}-ci.json`、`/tmp/rfc396-ae210-native-{linux,windows,macos}-job.log`、`/tmp/rfc396-ae210-ui-summary.json`、`/tmp/rfc396-ae210-artifact-provenance.json`、`/tmp/rfc396-ae210-ui-screenshots/`。验收和监控进程均已退出；未重复全量本地gate。归属未明项及真实企业连接/新版本托管验收继续开放，RFC保持In Progress。

## 2026-10-23 页面操作补齐的实际执行与修正

`fb99b3a0dfffd749b681cc12f867c5085c4eb878` 发布了空 CI/明细/终态呈现修复及预约页面操作用例。该 SHA 的 GitHub macOS artifact 本地结果 **2 pass / 1 fail**：通知和已有模块的 MR 观察与终态成功，预约停在新增的岗位下拉框精确名称定位。三个平台 hosted E2E 确认同一失败，属于本会话用例。主 CI `39965841593` 终态 **44 success / 5 failure**，其他失败为 Static scans 与派生汇总。修正后限定复验又发现预选员工的任务深链会自动前进，已改为实际点击可见步骤。原失败日志 `/tmp/rfc396-fb99-ui-journeys.log` 与 `/tmp/rfc396-fb99-booking-repair.log` 保留。

纠正后的完整预约页面旅程使用该 SHA 的 GitHub macOS artifact **12506702914**，结果 **1 passed / 0 failed / 0 skipped / 0 flaky，39.1s**。实际通过页面创建员工/任务、查看并回答原始问题、保留 provisional 和未填写的负责人/日期、确认设计、实现、独立验证和人工验收，并读取 MR、打开 CI 岗位草稿入口、消费外部合入。模型/代码托管仍是 fixture；图示 fixture 不证明模型质量。日志与 JSON 为 `/tmp/rfc396-fb99-booking-final-unsandboxed.{log,json}`，八张原始 PNG 位于 `/tmp/rfc396-fb99-booking-final-unsandboxed-attachments/`；根已读取创建摘要、原始问题、确认和320px截图。此前一次受限沙箱中的 Chromium 启动失败 `MachPortRendezvousServer ... Permission denied (1100)` 单列保存，不记作产品失败。

截图已验证空 CI 提示、配置入口、收起明细和终态历史，但同时发现以下遗漏，已完成生产修改与直接回归用例：

- MR 空闲等待仍显示内部事件名：使用同一 MR 观察文案，保留停止/阻塞/审批/可合入优先级；终态与等待回归 **22/0**，相关 lint 通过。
- 新 MR 岗位确认页误称“仅交付内部候选”：通用确认组件直接使用现有岗位合同必填的本地化 description，兼容旧内部候选与新自动 MR 分支语义；E2E 断言准确说明且不出现旧文案。
- 320px 的内部网格裁切：限定图工作区网格 minmax/min-width 与控件换行，保留 SVG 滚动和缩放；390/320px 回归读取实际 HTML/文本 Range 与横向裁切祖先可见边界，不能只看 document 总宽度。

本段新的生产修复及增强用例须消费后继 artifact 和 exact-SHA CI；上面的39.1s结果不代签。未变化组件的原60项结果复用，未启动重复全量门禁。

## 2026-10-23 Windows 修复已通过，继续补界面验收

`b0afe1b6411f8e3e2333f633871079dd21d636da` 的 [Windows E2E 3/4](https://github.com/wangbinquan/agent-workflow/actions/runs/39960727188/job/120439725490) 已成功，三个 graph@2 交付及合入/关闭旅程均首轮通过；不再用本地路径约束测试代替原生 Windows 结果。该 job 另有普通任务完成的 `1 flaky`，证据保留在 [CI 归因](./ci-audit-2026-10-23.md)，不冒充无重试全绿。

本次准确 SHA 的 GitHub macOS artifact 还完成一次本地真实 daemon/浏览器验收：**3/0，160.2s，无跳过或重试**；截图含 MR 等待、合入和关闭。模型及 code host 仍为 fixture，且原创建/回答步骤通过 API，不能代替完整页面操作或企业连接验收。实际截图揭示空 CI 占位被画成等待、详情占满首屏的问题，已经完成修复与用例，并把预约场景的员工创建、任务受理和原始澄清补为页面操作。新 UI 候选集中前端回归 **60/0，3 files，3.81s**，相关源码/测试 ESLint 通过；实际页面旅程与修复后截图等待新候选运行，不回写旧结果。日志 `/tmp/rfc396-ui-care-central-tests.log`、`/tmp/rfc396-ui-care-lint.log`。

Windows 修复提交的主 CI 已终态 **47 success / 2 failure**，剩余为 Static scans 与派生汇总；功能、构建与十个 E2E 分片均成功，不代表整条 CI 全绿。

## 2026-10-23 继续验收：旧发布阻塞已处理，Windows 交付修复中

后继 `67ab6b9ae` 已处理误发布的任务启动合同，并保留本任务材料说明能力；其主 CI 类型、后端分片通过。先前“等待完整 II-a 迁移才能继续”的阻塞描述已不再适用于当前提交。目录视觉基线在 `94088b876` 的 exact-SHA 视觉 CI 已通过。

最新完整 nightly 的 graph@2 三个 MR 旅程首轮通过，但 Windows 主 CI 的三个旅程仍停在交付前；本任务 checkpoint 目录直接使用含冒号的记录 ID，是可证的 Windows 路径缺陷。本次改用稳定目录标识，保留业务记录身份并补交接/内容/重放回归，SQLite **18/0、108 assertions**，相关 lint 通过；Windows 接受仍须新的 hosted CI。主 CI 与全部 10 个定时 workflow 的逐项归因、pre-RFC396 对照及未明责任见 [CI 归因记录](./ci-audit-2026-10-23.md)。RFC 保持 In Progress，下面保留前序快照和真实失败，不作为最新结论。

## 2026-10-22 MR 能力补齐与全面回顾：当前候选

本轮生产和用例已完成，已以 `ba7b8c6c4a03f0ab952dfd52fee291332dda74f5` 发布到 `origin/main`，集中验证正在收口，RFC 仍 In Progress。旧版内部交付证据在下方保留，不外推为新的 MR 能力通过。

| 范围                                | 本轮结果与证据界限                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL，全部 `rfc396-*.test.ts` | **156 pass / 0 fail，909 expect，24 files，168.47s**；真实专用 PostgreSQL，不是 SQLite 推断。日志 `/tmp/rfc396-mr-postgresql-central.log`                                                                                                                                                                                                                                                                     |
| SQLite，首轮 24 files               | **147 pass / 8 fail，862 expect**；原失败如实保留。2 个 runtime 新断言形状、4 个局部 fixture 非法修改来源、1 个旧人工验收 fixture 不可读、1 个应用装配缺共享 MR 修复工具初始化                                                                                                                                                                                                                                |
| SQLite，失败范围复验                | runtime/jobs/intake **17/0**；local-planning/review-regressions **17/0**；verification **13/0**；HTTP/registration 通过。未重跑未变化的整个集合，不将重叠结果重复累计                                                                                                                                                                                                                                         |
| 既有装配回归                        | RFC-383 guard 分别追踪 graph@1 / graph@2，保留 former-wiring 对照；修后 **12/0，57 expect**。默认 MR 工具在 load 时先确保共享内置 agents，真实 HTTP 应用启动通过                                                                                                                                                                                                                                              |
| 前端交互                            | 终止态 **6/0**；人工验收候选/范围变化 **11/0**；工作区修后 **26/0**（含实现门发现的两条恢复旅程）；合计覆盖 **43 个独立用例**，三文件结果分别记录                                                                                                                                                                                                                                                             |
| 独立实现门                          | **PASS**；两处 UI 旅程回归修复后定向复核通过，详见 [implementation-gate](./implementation-gate.md)                                                                                                                                                                                                                                                                                                            |
| 静态                                | backend / frontend 初轮修后 `tsc --noEmit` 通过；backend 默认 Node 4 GiB heap OOM，8 GiB 完成。末次共享树前端检查又出现 3 处并发错误：非本任务 `shared/src/schemas/task.ts` 的 `taskExecutionKind` 新增 `digital-employee`，而 `TaskSubjectLink.tsx` / `tasks.new.tsx` 尚未覆盖。实际 diff 已核实，未代改或纳入提交；本任务新增测试的参数类型已修。任务路径 ESLint 通过，最终整仓结论以本次 exact-SHA CI 为准 |
| MR E2E                              | 三个既有图旅程已适配 graph@2，保留主要图/审核/证据断言，并增加同 Case MR 创建、缺 CI 不误绿、外部 merged/closed 观测终结；模型与 code host 是受控 fixture。本次托管 CI 的浏览器任务已启动，尚无通过结论；数字员工启动模型的发布依赖缺口单列于下方                                                                                                                                                             |
| 真人浏览器                          | 当前 CUA inventory 为 apps=[] / browsers=[]，创建 iab 返回 `Browser is not available: iab`；不宣称本轮真人界面验收通过                                                                                                                                                                                                                                                                                        |
| 发布与 hosted CI                    | `ba7b8c6c4a03f0ab952dfd52fee291332dda74f5` 已推送，推送后本地/远端差异 `0/0`，共享 index 为空；71 个准确路径包含本任务内并行 Codex 产出，其他在制内容保留未提交。[主 CI 39914131430](https://github.com/wangbinquan/agent-workflow/actions/runs/39914131430) 与 [视觉回归 39914131342](https://github.com/wangbinquan/agent-workflow/actions/runs/39914131342) 执行中；此前 `67795ed462` 的结果不能证明新代码 |

新增实现与恢复边界见 [全面回顾](./review-and-mr-parity.md)，岗位与 CI 连接使用方式见 [usage](./usage.md)。本轮未修改旧托管实例或其镜像。

### 本轮发布后的 CI 归因与共享文件依赖缺口

`ba7b8c6c4a03` 的 [CI 39914131430](https://github.com/wangbinquan/agent-workflow/actions/runs/39914131430) 已报告失败；本地共享树中的通过结果不能替代这个实际发布快照。独立功能复核只能说明其审阅的候选内容，不能据此认为发布依赖已完整。

| 失败范围                                                                                                              | 已核实原因与处置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 类型检查、backend 10/24 的 hostWorkflow 四项、backend 20/24 的真实数字员工执行四项，以及 backend 14/24 的人工审核 E2E | `digitalEmployeeExecution.ts` 整文件除本任务的材料说明前缀/env，还提交了 RFC-395 II-a 的 `TaskStartOptions`、新 `subject` 和移除旧宿主播种的改动；所依赖的共享 schema、启动 kernel、任务主体/创建、审核投影及测试仍只在本地在制。远端旧 kernel 仍读取 `input.subject.workflowId`，类型和实际启动均不成立。**这是本次发布选择的依赖闭包遗漏，不能仅称为外部旧测试问题。** 保留全部迁移产出，不还原新模型、不删旧断言，也不擅自扫入尚未完成集中验证的迁移文件。完整迁移闭包可提交之前，此项阻塞整仓通过 |
| backend 15/24，OS 架构两项                                                                                            | 新 MR 界面包含开发员工业务语义却位于通用数字员工组件目录；两个类型包组合层依赖未登记。修复将图功能归位至 development-automation feature，并精确补齐已审阅依赖，既有禁止规则保持不变                                                                                                                                                                                                                                                                                                                   |
| backend 6/24，测试跳过登记                                                                                            | 新 MR bridge 测试因 POSIX shebang/chmod 夹具跳过 Windows；业务断言本身无需该限制。改为生产仓库脚本解析器定位脚本、显式 Bun 执行，保留全部 17 项用例和真实执行证据，不增加跳过豁免                                                                                                                                                                                                                                                                                                                     |
| backend 1/24，能力证据索引                                                                                            | 两个 graph E2E 标题更新后索引仍是旧名称；只重接精确标题，保留原有覆盖断言                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Static scans                                                                                                          | 只读取状态元数据：该 job 失败。未读取该类 findings 或日志，未对此开展分析                                                                                                                                                                                                                                                                                                                                                                                                                             |

依赖缺口的具体边界：`packages/shared/src/schemas/task.ts`、Task Execution 的 `taskRouteLaunchOperations.ts` / `taskSubject` / `taskCreation` / repository codecs、Collaboration 的 `review.ts` 与任务主体查询合同、`actionExecutionEnvironment.ts` 及对应历史回归。当前 `public/queries`、`services/task` 和新增测试 helper 又与迁移其他部分耦合，不能把这些路径当作已确认可独立发布的 allowlist。对应 II-a 计划要求整组集中验证后提交；本任务继续处理独立缺陷，未替代迁移责任范围。

本任务独立修复已完成集中复验：SQLite 的 OS 架构、测试跳过策略、能力索引与 MR bridge 四文件 **58 pass / 0 fail，189 expect**；迁移后图工作区/人工验收/终态与 overlay inventory 四文件 **46 pass / 0 fail**；14 个相关 TS/TSX 路径 ESLint 通过。日志分别为 `/tmp/rfc396-ci-repair-backend.log`、`/tmp/rfc396-ci-repair-frontend.log`、`/tmp/rfc396-ci-repair-lint.log`。8 个 UI 文件迁移前后内容 SHA256 一致；没有改动 OS 禁止规则或测试跳过允许清单。以上不覆盖未闭合的 Task 主体发布依赖，也不是 Windows bridge 实跑或新提交的 hosted CI 通过证明。

上述独立修复已以 `6423d9ef0cb86be3e8b6eadfed6adf3565bc8e16` 推送，推送后本地/远端差异 `0/0`、index 为空；[主 CI 39916451896](https://github.com/wangbinquan/agent-workflow/actions/runs/39916451896) 与 [视觉回归 39916451473](https://github.com/wangbinquan/agent-workflow/actions/runs/39916451473) 启动时分别记录，未宣称它们已通过。

首个 MR 提交的 [视觉回归 39914131342](https://github.com/wangbinquan/agent-workflow/actions/runs/39914131342) 终态为 **58 passed / 1 failed**，唯一失败是数字员工类型目录截图。按视觉回归 README 的 Option A 下载 artifact `12484069229`，逐张查看 expected / actual / diff 后确认：变化仅为图数字人卡片显示新的 MR 看护说明、工作项 `6 → 24`、生命周期区域 `1 → 2` 及对应文字排版；其他卡片与页面布局保持。当前快照与 artifact 中 expected 字节一致，已将逐张审阅后的实际截图原样复制到唯一对应的 Linux 基线，不提高阈值、不批量接受其他截图。新的 exact-SHA 视觉回归仍须给出零差异结论；这一目录截图也不替代完整 MR 运行验收。

**2026-10-22 全面回顾后的当前裁决：需要修改后再验收。** 以下“功能验收完成”是前一轮范围的历史记录。本轮确认 R01～R10 功能/可用性缺口，以及 MR 提交和持续看护未接入；新增范围见 [review-and-mr-parity.md](./review-and-mr-parity.md)。原浏览器旅程含 API 建立工作和提交澄清，不能当成全程 UI 可用性证明。新的 MR 生命周期、修复和 UI 验收尚未完成。

2026-10-22 当前功能验收已完成：三个真实模型旅程已交付（预约 24/0、通知 44/0、已有模块 13/0）；实际托管 Case 已 terminal / graph-development.delivered，独立测试 1/0、6 assertions，原始证据和产品入口均已读回。最新修复源码 `67795ed462` 的主 CI 39814553963 为 49/49 success；共享 main 后继整体 CI 尚有失败，RFC 保持 In Progress，功能验收与最终仓库 CI 分列。精确版本见 [真实模型汇总](./real-model-summary.json)、[托管完整回执](./hosted-completion-evidence.json) 和 [失败及恢复历史](./real-model-acceptance.md)。

以下为 2026-10-21 首轮候选及后续修复的历史验证记录；最新状态见上方和真实验收文档。用户批准完整实现与远端交付；此记录分别说明已证实内容和尚未证实内容，不以单个通过结果宣称 RFC Done。

## 候选与环境

- 在现有主 checkout 的 `main` 开发，保留并发 RFC-395 和任务执行修复；未创建开发分支或工作树。
- 本地 Bun `1.3.13`，仓库声明 `>=1.4.3`；最终全仓结论由 hosted exact-SHA CI 给出。
- 双库验证使用 SQLite 与本会话专用真实 PostgreSQL 库；未将 SQLite 结果代替 PostgreSQL。
- Playwright 旅程使用真实 daemon、Case、原生 clarify/review、Git 和浏览器，仅模型协议和代码托管服务使用夹具。
- 实现阶段未运行完整本地 gate。下列集中验证及缺陷修复后的针对性复验分别留痕，数目不重复累计。

## 首轮验证证据（历史快照）

本地日志位于本次会话 `/tmp/rfc396-*.txt`；可复跑测试源码在仓库。日志不是远端 CI 或部署证明。

| 范围                                               | 结果                                                                                                   | 记录                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| 架构与装配规则                                     | 230 pass / 0 fail，1001 assertions                                                                     | `rfc396-architecture-repair-1.txt`                                                                                       |
| 既有后端合同、问答/review、数字员工兼容；双库      | 135 pass / 0 fail，8 files                                                                             | `rfc396-compatibility-backend.txt`                                                                                       |
| 既有前端兼容                                       | 21 passed，4 files                                                                                     | `rfc396-compatibility-frontend.txt`                                                                                      |
| 共享合同兼容                                       | 96 pass / 0 fail，7 files                                                                              | `rfc396-compatibility-shared.txt`                                                                                        |
| 提案删除、真实 Git 上传、候选、发布和接口修复集合  | 首轮 44 pass / 6 fail；6 项来自重复 advanced control key                                               | `rfc396-backend-gate-repairs.txt`                                                                                        |
| 注册/HTTP/Case intake 修复复验                     | 11 pass / 0 fail，3 files                                                                              | `rfc396-intake-control-repair.txt`                                                                                       |
| 原始报告、候选/人工验收/发布/响应丢失重放；双库    | 16 pass / 0 fail                                                                                       | `rfc396-report-execution-tests.txt`                                                                                      |
| 工作区、证据和报告 UI                              | 8 passed                                                                                               | `rfc396-report-ui-tests.txt`                                                                                             |
| 原生等待态产物和人工回答导入；双库                 | 16 pass / 0 fail，44 assertions                                                                        | `rfc396-human-import-repair-2.txt`                                                                                       |
| 默认运行时配置与取消后立即重试竞争；含双库         | 9 pass / 0 fail                                                                                        | `rfc396-runtime-repair.txt`                                                                                              |
| 审核材料相对路径、恢复、上传；双库 × 单机/托管端口 | 4 pass / 0 fail，40 assertions                                                                         | `rfc396-relative-material-repair.txt`                                                                                    |
| 审核回执脚本使用生产 Node ESM 启动规则             | 1 pass / 0 fail                                                                                        | `rfc396-native-review-script-2.txt`                                                                                      |
| 审核证据重复消费与并发导入；双库                   | 16 pass / 0 fail，66 assertions                                                                        | `rfc396-review-replay-repair.txt`                                                                                        |
| 真实结构证据落库后崩溃恢复；双库                   | 2 pass / 0 fail，16 filtered                                                                           | `rfc396-verification-recovery-repair.txt`                                                                                |
| 类型、本次文件 lint 与构建                         | 前端类型、受影响文件 lint 和最新单二进制构建通过；后端最新检查有 16 条并发 WIP 诊断，本 RFC 路径无诊断 | `rfc396-frontend-type-report.txt`、`rfc396-backend-type-runtime.txt`、`rfc396-lint-replay.txt`、`rfc396-build-final.txt` |
| 独立功能实现门                                     | 首轮 5 P2 关闭；后续原生链路、运行时和证据恢复修复限定复核均通过                                       | [实现门记录](./implementation-gate.md)                                                                                   |
| 三条确定性浏览器旅程                               | 预约 1 passed（34.8s）；通知与已有模块 2 passed（48.8s），分别运行并保留结果                           | `rfc396-e2e-16.txt`、`rfc396-e2e-final-remaining.txt`；源码 `e2e/rfc396-graph-development.spec.ts`                       |
| 三条真实模型完整旅程                               | 未完成；预约已到原生人工澄清门                                                                         | 下节                                                                                                                     |
| 实现提交、hosted exact-SHA CI                      | `5f11d185754398c8d2aaa9307866a6b8643428ff` 已推送；首轮 CI 红，见下节                                  | [CI 39721967331](https://github.com/wangbinquan/agent-workflow/actions/runs/39721967331)                                 |

三个浏览器旅程覆盖原生人工回答、动态视图变化、短调用取消/重试、固定视图、320/390px 布局、冻结依据预览/导出、独立审核、代码候选、原始证据查看/下载、人工验收和终态后的后续工作。它们使用模型协议夹具，不能替代 AC17 的真实模型质量与完整旅程。最终构建包含后续证据恢复修复；该恢复分支另有双库针对性回归。

## 集中验收发现与修复

保留真实失败，不以重复运行碰绿：

1. 原生 Workflow 的模板变量不能使用 `design-model`；边的目标端口改用 `design_model`，输出端口保持业务合同名。
2. 平台 work item 曾重复包裹执行合同 envelope，修为业务原始 `{summary,result}`，由既有合同 owner 包裹一次。
3. 等待人工门时终态 Task 查询不返回已完成节点输出，改由 TaskExecution owner 查询已提交且 active 的 done node outputs。
4. 导入去重原来只看模型输出，模型不改设计时会跳过后续人工回答；导入标识现包含 Collaboration 的权威回答。保留未知责任与暂定判断，重复消费不产生新版本。
5. 浏览器夹具补齐现有澄清 API 的 `questionSetKey` 与每项 `confirmedBasis`；没有放宽产品校验。
6. 命令行第一次回答导入复验误用 PostgreSQL 环境变量，记录为 `8 pass / 1 fail`；改用既有 `AW_TEST_POSTGRESQL_URL` 后双库 `16 pass / 0 fail`。
7. 短调用原来使用 `resolveRuntimeByName(undefined)`，绕过已登记运行时，导致第 12 次本地夹具复验错误启动系统默认真实 `opencode`。按测试目录确认并停止该调用；现改为每次读取默认运行时并经 `resolveAgentRuntime` 选择登记的 binary/model。该失败运行不计为确定性夹具通过，也不计为真实模型验收。
8. 已取消调用的延迟清理可能删除立即重试的新控制器；清理现核对控制器身份，双库覆盖旧清理之后新调用仍可取消。
9. 审核材料合同原来带 Case 工作区绝对路径，进入 Workflow 节点隔离目录后不可读；材料目录和审核文档改为平台材料相对路径，单机/托管、双库真实文件读取与恢复回归通过。
10. 审核回执脚本原用 CommonJS require，而生产 Node 脚本执行器使用 ESM；修为 import，并用实际 INTERPRETER_SPEC 的扩展名与 argv 运行回归，不再使用会掩盖差异的 node -e。

`rfc396-backend-type-import.txt` 的后端类型检查未通过：诊断仅位于并发会话在制的 `iso-single-nonroot-member-replay.test.ts` 和 `single-nonroot-member-workspace.test.ts`（未定义 `db`、不匹配的测试 fixture 字段等）。本 RFC 没有修改或移除这些内容。该结果不记为全仓类型通过，后续 exact-SHA CI 仍须归因。后续 `rfc396-backend-type-runtime.txt` 有 16 条诊断，均位于并发 workspace/rollback 演进的测试及消费方，本 RFC 发布路径没有类型诊断。未代改、撤掉或提交这些在制文件。

11. 原生进度和终态消费重复保存相同审核证据时，真实 artifact owner 会分配不同引用，导致 identity conflict；现在复用首次保存的绑定，并检验并发落库的证据内容一致。结构证据的半完成恢复采用相同原则，保留原始产物而不重新生成冲突链接。

其余独立审查修复见实现门表，不隐藏初次失败记录。

## 首轮真实模型验收边界（历史快照）

使用 `opencode-go/deepseek-v4.1-flash` 与专用虚构预约需求、测试仓库。当前 Case `01M5GTZ28ESS39E82ET3CK0TKZ`，Task `01M5GTZ3AVPRH3T9306DCMXRM7`，原生澄清节点 `01M5GVC6NP67VH6CR6049YVFMP`。模型完成初始设计并提出优先级、并发表达和验证证据问题；这仅证明到达原生澄清门，尚不证明完整澄清→实现→验证→交付。

继续真实模型验收时，自动审批要求用户明确许可将这些验收材料发送到该外部模型服务。当时在当前会话请求许可并暂停新增真实模型调用；用户随后明确回复“1.这个不阻塞你 2.允许”，许可条件已解除，继续记录见 real-model-acceptance.md。这是当前验收执行限制，不是产品能力结论。异步通知与已有模块两条真实模型旅程尚未完成。

## 首轮 AC 证据归属（历史快照）

| 验收点           | 主要证据                                                                          | 尚缺的最终确认                       |
| ---------------- | --------------------------------------------------------------------------------- | ------------------------------------ |
| AC01、08、13、18 | 注册/intake/消费、原生 review、兼容与恢复测试、三个完整确定性浏览器旅程           | exact-SHA CI                         |
| AC02～07、12、15 | graph-domain、graph-planning、design-application、工作区 UI、原型与三个浏览器旅程 | 完整真实模型旅程                     |
| AC09～11         | implementation basis、真实 candidate/profile、有限行为执行、人工验收              | 真实模型实现结果与完整验收           |
| AC14             | 双库迁移/存储/应用测试，单机与托管执行端口 fixture                                | 实际部署旅程的证据边界需逐项收齐     |
| AC16             | 原始证据导出、真实 Git 发布与冲突/重放、浏览器完整交付                            | exact-SHA CI；未声称远端业务生产部署 |
| AC17             | 预约模型已到原生澄清门                                                            | 三个完整真实模型旅程                 |

未声称生产部署、远端业务仓库发布、长期认知效果或通用设计最优。所有未完成项关闭且 CI 结论明确之后才更新 RFC 最终状态。

## 首轮发布与 CI 修复（2026-10-21 本地 / 2026-10-22 UTC）

实现提交 `5f11d185754398c8d2aaa9307866a6b8643428ff` 已提交远端，142 个确切路径。发布后与远端同步；随后共享 main 正常包含 `ab9dcc36e` 与 `93332d3ea`。这些后继提交没有替代本 RFC 的 exact-SHA CI。

- 主 CI [39721967331](https://github.com/wangbinquan/agent-workflow/actions/runs/39721967331)：48 个工作 job 中 27 成功、21 失败；汇总 `CI required` 在取证时排队，不能宣称整体通过。全部 Linux/macOS 浏览器分片通过，Windows shard 3/4 的三个新增图旅程失败，其余 Windows 分片通过。
- [windows-platform 39721967315](https://github.com/wangbinquan/agent-workflow/actions/runs/39721967315)：验证命令工厂新增第二个消费者后，旧单消费者结构断言失败。
- [visual-regression-nightly 39721967294](https://github.com/wangbinquan/agent-workflow/actions/runs/39721967294)：58 通过，数字人类型目录 1 张基线变化。
- [git-protocols-e2e 39721967433](https://github.com/wangbinquan/agent-workflow/actions/runs/39721967433)、[integration-opencode 39721967290](https://github.com/wangbinquan/agent-workflow/actions/runs/39721967290)、[maintenance-soak-nightly 39721967287](https://github.com/wangbinquan/agent-workflow/actions/runs/39721967287) 成功。

| 首轮失败归因                                                         | 本轮处理与保留的断言                                                                                                                            |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 审核先解析坏快照盖过终态错误；新返回决定入口抛原始 JSON 错误         | 先做既有终态检查；与重跑路径共用 `workflow-snapshot-corrupt` 读取器，保留回放、准入及事务原逻辑                                                 |
| PostgreSQL 默认 NULL 排序不同                                        | 权威人工输入查询使用既有 `descNullsLast` 合同                                                                                                   |
| 新增五张内容表/迁移造成旧精确计数及最后一步切片过期                  | 明确 222 源表/216 active、261 迁移；逐一锁定五张图表；RFC-374 前缀定位 `0036_rfc374_node_run_seq`，继续证明真实历史升级                         |
| 新类型、图弹窗和第二个验证命令消费者未登记                           | 两种类型各初始化一次；原重复装配负面对照仍各两次；登记七个实际 Dialog 实例与确切工厂转发点                                                      |
| 22 个图 HTTP 路由未登记、两种错误缺少 HTTP 断言                      | 完整端点登记；真实应用中验证 404/422 错误码（422 断言纠正见下文）；MCP 逐叶登记当前 Case/UI 范围，未凭空声称新增外部模型工具                    |
| 公开类型直接派生整套装配；领域文件包含跨域适配/资源模板              | 明确 SourceControl DTO/参与者；HTTP 挂载不进入公共 DTO；类型注册/codec/内置资源移入 application，HTTP 归 infrastructure，组合根只构造完整参与者 |
| 能力台账、模式清单和 POSIX 夹具跳过项未同步                          | 配套既有机器清单，保留范围解释；不增加宽泛排除，不删除原用例                                                                                    |
| Windows 真实启动报 `ENAMETOOLONG`                                    | 完整图模型/schema 通过既有 `seedFiles` 物化到 invocation 工作区；命令行仅含材料路径，不截断材料；夹具读取同一文件                               |
| Windows 图旅程保存固定视图未完成即发起下一步，出现 revision conflict | 等待保存后的 `Unpin` 按钮可用，再提交绑定新 revision 的请求，不重试绕过版本检查                                                                 |

手工浏览器走查发现图类型总览仍显示旧研发类型的“工作区未准备”和 MR 承诺，已改为真实说明：目标仓库、冻结依据、候选和交付位于设计工作区。提案和短调用列表显示顺序/时间/用途，操作继续使用稳定 ID。新增总览回归后，本地三个完整旅程同一次执行 **3 passed（1.3m）**，日志 `rfc396-e2e-overview-final.txt`；这是后续 Windows 材料文件修复之前的候选证据。

视觉基线按仓库 README 的人工检查流程更新：Darwin 由精确目录用例生成并再次零差异通过，Linux 取自上述 exact-SHA artifact。已查看 actual/expected/diff，仅接受新增图类型卡片及随之发生的双列布局；已有的运行观测导航来自已提交旧功能，也保留在基线中。没有改变阈值或其他页面基线。日志 `rfc396-visual-darwin-update.txt`、`rfc396-visual-darwin-verify.txt`。

本轮早期修复验证：后端 58/0（5 files，含双库）、迁移针对性 2/0（261 assertions）、工厂接线 4/0、前端向导/弹窗清单 55 passed、总览与工作区 UI 16 passed，后端完整类型检查曾 exit 0。日志分别为 `rfc396-ci-backend-repair.txt`、`rfc396-ci-journal-repair.txt`、`rfc396-ci-verification-wiring.txt`、`rfc396-ci-frontend-repair.txt`、`rfc396-ui-overview-tests.txt`、`rfc396-ci-backend-type-repair.txt`。

随后 RFC-395 在共享树迁移 schema contribution，导致本轮复验出现 `RFC349_DEFER_TABLES` 导出不存在、schema 类型字段暂失、历史迁移接口在修改中的错误。保留 `rfc396-ci-repair-behavior-2.txt`（37 pass / 9 errors）及 `rfc396-ci-repair-contracts-2.txt`（62 pass / 5 fail，其中三项加载错误）原记录；这些不是本 RFC 新发布 SHA 的 CI，也不是可宣称的整套通过。图领域/HTTP 层次、公开面合同、组合根 holder、API 源码登记、skip 清单和能力账本在该轮对应检查通过。SourceControl 新 DTO 的错误导入另行归因并自行修正，未把它归到并发工作。

大请求和实际运行时选择的独立回归已通过，见 `rfc396-design-assist-transport.test.ts`、`rfc396-assist-transport-test.txt`。本次后端确切修复路径 lint 通过；最终修复候选仍须消费新的 hosted exact-SHA CI。共享 schema 清单测试的并发导入与本 RFC 五表断言完整保留，生成的 schema 报告与最终复验待共享依赖形成可运行候选后完成；不临时撤走他人产物制造绿树。

## 第二轮发布与 schema 报告补齐

修复提交 `b8d1f9fcc7f695655cb8112f2d4b103c5c5cdd6a` 已推送；推送后 `main == origin/main`、差异 `0/0`、共享 index 为空。此次仅提交明确的 64 个新旧路径名，未带入 RFC-395 的在制迁移。

该提交的 [主 CI 39725052164](https://github.com/wangbinquan/agent-workflow/actions/runs/39725052164)、[Windows 平台 39725052080](https://github.com/wangbinquan/agent-workflow/actions/runs/39725052080)、[视觉回归 39725052043](https://github.com/wangbinquan/agent-workflow/actions/runs/39725052043) 在本段取证时执行中；[integration-opencode 39725052079](https://github.com/wangbinquan/agent-workflow/actions/runs/39725052079) 成功。尚未宣称本轮整仓通过。

schema contribution 的导出修复后，重新生成 canonical JSON/Markdown。逐表比较确认原有 217 张表的全部合同字段不变，新增恰好为 `development_designs`、`development_design_revisions`、`development_design_proposals`、`development_design_baselines`、`development_design_links`。总数为 222 source / 216 active / 6 archive-only，digest 为 `sha256:3f8b275e388697cc6d9f5005dc3c9cf9acd70fe97c1bb00407223dfcf4d39743`。生成器读取当前共享 contribution，但此次报告不包含其他 schema 语义变化。

HTTP 适配器迁到 `infrastructure/http` 后，错误码覆盖扫描现继续显式包含其确切路径，避免移动文件使原有检查消失。该文件的四项检查全部通过。schema 联合检查首轮为 `10 pass / 2 fail`（`rfc396-schema-final-check.txt`）：本 RFC 五表名称断言遗漏排序，已修正；另一个失败为 RFC-395 新 schema 声明入口被原归档表 consumer 扫描识别，不改动其在制迁移。随后限定计数与生成报告两项复验 `2 pass / 0 fail`、26 assertions，见 `rfc396-schema-final-targeted.txt`。

共享 `tests/architecture/rfc349-schema-contract.test.ts` 同时包含本 RFC 的计数/五表断言与 RFC-395 的新 bootstrap 导入。完整保留这些改动；在其依赖仍未提交时，不单独发布这个共享文件制造缺依赖提交。canonical 报告和路由覆盖修复可独立发布；共享断言的发布及其 CI 仍需后续收齐。未重复运行全量本地 gate。

## Windows 旅程闭环与 HTTP 断言纠正

schema 报告与原路由覆盖扫描已经以 `baf4ac29317b67bc7ef9ebc0c32ffeb450882f9b` 推送；推送后 `main == origin/main`、差异 `0/0`、共享 index 为空。该提交的 [主 CI 39725816019](https://github.com/wangbinquan/agent-workflow/actions/runs/39725816019) 尚在执行。

生产修复候选 `b8d1f9fcc` 的 hosted 结果截至本段取证：

- [Windows 平台 39725052080](https://github.com/wangbinquan/agent-workflow/actions/runs/39725052080)、[视觉回归 39725052043](https://github.com/wangbinquan/agent-workflow/actions/runs/39725052043)（59 passed）及 [integration-opencode 39725052079](https://github.com/wangbinquan/agent-workflow/actions/runs/39725052079) 全部成功。
- 主 CI 的类型/lint/格式/shared/system mock、全部六个前端分片、真实 PostgreSQL、三种 OS 的生产二进制构建、三个 macOS 浏览器分片与四个 Windows 浏览器分片通过。
- [Windows shard 3/4，job 119653946843](https://github.com/wangbinquan/agent-workflow/actions/runs/39725052164/job/119653946843) 为 **138 passed**，明确包含预约 39.8s、通知 1.2m、已有模块 43.5s 三条完整 RFC-396 旅程。该结果验证了材料文件传递及 Pin 保存等待的实际 Windows 路径；仍是确定性 system mock，不能替代 AC17 的真实模型。
- 主 CI 当时为 43 个 job 成功、2 个失败、3 个 Linux 浏览器分片排队；不是整体绿。失败逐项如下。

| 失败 job                                                                                                               | 已确认根因                                                                                        | 处理                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| [119646933434，backend 12/24](https://github.com/wangbinquan/agent-workflow/actions/runs/39725052164/job/119646933434) | 217/211 的旧计数断言及旧 canonical 报告；1131 pass / 2 fail                                       | 报告已由 `baf4ac293` 更新；计数/五表断言在共享文件中完成，仍依赖 RFC-395 未提交导入，保留全部共同产出 |
| [119646933476，backend 16/24](https://github.com/wangbinquan/agent-workflow/actions/runs/39725052164/job/119646933476) | 本 RFC 新增 HTTP 断言误写 400；既有 `ValidationError` 一直定义为 422；1005 pass / 2 fail / 1 skip | 改正断言为 422，继续精确断言 `graph-request-invalid`；不改生产错误合同                                |

`baf4ac293` 的 [backend 16/24，job 119649325233](https://github.com/wangbinquan/agent-workflow/actions/runs/39725816019/job/119649325233) 是同一个尚未包含修复的 400/422 断言失败，未认领为其他原因。修复后的完整 HTTP 用例在本地 SQLite 与真实 PostgreSQL 同次复验 **2 pass / 0 fail，42 assertions**，日志 `rfc396-http-status-repair.txt`。复验包含读取、深链、原始证据导出、编辑、版本冲突、独立展示状态、历史版本与冻结依据导出，未缩成只检查状态码。后续 hosted exact-SHA 结果仍需收齐。

## 实现候选 CI 终态与剩余阻塞

实现修复提交 `fe835ab435b86e814ce48aafe9197dd2e08a4181` 的 [主 CI 39729036993](https://github.com/wangbinquan/agent-workflow/actions/runs/39729036993) 已结束：**47 个 job 成功、2 个 job 失败**。失败为 [backend 12/24，119659567973](https://github.com/wangbinquan/agent-workflow/actions/runs/39729036993/job/119659567973) 的一项旧表计数断言，以及据此失败的 `CI required` 汇总门；不是两个独立根因，也不是整体通过。

- [backend 16/24，119659568129](https://github.com/wangbinquan/agent-workflow/actions/runs/39729036993/job/119659568129)：**1007 pass / 0 fail / 1 skip**，包含 SQLite、PostgreSQL 两条完整 RFC-396 HTTP 用例，已证明 422 断言修复。
- 最新提交的类型/lint/格式/shared/system mock、全部前端分片、真实 PostgreSQL、三种 OS 二进制构建及 **Linux 3 + macOS 3 + Windows 4 个浏览器分片全部通过**。
- 同一失败 backend 分片内，canonical JSON/Markdown 与运行时合同一致性、表归属、digest、归档表边界与变异负面对照均通过；唯一失败仍为已提交旧测试的 `Expected length: 217 / Received length: 222`。日志为 `rfc396-ci-http-job-119659567973.txt`，完整 job 状态快照为 `rfc396-ci-final-fe835.json`。
- 前序 `b8d1f9fcc` 的主 CI 终态为 46 success / 3 failure（schema 与 HTTP 两个失败 job，加汇总门），其后真实缺陷和报告问题均已分别处置，未抹去历史失败。

以下是该候选终态时的三个未关闭事项；2026-10-22 用户已解除模型许可条件，并明确共享 schema 不阻止继续工作：

1. **共享 schema 断言发布**：工作区的 `packages/backend/tests/architecture/rfc349-schema-contract.test.ts` 已含 222/216 与精确五表断言；同时含 RFC-395 对未提交 `bootstrap/persistenceSchema.ts` 的新导入及其整组 contribution 依赖。需要依赖形成可发布状态后，再保留全部共同产出发布该文件并消费新 CI。此项仍是整仓 CI 的未关闭失败，用户明确不阻止本任务继续；不撤走、改回或单独提交会缺依赖的共享中间态。
2. **真实模型三场景**：材料发送许可现已获得，三个场景已实际调用配置的模型。首轮语义失败、8 分钟超时，以及实际调用揭示的最终端口取值缺陷均有原始记录；完整旅程与固定组合效果对照仍在执行，见 [真实验收](./real-model-acceptance.md)。
3. **实际托管执行证据**：AC14 要求真实接线和执行，并不要求自动部署业务应用。当前 `rfc396-workspace.test.ts` 真实执行双库、工作区/Git、材料和恢复路径，但 hosted helper 在测试进程内转发到 `executeWorkspaceTaskImageOperation`，不能替代实际托管传输与执行环境证据。因此保留该验收项，不以静态接线或该 fixture 冒签。

本次后续记录提交只更新 RFC 状态和证据，不改变 `fe835ab43` 的生产与测试候选。继续保持 **In Progress**；后继记录提交的 CI 与上述实现候选证据分别看待。

## 2026-10-22 真实调用揭示的结果收取修复

通知案例的 designer 和澄清后的 output 都发布 `agent-result`；原宿主按原始输出行顺序取首个同名端口，错误地重复消费首稿，导致 Task 已 done 而 Case 卡在 running。修复复用已有 `projectExecutionOutcome`，按工作流 output 节点和最新 settled run 取结果，保留 inactive/skipped/缺失端口语义。另将设计导入的 `ValidationError` 归为 semantic 失败回执；真实存储错误仍传播，避免吞掉基础设施问题。冻结材料补充 decision 人工来源、决策表规则引用、预算单位和验收义务规则，不修改已发布内置资源版本，也不放宽领域校验。

完成上述代码和用例后集中复验：同一 5 文件集合在 SQLite 与独立真实 PostgreSQL 分别 **20 pass / 0 fail / 116 assertions**，涵盖最终端口选择、两部署材料/恢复、原生人工来源导入、组合规划，以及既有 agent/workflow 真实子进程执行；相关架构 3 文件 **45 pass / 0 fail / 146 assertions**；backend typecheck、目标文件 ESLint 和格式检查通过。日志为 `rfc396-result-repair-{tests,postgresql,architecture,types,lint}.log`。本地测试使用保留 RFC-395 并发内容的共享工作区；其结果不是新候选 exact-SHA CI 或真实模型恢复验收。

### 大冻结依据提示传输修复（2026-10-22）

真实审核的 322 KB 提示触发 OpenCode 单参数限制。大提示改走已有 SpawnPlan stdin，完整材料不截断，小提示 argv 与直接 buildCommand 的有界校验保持原语义。真实子进程检验 CJK、多行、末尾哨兵，业务与系统装配均检验 stdin 和续跑 session 标识；对应两文件集中验证 **21 pass / 0 fail / 61 assertions**，目标 lint/格式通过。这是传输和装配范围的证据，不替代真实模型审核成功或全仓 CI。

## 2026-10-22 当前功能矩阵与剩余退出条件

| 验收点           | 当前证据与结果                                                                                                                                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC01、08、13、18 | 注册、原生协作门、执行合同、版本兼容及恢复用例通过；生产源码 67795ed462 的 exact-SHA CI 49/49 success。托管实际原文批准、重复请求身份、续跑和终态完整记录。实际恢复含有限运维配置操作，不宣称默认自动恢复已覆盖全部租约故障。 |
| AC02～07、12     | 领域、组合规划、过期读集、语义与布局分离、差异审阅、固定视图、原始人工来源测试和三条完整真实模型旅程通过；组合与有边界的固定对照见 adaptive-comparison.md。                                                                   |
| AC09～11         | 三个真实模型候选及托管候选分别有实际代码/测试、独立 profile 回执、basis/tree/profile/environment 绑定与原始日志；托管 transient unknown 与最终 current 均保留，未执行或读取失败未冒充通过。                                   |
| AC14             | SQLite/PostgreSQL 的实际回归、单机完整执行，以及托管 PostgreSQL/服务/任务传输/原生 review/profile/交付均有实际证据；本轮关闭，见 hosted-completion-evidence.json。                                                            |
| AC15             | 原三个确定性浏览器旅程覆盖桌面、320/390px、键盘和图/列表定位；托管实际页面完成原始证据读取。后者不替代此前窄屏和交互覆盖。                                                                                                    |
| AC16             | 实际 Case 页面可找到交付 commit 与原始报告；任务工作区普通 API 可读取代码/测试/脚本，clamp.ts blob 与候选 trace 一致。已有配置发布/冲突/重放测试保留；本托管案例 publication=null，没有声称业务远端发布或部署。               |
| AC17             | 三条实际 DeepSeek 完整旅程已交付，分别 24/0、44/0、13/0，原始失败及代理针对虚构案例作出的 provisional 判断保留。托管受控夹具不额外计入真实模型案例数量。                                                                      |

当前剩余项是 T15/T16 的共享 main CI 与最终状态收尾。前继 42611df21 的 CI 39848361400 为 47 success / 2 failure，所有功能 job 成功，整体 required 失败；407fb491 的 CI 39858220290 于 22:02:18 UTC completed / failure，同为 47 success / 2 failure：静态检查 job 120101856514 与 CI required 120114469860，所有功能 job success；静态项仅读取状态元数据，未读取 findings 或日志。本次收尾提交仍须消费自身 exact-SHA CI。未因文档收尾重复本地全量门禁、重跑业务测试或改动其他会话代码。功能证据完整不代表共享 CI 总绿，因此此记录仍不将 RFC 标为 Done。
