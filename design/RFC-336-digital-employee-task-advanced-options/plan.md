# RFC-336 实施计划：数字员工任务高级选项补齐

> 状态：Done（2026-08-28；T0～T10 已完成并通过远端 CI）
>
> current source pin：`234cfb2307602ced40bfb3279843843d6818997a`。共享 `main` 上 RFC-334 与 RFC-335 正在并行工作；
> 实施前必须重新 fetch、确认 `main/origin/main`、重采 target files 与 owner，不能覆盖或夹带其他 session 的输出。
>
> 发布边界：用户已授权完成生产实施后 commit/push；仍须遵守 shared-main 精确提交与 exact-SHA hosted CI 规则。

## 1. 实施原则

1. live 编排五项是来源 inventory；数字员工只补适用的四项，自动提交开关明确排除；先锁 current 行为，再抽共享组件。
2. 同一 candidate 里每项必须打通 UI → strict command → persistence/context → runtime/effect → detail/test。
3. Case controls 与 type options 分层；公共 UI/runtime/bootstrap 不写开发类型分支。
4. 协作者同 admission transaction；计量 exact-once；source branch 读取 frozen Context。
5. 自动提交、推送和 MR 是数字员工固定职责；UI/wire/Context 无开关，真实远端旅程证明发布链保持。
6. blank/default/legacy/event/child Case current 行为保持；任何不兼容先更新 RFC 并重新请批。
7. 与 RFC-334 重叠的 TaskExecution required-port/adapter 文件按 live source 重新落点，不覆盖其 node executor 迁移。
8. 只审功能与 owner 边界，不增加安全策略。

## 2. source-lock

### 2.1 baseline inventory

| ID  | current fact                           | source                                          | 目标退出                                 |
| --- | -------------------------------------- | ----------------------------------------------- | ---------------------------------------- |
| S1  | 编排高级值 builder                     | `frontend/routes/tasks.new.tsx#collectAdvanced` | 与共享 values/summary 对拍               |
| S2  | 编排高级 DOM                           | `tasks.new.tsx[data-testid=wizard-advanced]`    | 迁共享组件且行为不变                     |
| S3  | DE 内容/确认无高级区                   | `TaskCreationSubjectDescriptorContract.tsx`     | 同组件接入                               |
| S4  | DE strict intake 无 advanced           | `digital-employee/domain/runtimeModel.ts`       | strict v1 advanced + closed type options |
| S5  | Case row 无 limits/meters              | `db/schema.ts#employeeCases`                    | nullable limits + totals + ledger        |
| S6  | Case create 已有一个 store transaction | `sqliteRuntimeStore.ts#createCase`              | 初始 collaborators 同事务                |
| S7  | 成员模型已存在                         | `employeeCaseMembers` + RFC-330 service         | 复用，不造第二表                         |
| S8  | per-round 只有 duration                | `runtimeService#reactionExecutionPlan`          | remaining duration/token                 |
| S9  | internal Task 只收 round duration      | `digitalEmployeeExecution.ts#startInput`        | 两 limit + terminal metering receipt     |
| S10 | source branch 固定生成                 | `digitalEmployeeWorkspace.ts`                   | descriptor option + SC resolve/CAS       |
| S11 | publish-mr 总是发布                    | `digitalEmployeePlatformWorkItems.ts`           | 固定发布不变，数字员工开关=0             |
| S12 | unified Host/owner boundary            | RFC-310 §21.8/21.9、RFC-294                     | zero type/source branch in common layers |

### 2.2 T2 开工前重采

批准后、任何生产 edit 前必须：

- fetch `origin/main`，按 shared-main policy 安全同步或报告 concrete blocker；
- 检查 `git status --porcelain=v2`、target path dirty owners 与 cached diff；
- 重新定位 S1～S12 committed anchors；
- 检查 RFC-334 是否已经改变 Reaction execution required port、Task adapter 或 `digitalEmployeeExecution.ts`；
- 检查 RFC-335 migration 编号与 `_journal.json` 状态，选择当时未占用的下一编号；
- 固定本任务 exact file allowlist，任何并行同文件输出都原样保留并在交付说明。

若无法安全同步、target 同文件正在发生不可合并的并行变更或 migration 编号未稳定，暂停 Git 历史变更并协调；不 stash/reset/rebase/
worktree/临时 clone。

## 3. 实施波次

### T0 — current-source 调研与 RFC 三件套（本轮完成）

- 对拍 live 编排五项、DE UI/command/Case/store/runtime、内部 Task limits、研发 branch/publish 链；按用户裁决排除 DE 自动提交开关；
- 固定 proposal D1～D10、design、plan，其中 D8 已确认；
- 回链总索引与 STATE；
- 不改生产代码/schema/wire/UI/test。

