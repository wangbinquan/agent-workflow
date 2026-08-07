# RFC-268 · 技术设计

状态：In Progress（2026-08-07 用户已批准；明确跳过外部设计门）。先读 `proposal.md` 的 D1–D12 与 AC；本篇定义 contract、分发数据流和验证边界。

## 0. 承重原则

1. **空间来源与事件上下文正交**：scratch 只替换任务文件系统来源，不删除或伪造 `CodeHostEvent`。
2. **单一 scratch 语义**：最终 payload 必须进入既有 `StartTaskSchema` / agent / workgroup 启动 schema；Webhook 层不自行初始化目录。
3. **无源仓就不碰源仓**：scratch 分支在调用 `resolveRepoForEvent` 之前完成，禁止“解析完再丢弃”。
4. **旧默认不变**：字段缺失等于事件仓，不引入需要回填的默认列。
5. **错误配置失败关闭**：远端专属选项不能被悄悄忽略；partial update 也必须校验合并后的完整候选。

## 1. 当前实现锚点

| 事实                       | 当前源码                                                                                                                                           |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook 模板 strict schema | `packages/shared/src/schemas/webhook.ts` 的 `CommonTemplateFields`、`Webhook*PayloadTemplateSchema`、`webhookPayloadTemplateSchemaFor`             |
| scratch 启动契约           | `packages/shared/src/schemas/task.ts` 的 `StartTaskSchema` 及 agent/workgroup 的 `applySpaceFields`                                                |
| 保存期 gate                | `packages/backend/src/services/webhook/triggerValidation.ts` 的 `assertTriggerSaveable`、`renderWebhookLaunch` 彩排、`assertScheduledTargetUsable` |
| create/update 合并         | `packages/backend/src/routes/webhookTriggers.ts`；update 已构造 `next` 完整 launch 候选，但当前未把 `autoRegisterRepos` 传进 gate                  |
| 事件仓解析                 | `packages/backend/src/services/webhook/webhookDispatch.ts` 的 `RepoResolution` / `resolveRepoForEvent`                                             |
| 启动渲染                   | 同文件 `renderWebhookLaunch`；当前三形态都注入 repo source，并在有事件分支时注入顶层 `ref`                                                         |
| fire 顺序                  | 同文件 `fireTrigger`：supersede → repo 解析 → owner/gate → `startExecution`                                                                        |
| scratch 物化               | backend 的 `materializeSpace` 链路；`<appHome>/scratch/<taskId>`、`git init main`、空 root commit、`spaceKind='scratch'`                           |
| Webhook 配置 UI            | `packages/frontend/src/components/webhooks/TriggersPanel.tsx` 的 `Draft`、`payloadOf`、`bodyOf`、四步向导与只读卡片                                |
| 公共空间选择原语           | `packages/frontend/src/components/ChoiceCards.tsx`；任务创建页已有 remote/scratch 交互先例                                                         |

## 2. Shared contract

### 2.1 Payload 形状

`CommonTemplateFields` 增加：

```ts
const CommonTemplateFields = {
  scratch: z.literal(true).optional(),
  workingBranch: z.string().optional(),
  autoCommitPush: z.boolean().optional(),
  maxDurationMs: z.number().int().positive().optional(),
  maxTotalTokens: z.number().int().positive().optional(),
} as const
```

选择 `z.literal(true).optional()` 而不是 `z.boolean().optional()`：

- `undefined` 是事件仓库的唯一 canonical 表达，保证旧 JSON 不重写；
- `true` 是临时空间的唯一表达；
- `false` 不产生第三种持久化形状，也避免读写端分别把 false 当“显式事件仓”或“未配置”。

workflow / agent / workgroup 三个 strict schema 共用同一字段与同一 cross-field refine：

```text
scratch === true && workingBranch !== undefined  -> scratch-remote-only-option
scratch === true && autoCommitPush !== undefined -> scratch-remote-only-option
```

