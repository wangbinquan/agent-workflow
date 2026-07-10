# RFC-165 统一创建任务（Unified Task Creation）—— proposal

- **状态**：Draft（待用户批准）
- **日期**：2026-07-10
- **触发**：用户「现在添加了工作组之后，工作组也具备了创建任务的能力了……创建任务的时候，可以选择让单个 agent 来执行任务、选择工作流来执行、选择工作组来执行……创建任务的时候，要指定任务名、任务执行空间：临时空间（独立临时工作目录）、远端仓库（独立 workspace），下线现有的本地目录……现在的创建任务界面太复杂了，不好用，看下是不是可以有更好的 ux 设计」；追加「规划新建任务的入口：首页、任务列表、定时任务列表；创建任务也要考虑创建定时任务的能力」。
- **关联**：RFC-164（工作组，启动契约与宿主快照先例）、RFC-159（定时任务，编辑配置模式被本 RFC 吸收）、RFC-125（launch body 白名单静默丢字段教训）、RFC-066/024/068（多仓 / 远端 URL 缓存 / fetch 语义）、RFC-037（任务显示名）、RFC-130（节点隔离 worktree——scratch 回滚模型对齐）、RFC-104（builtin 资源不可手工执行）。
- **设计门**：Codex adversarial review **六轮收敛，终判 CLEAN-WITH-IMPLEMENTATION-NOTES（通过）**——①25 findings（10 high）全折；②13 closed/12 open+4 新增全折；③6 closed/10 open+5 新增全折；④12 closed/3 open+3 新增全折 + 6 条实现期备注（design.md §15）；⑤指定 6 项 6/6 closed + 1 新增（boot auto-resume 旁路）折算；⑥终验 CLOSED、复扫无新缺陷。逐条记录在 `design.md §14`。范围收窄一处：工作组宿主任务的 resume/节点 retry/lifecycle repair 复活/boot auto-resume 在本 RFC 均维持拒绝（引擎恢复语义属 RFC-164 领域，另行解锁；重启后停 `interrupted` 为已知限制）。

## 1. 背景与问题

当前「创建任务」的现状（调研结论，file:line 见 design.md）：

1. **入口唯一且藏得深**：全系统只有 `/workflows/$id/launch` 一个启动表单（`workflows.launch.tsx`，763 行），必须先进工作流编辑器才能启动；首页、`/tasks`、`/agents`、`/repos` 页均无创建入口；定时任务也只能从这个旧 launcher 的「存为定时任务」产生，`/scheduled` 列表页自身没有新建入口。
2. **执行主体即将三分**：RFC-164 已为工作组接好独立启动 API（`POST /api/workgroups/:name/tasks`，`goal` 必填），但前端启动页尚未落地（原计划 PR-4 T22 单独做一页）；「单个 agent 直接执行任务」则完全不存在——想跑一个 agent 必须先建一个单节点工作流。
3. **执行空间双轨且本地模式过时**：path 模式（本地目录 + `recent_repos`）是默认页签；URL 模式（clone 到 `~/.agent-workflow/repos/{slug}` 镜像 + 每任务独立 worktree）已经具备「远端仓库=独立 workspace」的全部能力。「临时空间」（无仓库的独立工作目录）没有任何模型支持——`repo_path`/`worktree_path`/`base_branch` 全部 NOT NULL。
4. **表单过载**：任务名、协作者、Git 身份、1..8 个仓库行（每行 path/url 两页签 × 3 控件）、工作分支、自动提交推送、fetchBeforeLaunch、N 个动态输入（五种控件）全部平铺一页，`canSubmit` 折叠 8 个谓词；`maxDurationMs`/`maxTotalTokens` 在 schema 里存在多年但从没有 UI。
5. **定时任务只覆盖工作流**：`scheduled_tasks.launchPayload` 整存 StartTask body，无执行主体概念；RFC-164 把工作组排除在 v1 定时之外（当时的范围取舍，非产品立场）。

## 2. 目标