退出：RFC Markdown link/format/source facts 自检通过；状态保持 Draft。

### T1 — 用户批准门（完成）

用户已确认 D1～D7、D9～D10；D8“固定自动提交发布、不要开关”此前已确认。批准内容包括：

- 数字员工四项 exact inventory 与 capability-driven 显示；
- 时长/Token 的 Case-local 累计口径和 child/wait 排除；
- explicit branch 对 missing/existing remote 的语义；
- 工作分支只改变 source branch，平台发布链固定执行。

退出：2026-08-28 已收到明确“批准实施，完成后提交上库到远端”，T2 生产实施已解锁。

### T2 — source-lock、characterization 与 red contracts

- 重采 S1～S12、migration/owner/CI baseline；
- 锁编排五项 DOM/payload/default/pref/summary current tests；
- 锁 DE current blank launch、default generated branch、always-publish journey；
- 新增目标 contract/red cases：DE advanced payload、atomic collaborators、limits ledger、capability branch、固定发布与 DE auto switch absence；
- 架构 red assertions 锁 common type/source branch=0、DE Task table read=0、TE Case table write=0。

退出：current characterization 绿，目标 red 只因能力尚未实现而红；无脆弱行号/散文计数替代 behavior。

### T3 — 共享高级设置 UI

- 建 `TaskCreationAdvancedSettings`、values/capabilities/validation/summary builder；
- 编排来源原子切换并删除旧 inline 高级 JSX；
- 数字员工内容/确认接入协作者、工作分支、时长、Token 四项；
- descriptor projection 只接 type-declared working-branch control；
- 处理 employee/type/source switch stale-state；数字员工不读取/写入 auto-publish pref，也不渲染开关。

退出：共享组件唯一；编排回归逐项相同；DE 有/无 capability DOM、visible errors、payload draft 与摘要测试绿。

### T4 — strict intake、migration 与原子 collaborators

- 扩 `employeeWorkIntakeSchema` 的 strict advanced envelope；
- 扩 type descriptor closed working-branch launchOption 与内置研发声明；
- migration 增 Case limit/meter 列及 metering ledger，更新 schema/meta/generated artifacts；
- `EmployeeCaseRecord`/store mapper/createCase 扩 limits + initialMembers；
- admission 在副作用前 canonicalize collaborator ids、limits 与 descriptor option types；
- createCase transaction 原子写 members/Case/uploads/Context/event/external subject。

退出：unknown/type mismatch/invalid limits 全部副作用前失败；fault injection 无半写；legacy/rolling migration 绿。

### T5 — Reaction limit planning 与 Task metering participant

- 扩 consumer-owned Reaction execution policy/request 的 remaining duration/token；
- TE adapter 映射到内部 Task `maxDurationMs/maxTotalTokens`；
- completed/failed/stopped 都返回 effective duration + total token metering；
- DE 先 exact-once apply receipt，再 retry/settle/plan next round；
- direct platform attempt 落 durable duration receipt；等待/child 路径不计；
- 用户 limit terminal 与 policy exhaustion 分开。

退出：三轮、多 attempt、human wait、platform attempt、child wait、crash replay、duplicate receipt、两个 limit 先后矩阵全绿。

### T6 — type-owned branch resolution

- 内置研发 type codec 把 canonical working-branch option 冻结进 primary Context；
- workspace plan 只从 Context 取 options；
- source-control participant 解析 generated/explicit missing/explicit existing branch 与 exact remote head；
- workspace row 冻结 branch/baseline/expected remote head；
- publish、feedback、conflict repair 全部复用同一 CAS lineage；MR target mismatch typed block。

退出：真实 remote fixtures 证明新建/续用/冲突分支语义；force/rebase=0；公共层无开发类型分支。

### T7 — 固定自动发布链回归

- 数字员工 UI、wire、Case row、type descriptor/Context 不新增 `autoCommitPush`；
- blank/显式工作分支都保持 current publish-mr body/effect/context/MR care；
- candidate validation 后固定 platform commit → CAS push → create/reuse MR；
- feedback/conflict repair 继续使用冻结 source branch 并固定发布；
- event/child/legacy Case 行为不变。

退出：真实 bare remote + provider fixture 证明两种 branch 输入都完成 current 发布旅程；数字员工 auto switch 的 DOM/wire/state/source 守卫全绿。

### T8 — Case detail 与可观察性

- query 投影 limits totals/remaining、collaborators 与 descriptor-approved option values；
- Case detail 展示四项高级设置与实际 source branch；
- 发布进度继续使用现有 candidate/commit/MR 投影，不新增 delivery mode 或未发布终态；
- WS/query invalidation 让成员、meter、terminal 变化及时刷新。