这里沿 RFC-165 的**存在性**语义：`autoCommitPush: false` 也非法。false 虽不执行 push，但保留它会制造“这个选项在 scratch 是否被采纳”的歧义；调用方应删除字段。

现有 repo source/ref 禁令不变：`repoUrl`、`cachedRepoId`、`repoGroupId`、`sourceTaskId` 与 `ref` 仍不是 Webhook 模板字段；只有 fire 渲染器能组装最终源字段。

### 2.2 无新数据库列

模式持久化在现有 `webhook_triggers.launch_payload` JSON 中。`auto_register_repos` 列继续存在，但 scratch 行必须为 false。任务创建后仍由既有 `tasks.space_kind` 记录实际空间类型。

因此：

- migrations journal 不变；
- GET wire 只在 scratch 行的 `launchPayload` 多一个 `scratch: true`；
- 事件仓行、索引与审计表不变；
- fire outcome closed enum 不变。

### 2.3 类型注释改判

`schemas/webhook.ts` 当前注释写“repo 源（scratch/...）一律禁填”。实现时改成：

- `scratch: true` 是唯一允许由作者选择的空间源；
- 其它 repo source 与 `ref` 仍由 fire 动态注入或禁止；
- RFC-257 D17 的“事件仓即任务仓”由 RFC-268 扩展为双模式。

## 3. 保存期验证

### 3.1 `assertTriggerSaveable` 见到完整候选

候选类型增加 `autoRegisterRepos: boolean`。验证顺序：

1. `webhookPayloadTemplateSchemaFor(kind).parse(launchPayload)`；
2. 若 `payload.scratch === true && autoRegisterRepos !== false`，抛 `ValidationError('webhook-trigger-invalid', ...)`，issue code 为 `scratch-auto-register-conflict`；
3. 保留模板变量与 workflow 输入映射静态校验；
4. 选择彩排空间：scratch 模板传 `{kind:'scratch'}`，事件仓模板传既有 rehearsal URL；
5. 渲染后继续调用同一个 `assertScheduledTargetUsable`。

create schema 当前给 `autoRegisterRepos` 默认 true。因此 API 创建 scratch 触发器时必须显式传 false；服务端不会因看到 scratch 而悄悄改写调用方意图。

### 3.2 Partial update 不能绕过

`PUT /api/webhook-triggers/:id` 先从存量行和 patch 构造：

```ts
const next = {
  launchKind: row.launchKind,
  launchRefId: patch.launchRefId ?? row.launchRefId,
  launchPayload: patch.launchPayload ?? JSON.parse(row.launchPayload),
  eventTypes: patch.eventTypes ?? storedEventTypes,
  autoRegisterRepos: patch.autoRegisterRepos ?? row.autoRegisterRepos,
}
```

然后只对 `next` 跑保存门。以下两条都必须 422：

- 旧事件仓行 `autoRegisterRepos=true`，只 patch `launchPayload.scratch=true`；
- 旧 scratch 行，只 patch `autoRegisterRepos=true`。

### 3.3 并发 partial update

“校验完整候选，再只写 patch 字段”存在 TOCTOU：两个并发 PUT 可各自基于同一旧行通过，随后交错写出 `scratch=true + autoRegisterRepos=true`；同一问题也存在于既有的 payload × event-types × target-ref 静态校验。实现必须让**整组 launch 配置**的校验与写入具备冲突检测：

- launch-config 集合 = `launch_ref_id`、`launch_payload`、`event_types`、`auto_register_repos`（`launch_kind` 已不可变）；
- 当 patch 触及集合中任一字段时，UPDATE 的 WHERE 除 id 外还逐字节比较读取时的四个列值；
- 返回 0 行表示 launch 配置在验证后被并发修改，返回 409 `webhook-trigger-update-conflict`，调用方重新读取后重试；
- 不用全行 `updated_at` 作 CAS，因为 fire 会更新运行状态与 `updated_at`，高频事件不应让纯配置保存无故冲突；
- patch 不触及 launch-config 时无需该 CAS，它也无法破坏这组字段已经通过的联合校验。