- **G1 统一创建向导**：新建 `/tasks/new` 四步向导（①执行方式+对象 → ②执行空间 → ③名称+任务内容+高级设置 → ④只读确认后启动/保存），新建 `Stepper` 公共原语。
- **G2 执行主体三选一**：单个 Agent（新能力）/ 工作流 / 工作组（RFC-164）。内容字段按方式切换语义：Agent=任务描述（即提示词）、工作组=goal、工作流=`definition.inputs[]` 动态表单。
- **G3 执行空间收敛**：远端仓库（URL → 镜像 clone → 每任务独立 workspace，现有能力）| 临时空间（独立临时工作目录，新模型）。**全链路下线本地目录（path）模式**：wire 契约、UI、`recent_repos` 一并退役；本地仓以 `file://` URL 平移（`parseGitUrl` 已支持）。
- **G4 单 Agent 任务**：任务描述直接作为 agent 的任务提示词；默认可反问——语义为「**可问可不问**」（optional 指令；现有 clarify 边是强制先问，需最小运行时扩展，见 design §4/F12），高级设置里可关；复用既有任务底座（workspace/生命周期/取消/续跑/重试/协作者/diff），不新增运行引擎分支。
- **G5 高级配置收折叠**：协作者、Git 提交身份、工作分支+自动提交推送、多仓（第 2..8 个仓库）、时长/token 上限（本次补 UI）、允许反问（仅单 Agent）全部进第 3 步「高级设置」折叠区。
- **G6 入口全集**：**首页**（dashboard 快速操作「新建任务」）、**`/tasks` 列表**（「新建任务」主按钮）、**`/scheduled` 定时列表**（「新建定时任务」，进向导定时模式）三个通用入口；工作流编辑器 / 工作组详情 / Agent 详情提供「启动/运行」深链（预填执行方式与对象并落在第 2 步）；任务详情「再次启动」按主体深链；旧 `/workflows/$id/launch` 路由重定向；RFC-159「编辑定时任务配置」由向导吸收。
- **G7 存量平滑**：存量 path 型定时任务 `launchPayload` 在 daemon 启动期自动迁移——**path → `file://` 保真改写**（镜像 clone 自原路径，未推送分支/本地状态全保留；想换远端 origin 的用户在编辑页自改）；目录缺失/非 git 的禁用并给出明确提示；legacy payload 行保持可读可修可删（不因一行坏整表）；历史 path 任务行只读展示不受影响。
- **G8 定时任务一等能力（三主体）**：创建流程一等支持「存为定时任务」——三种执行主体都可定时（`scheduled_tasks` 增 `launch_kind` 判别，触发时分派到对应启动服务；工作组配置在每次触发时冻结，与手动启动同语义）；取代 RFC-164 的 v1 工作组定时排除。

## 3. 非目标

- 工作组含人类成员的启动（RFC-164 PR-5 解除临时守卫；向导与定时触发只负责把该 422 的原因外显）。
- 临时空间产物的打包下载（v1 复用 diff 视图 + 目录保留；zip 下载留待后续）。
- 启动时的模型/运行时/温度覆盖（单 Agent 任务用 agent 自身配置）。
- 工作组聊天室前端与 WS（RFC-164 PR-4 其余部分，不受本 RFC 影响）。
- 「独立持久 workspace 复用」（每任务仍独立 worktree/scratch 目录；跨任务共享 workspace 不在本期）。
- 定时任务的每次触发参数化（同一 payload 每次原样触发，现状语义）。

## 4. 用户故事

1. **单 Agent + 临时空间**：我要让 `researcher` agent 调研一个问题并产出报告文件。我在 `/tasks` 点「新建任务」→ 选「单个 Agent」+ `researcher` → 空间选「临时空间」→ 填任务名和描述 → 确认启动。任务跑完，diff 页签里是它新建的报告文件；agent 中途反问过一次，我在收件箱答复后它继续跑完。
2. **工作流 + 远端仓库**：我从工作流编辑器点「启动任务 →」，向导已经选好该工作流并停在第 2 步；我选远端仓库（URL 下拉里有上次用过的缓存仓）、填 ref，第 3 步填任务名和 inputs，确认页核对后启动。体验与旧 launcher 等价，但字段分层不再一页平铺。
3. **工作组 + goal**：我在工作组详情页点「启动任务」，向导预填了该组；第 3 步把组使命（goal）写清楚即可，成员/模式/开关来自组资源本体，无需在启动时重复配置。
4. **本地仓迁移**：我过去用本地路径 `/Users/me/proj/foo` 启动。下线后我改填 `file:///Users/me/proj/foo`（或它的远端 origin URL），行为等价（clone 镜像 + 独立 workspace，本地未推送分支照常可用）；我的旧 path 型定时任务在升级后自动转成了 `file://` 形式原样可跑，其中一个目录已被我删掉的被禁用并提示我重新选择仓库。
5. **定时的巡检 agent**：我在 `/scheduled` 点「新建定时任务」，向导定时模式选「单个 Agent」+ `auditor`、远端仓库、写好描述，末步填周期并保存。每晚触发时平台以我的身份启动一个该 agent 的任务；某晚 agent 被我改成私有导致不可见，那次触发记录 `lastError` 而不是静默吞掉。

## 5. 决策记录（2026-07-10 两轮 8 问 + 追加 2 项对齐）