退出：创建确认值、持久值、运行结果和详情显示逐项一致；刷新/重启后不依赖前端 state。

### T9 — 集成、E2E 与架构回归

- frontend unit/RTL、backend domain/store/integration、migration/rolling tests；
- 真 Task runtime metering fixture；
- 真 bare remote + GitLab/GitHub system-mock 的 blank/显式 branch 固定发布 journey；
- 浏览器桌面/窄屏/键盘/focus/真实点击与截图检查；
- RFC-294/310 canonical architecture manifests/generators 更新且 guard 全绿。

退出：proposal AC-1～AC-14 均有 durable assertion；无 skipped/only/weak source regex 冒充功能证据。

### T10 — 候选验证、交付与 RFC 关闭

- 按 live `CLAUDE.md` 和用户当轮约束运行一次比例适当的 candidate checks，记录 task-related content；
- 发布如获授权，进入 shared-main 短临界区：fetch/sync、cached empty、exact-path stage、完整 staged diff/allowlist/trailer 复核；
- commit 后核对 path/message，不 amend 已发布历史；push 前后再次 fetch/对拍；
- 以 remote exact SHA 的 GitHub CI 为最终仓库 verdict，等待 terminal jobs；失败按 job/test/path 归因，只修本 RFC owner 内容；
- 全绿后更新 RFC/STATE/index 为 Done，记录 exact payload/provenance/CI；再次按授权发布 closure docs。

退出：本地 `main == origin/main` 或报告 concrete blocker；RFC-336 任务文件无未说明残留，所有并行输出原样保留并在 handoff 标注。

完成证据：

- 主实现 `07c7d37b4`，归一化/来源锁定 `1c296f3a4` / `287ea50fe`，测试/架构修复
  `e2bee56ae` / `f5e7833fd` / `aa32b65ad`，均已推送并为 `8e58eb05f` 祖先。
- containing SHA `8e58eb05f` 的 CI run `33142147682` 35/35 成功；visual run `33139682210`
  与 Windows run `33139296772` 均 1/1 成功。
- 提交按 exact allowlist 发布并验证路径/message/Codex trailer；共享文件中的 RFC-337 产出与并发
  RFC-287 架构守卫修复均原样保留。

## 4. 建议文件范围（批准后以 T2 live inventory 为准）

```text
design/RFC-336-digital-employee-task-advanced-options/*
STATE.md
design/plan.md

packages/shared/src/taskCreation.ts
packages/frontend/src/components/task-creation/TaskCreationAdvancedSettings.tsx
packages/frontend/src/components/task-creation/TaskCreationSubjectDescriptorContract.tsx
packages/frontend/src/routes/tasks.new.tsx
packages/frontend/src/components/digital-employees/types.ts
packages/frontend/src/i18n/{zh-CN,en-US}.ts
packages/frontend/tests/tasks-new-wizard.test.tsx
packages/frontend/tests/digital-employee-*.test.tsx

packages/backend/src/modules/digital-employee/domain/{model,runtimeModel}.ts
packages/backend/src/modules/digital-employee/application/{runtimeService,ports/runtimeStore}.ts
packages/backend/src/modules/digital-employee/infrastructure/sqliteRuntimeStore.ts
packages/backend/src/modules/digital-employee/composition.ts
packages/backend/src/modules/task-execution/composition/digitalEmployeeExecution.ts
packages/backend/src/modules/development-automation/composition/{employeeTypePackage,digitalEmployeeWorkspace,digitalEmployeePlatformWorkItems}.ts
packages/backend/src/db/schema.ts
packages/backend/db/migrations/<next-rfc336>.sql
packages/backend/db/migrations/meta/*
packages/backend/tests/**/rfc336-*.test.ts
e2e/rfc336-*.spec.ts
```

这是 owner/能力清单，不是 broad-stage allowlist。实施期按真实 diff 建立更窄 exact paths；若同文件包含并行贡献，保留完整文件并在
提交/handoff 明示，绝不为“单任务提交”删改别人的 hunks。

## 5. 停止条件

- 用户未批准或修改了 D1～D7、D9～D10；
- `main` 无法安全同步、shared index 有未知 staged entries、target 同文件存在不可协调并行发布；
- RFC-334 改变了 Reaction/Task participant，使 T5 owner/contract 与本文冲突；
- type descriptor 无法表达 capability 而必须在公共 runtime 按类型分支；
- 实现试图给数字员工引入 auto commit/push 开关或关闭发布的分支；
- limits 无法从 Task owner 得到 exact metering，只能深读 Task/NodeRun 表；
- 任何实现必须改变正常功能、权限/安全策略或使用 force/rebase 才能完成。

触发时先停、更新事实与 RFC、向用户重新请批，不以 fallback、双写、影子路径或静默忽略绕过。