该 launch-config CAS 不新增客户端版本字段，也不改变单请求行为；它只把原本的 silent lost update 变成可见冲突。

## 4. 启动空间与渲染

### 4.1 内部 union

保留 `RepoResolution` 负责真正的事件仓解析，另定义渲染器可接收的完整空间 union：

```ts
type WebhookLaunchSpace =
  | { kind: 'scratch' }
  | { kind: 'cached'; cachedRepoId: string }
  | { kind: 'url'; repoUrl: string }
```

`unregistered` 是解析失败结果，不是可渲染空间，仍在调用渲染器之前终结为 `skipped-repo-unregistered`。

### 4.2 共同空间字段

`renderWebhookLaunch` 先建立共同字段：

```ts
const spaceFields =
  space.kind === 'scratch'
    ? { scratch: true as const }
    : space.kind === 'cached'
      ? { cachedRepoId: space.cachedRepoId }
      : { repoUrl: space.repoUrl }

const refFields =
  space.kind !== 'scratch' && event.branch !== undefined ? { ref: event.branch } : {}
```

三种 launch kind 复用 `spaceFields` / `refFields`，禁止复制三套 scratch 判断。模板的 `workingBranch` / `autoCommitPush` 仍按字段存在性展开；保存 schema 已保证 scratch 路径不可能携带它们。最终 payload 必须由各启动 schema/gate 再验证，而不是信任类型断言。

### 4.3 事件变量不变

`eventVarsOf(event)`、任务名、workflow input mapping 在空间分支之前/之外计算：

- text 模板照常插值；
- agent `inputs`、`description` 与 workgroup `goal` 照常插值；
- workflow `event-branch` 仍打包为 `JSON.stringify({kind:'branch', ref:event.branch ?? ''})`；
- 顶层 `ref` 仅事件仓模式注入。

这一区分必须被测试锁住：git-kind input 的 branch 是用户输入数据，不是 scratch 的 Git checkout 指令。事件没有 branch（例如 GitHub 普通 PR 评论）时，既有打包结果仍是空 ref，并由运行期 workflow input gate 判 `git-value-invalid`；scratch 不合成 default branch，也不改变 RFC-259 已记档的失败组合。

## 5. Fire 数据流

```text
delivery + matched ParsedTrigger
  │
  ├─ keyed mutex / circuit / supersede                 （不变）
  │
  ├─ payloadTemplate.scratch === true ?
  │      ├─ yes → WebhookLaunchSpace {kind:'scratch'}  （零 repo lookup/clone）
  │      └─ no  → resolveRepoForEvent(...)
  │                 └─ unregistered → skipped-repo-unregistered
  │
  ├─ rebuild current owner actor                       （不变）
  ├─ renderWebhookLaunch(event, launchSpace)
  ├─ assertScheduledTargetUsable                       （同一 gate）
  └─ startExecution                                    （同一唯一收口）
         └─ existing materializeSpace → scratch repo
```

关键顺序：scratch 判定必须早于 `resolveRepoForEvent`。不能先调用 resolver 再覆盖结果，否则仍会发生缓存查询、解密、凭据读取或 clone。

### 5.1 同一代 launch 配置

dispatcher 首次查询并 `parseTriggerRow` 后得到一次匹配快照。空间模式、payload 模板与事件仓自动注册值必须来自这次快照：

```text
launchSnapshot = {
  payloadTemplate: parsed.payloadTemplate,
  autoRegisterRepos: parsed.row.autoRegisterRepos
}
```

队列内的 fresh row 继续负责“现在是否 enabled”、owner、名称和熔断上限等动态状态；不能用 fresh `autoRegisterRepos` 搭配旧 `payloadTemplate`，否则管理员在事件排队期间切换空间时会得到混合代配置。编辑只影响下一次尚未匹配的投递，这是可解释的 snapshot 语义。

## 6. 失败与恢复