| #   | 决策点                                   | 结论                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | UX 形态                                  | **分步向导（Stepper）**，否决单页渐进披露与「三个各自精简 launcher」。                                                                                                                                                                                               |
| D2  | 步骤划分                                 | **4 步：①执行方式 ②执行空间 ③任务内容 ④只读确认页**（确认页列全部配置摘要 + 各步「修改」回跳）。                                                                                                                                                                     |
| D3  | 本地目录下线范围                         | **全链路（公开面）**：wire 契约（`repoPath`/`baseBranch`/`fetchBeforeLaunch`）、UI、`recent_repos` 全部退役；本地仓走 `file://` URL；存量定时任务自动迁移（path→`file://` 保真）。框架内部启动面（fusion）走服务层 `internalSource`，不经公开契约（设计门 F4/F19）。 |
| D4  | 临时空间语义                             | **git init 空仓（含空根提交），三种执行方式都可用**；否决纯目录方案（会导致运行时 kind 散射）。                                                                                                                                                                      |
| D5  | 立项协调                                 | **新立 RFC-165**；RFC-164 PR-4 的 T22（独立工作组启动页）标 Superseded 改由本 RFC 提供；实现排在 164 PR-3 提交之后。                                                                                                                                                 |
| D6  | 高级设置内容                             | 保留多仓、Git 提交身份、协作者；**新增**时长/token 上限 UI；工作分支+自动提交推送默认保留（未在问题清单，随高级区迁移）。                                                                                                                                            |
| D7  | 单 Agent 能力边界                        | **支持反问；高级设置提供「允许反问」开关，默认开**；不做模型/运行时启动覆盖。反问语义=可问可不问（optional 指令，设计门 F12——现 clarify 边为强制先问，不采用）。                                                                                                     |
| D8  | 临时空间产出交付                         | **复用现有 diff 视图**（产出=对空根提交的 diff）；目录保留在 scratch 根下可手动取用，GC 策略并入 worktree 策略。                                                                                                                                                     |
| D9  | 深链与旧路由（session 自定，用户未反对） | 资源页深链预填后自动落在第 2 步（可回退）；`/workflows/$id/launch` 重定向到向导；RFC-159 编辑定时配置由向导吸收；执行空间默认「远端仓库」并记住上次选择。                                                                                                            |
| D10 | 入口全集（用户直令）                     | 通用入口三处：**首页 dashboard 快速操作、`/tasks` 列表主按钮、`/scheduled` 定时列表「新建定时任务」**；资源页深链与旧路由重定向照旧。                                                                                                                                |
| D11 | 定时任务覆盖范围                         | **三主体全支持**：`scheduled_tasks` 增 `launch_kind`，触发时分派 `startTask`/`startAgentTask`/`startWorkgroupTask`；工作组配置每次触发时冻结（与手动启动同语义）；取代 RFC-164 的 v1 排除。                                                                          |

## 6. 验收标准

1. 首页、`/tasks`、`/scheduled` 三个通用入口可进向导；三种执行方式均可完成创建并跑到终态（e2e 各一条最小链）。
2. 单 Agent 任务：描述即提示词（经合成快照的 `{{description}}` 注入）；默认可反问且**可不问**（optional 指令：agent 可直接产出不被拒，也可反问进 `awaiting_human` 并被答复唤醒）；高级设置关掉「允许反问」后合成快照不含 clarify 节点。
3. 临时空间：三种方式都能建；任务详情 diff 页签展示 Git 可见且非 `.gitignore` 的全部新建文件（截断口径=1,048,576 UTF-16 code units 带标记，沿现有 diff 面实现）；`autoCommitPush`/`workingBranch`/多仓在 schema 与 UI 双层被拒。
4. path 模式从公开 API 与 UI 完全消失（`StartTaskSchema` 无 `repoPath`、混合新旧 body 被 raw-key 拒收 422 而非静默降级、UI 无 path 页签，banned 锁 allowlist 化在册）；`file://` URL 可启动任务；fusion 内部启动链迁 `internalSource` 后回归不破。
5. 存量 path 型定时任务：目录健在且未开 `fetchBeforeLaunch` 的升级后自动转 `file://` 且可正常触发（未推送分支保真）；开了 `fetchBeforeLaunch` 的被禁用并提示确认语义后重存（file:// 不等价于「启动前刷新本地仓的 origin/\*」）；目录缺失的被禁用、`lastError` 说明原因；legacy/坏行不影响列表/详情/编辑/删除（逐字段 `migrationNeeded`/`migrationError`）。
6. 定时三主体：向导三分支均可「存为定时任务」；`/scheduled`「新建定时任务」进定时模式；触发按 `launch_kind` 正确分派（自动 fire 与 run-now 分开测试，run-now 不动触发记账）；触发期 ACL/就绪度失败落 `lastError` 不产任务、达既有阈值自动禁用（现状语义）；创建/修改 payload/立即运行受 `tasks:launch` 权限约束（堵 PAT 委托绕过）；编辑定时任务按 kind 锁定分支反填。
7. 旧 `/workflows/$id/launch`（含 `editScheduled` 参数）重定向进向导且功能等价；工作流编辑器/工作组详情/Agent 详情深链预填生效。
8. `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿 + 单二进制 build smoke + CI（两 OS）绿；每个 PR 过 Codex 增量审查。

## 7. 开放问题

无（两轮 8 问 + 追加 2 项已收敛；Codex 设计门第一轮 25 findings 已全折——见 design.md §14；实现期如遇 164 并行改动冲突，按 CLAUDE.md 多人协作原则停下询问）。