| 场景                                             | 结果                                                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| scratch 配置含远端专属字段                       | 保存 422 `webhook-trigger-invalid`                                                                 |
| scratch + auto-register true                     | 保存 422，零持久化                                                                                 |
| 并发 PUT 竞争 launchPayload/autoRegister         | 其中一个 409 `webhook-trigger-update-conflict`，重读重试                                           |
| 旧二进制读取 scratch 行                          | strict parse 失败，dispatcher 跳过该触发器；不产生错仓任务                                         |
| scratch 初始化失败                               | 走既有 launch error/cleanup；fire 为 `launch-failed`，不新增 outcome                               |
| scratch + required event-branch，但事件无 branch | 既有 workflow input gate 拒绝并记 `launch-failed`；不猜默认分支                                    |
| 目标或 owner 失效                                | 走既有 `skipped-owner-invalid`                                                                     |
| scratch 任务被 supersede                         | 既有 cancel/cleanup；已经发生的外部 HTTP/MCP 副作用不回滚                                          |
| 手工篡改 DB 为 scratch + auto-register true      | dispatcher 仍以 `scratch` 为最高优先级并绕过 resolver；告警/管理面下次保存修复，不允许降级到事件仓 |

最后一行是 defense in depth：保存门保护正常写入，fire 分支保护手工 DB 修改或旧 bug 遗留行。

## 7. 前端设计

### 7.1 Draft 与序列化

`Draft` 增加 UI 专用枚举：

```ts
space: 'event-repo' | 'scratch'
```

- `EMPTY_DRAFT.space = 'event-repo'`；
- `draftFromRow` 仅在 `launchPayload.scratch === true` 时读成 scratch；
- `payloadOf` 对三种 kind 共用地追加 `scratch: true`，事件仓则完全省略该键；
- `bodyOf` 在 scratch 时固定发送 `autoRegisterRepos: false`；事件仓发送 draft 的当前值。

选择 scratch 时立即把 draft 的 `autoRegisterRepos` 设 false。切回事件仓时保持 false，不自动恢复网络 clone；管理员若需要，显式重新开启。

### 7.2 位置与公共组件

四步向导不增加第五步。在“目标”步骤中，目标类型/目标资源之后增加执行空间 `<Field>`，复用公共 `<ChoiceCards>`：

- **事件仓库**：使用事件中的仓库与分支；未缓存时可自动注册；适合审查、修改和 push。
- **临时空间**：创建空 Git 仓库；只保留事件参数；没有事件仓文件、remote 或自动 push。

复核步骤：

- summary 增加“执行空间”行；
- 仅事件仓模式显示 `autoRegisterRepos` Switch；
- scratch 显示 info notice，明确空仓与分支元数据语义；
- 现有熔断提示保留。

触发器列表/只读卡片增加一个 `StatusChip` 或等价公共 chip 展示空间模式。RFC-260 只读用户必须看到，不增加管理操作；`launchPayload === null` 的坏行只显示既有“配置损坏”标识，不得猜成事件仓。

不复制任务创建页的私有 icon 函数；若公共图标库没有合适项，ChoiceCards 允许无图标，文字与说明承担语义。

### 7.3 i18n 与响应式

- `zh-CN.ts` / `en-US.ts` 同步新增空间 label、说明、summary、chip、scratch notice；
- 文案使用“事件仓库 / Event repository”，不写“远端仓库”，因为事件仓可能命中本地 cache；
- 复用现有 form/grid/chip 样式，优先零新 CSS；若 390px 卡片需要布局修复，只加最小响应式规则；
- 键盘、focus ring、触摸目标由 ChoiceCards/Switch/Dialog 公共原语继承。

## 8. 安全与权限

- 权限不变：创建/编辑仍受 Webhook trigger 权限与 `tasks:execute` 约束，fire 仍以 owner 身份重建 actor。
- scratch 减少 Git 凭据暴露面：不解析、不解密、不使用事件仓 URL，也不创建 remote。
- scratch **不**授予额外 MCP、token、环境变量或网络能力；实际能力仍由目标定义与执行 containment 决定。
- repo scope/branch filter 仍是触发规则，不是文件授权证明；选 scratch 不会让一条规则跨过其 endpoint/repo 匹配范围。
- 任务内输出与事件模板可能包含敏感 webhook 数据，仍走既有 task 可见性与日志掩码；本 RFC 不扩大原始 payload 注入面。

## 9. 兼容性

| 方向                   | 行为                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 新代码 + 旧事件仓行    | `scratch` 缺失，行为不变                                                                                                                        |
| 新代码 + 新 scratch 行 | 正常空仓启动                                                                                                                                    |
| 旧代码 + 新 scratch 行 | strict payload parse 失败，触发器被跳过（fail closed）                                                                                          |
| 新前端 + 旧后端        | 保存 scratch 时后端 strict schema 422；不会误存                                                                                                 |
| 旧前端 + 新后端        | 只能创建/编辑事件仓形态；读取 scratch 行时未知字段仍保留在原 row，但旧 UI 若保存可能移除它，因此回滚/混用版本不受支持，发布说明要求前后端同版本 |

RFC-257 proposal D17 与 design §5.1 保留历史原文，实施时加“RFC-268 起可显式选择 scratch；缺省仍为事件仓”的注记。`docs/webhook-triggers.md` 同步改成双模式，不提前文档化未发布能力。

## 10. 测试策略

### 10.1 Shared

1. 三种 Webhook template 接受 `scratch:true`；canonical 输出不产生 false。
2. 三种模板各锁 `workingBranch`、`autoCommitPush:true/false` 冲突。
3. repo source/ref/未知键继续被 strict 拒绝。
4. 既有无 scratch fixture 深等值不变。

### 10.2 Backend 保存/API

1. create scratch 显式 auto-register false 成功；true/省略均 422。
2. update 从 event-repo → scratch 必须同请求关闭 auto-register；反向可成功。
3. partial patch 单改 payload 或单开 auto-register 不能构成非法组合。
4. 两个并发 PUT 的确定性屏障测试覆盖 payload × event-types × target-ref × auto-register，证明 launch-config CAS：最多一个成功，另一个 409，最终行始终是已联合校验的一代配置。
5. 保存彩排三种 kind 都使用 scratch arm 并通过既有 target gate。

### 10.3 Backend dispatch/integration

1. `renderWebhookLaunch` × 三种 kind × 两种空间矩阵；scratch 断言无 repo/ref/remote-only 字段。
2. 未缓存仓 + auto-register false：scratch launched、resolver 零调用；event-repo skipped。
3. 三种 kind 各一次真实 `startExecution`，任务行 `spaceKind='scratch'`，磁盘 oracle 验证 main/空 root/no remote/no事件文件。
4. 模板变量与 `event-branch` 在 scratch 下照常渲染；有 branch 的正例与无 branch 的既有 launch-failed 反例都锁住。
5. 排队期间切换模式的 barrier 测试，证明 payload 与 auto-register 来自同一 matched snapshot。
6. scratch 的 supersede / circuit 至少各一条回归；既有事件仓 dispatch 套件原断言不改仍绿。
7. 手工非法行 `scratch + autoRegister=true` 仍不调用 resolver，证明 defense in depth。

### 10.4 Frontend / E2E

1. 新建默认事件仓；旧行显示事件仓；scratch 行 round-trip。
2. ChoiceCards 切换后 request body 精确断言：scratch true + auto-register false；切回移除 scratch。
3. scratch 隐藏 auto-register，复核 summary/notice 与只读卡片 chip 正确。
4. zh-CN/en-US i18n 类型门；无字面用户文案。
5. 真实浏览器 1536×960 与 390×844，light/dark 各检查选择、复核、卡片，无横向溢出与截断。

### 10.5 门禁

- 定向 shared/backend/frontend tests；
- `bun run typecheck`、`bun run lint`、`bun run format:check`；
- `bun run gate:local` 全量；
- 实现完成后跑仓规 Codex 实现门，并把 findings/驳回理由记档。
