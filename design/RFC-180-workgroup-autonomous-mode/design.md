# RFC-180 工作组「全自动」模式 —— design

## 0. 范围

组定义新增单一 `autonomous` 开关；开启即关 clarify 反问邀请 + gate 视为关 + leader 空转自动 nudge（连续无进展到上限再泊人）。schema+prompt+引擎控流+前端开关。零答题权 / free_collab 语义改动。

## 1. 现状锚点（已核对源码）

| 事项                                               | 出处                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| 答题/确认权 = 任务成员（非 human 成员）            | `services/taskCollab.ts:67-76`、`db/schema.ts:1822-1826`            |
| human 成员→collaborator（启动时）                  | `services/workgroupLaunch.ts:134-142`                               |
| clarify 邀请恒 push（三 role）                     | `services/workgroupContext.ts:353`（`renderWgProtocolBlock`）       |
| completionGate 默认 true                           | `shared/schemas/workgroup.ts:153`                                   |
| gate 判定（declaredDone→awaiting_gate/done）       | `services/workgroupWake.ts:223`                                     |
| 确认端点（任务成员）                               | `routes/workgroupTasks.ts:439`                                      |
| leader-idle 泊人分支                               | `services/workgroupWake.ts:226-229`                                 |
| resolve 模式条件视图先例                           | `shared/schemas/workgroup.ts:257-265`（`resolveWorkgroupSwitches`） |
| WorkgroupForm 开关分区（含 completionGate Switch） | `components/workgroup/WorkgroupForm.tsx:89-141`（gate `:139-141`）  |
| 组 config 字段集                                   | `shared/schemas/workgroup.ts:134-161`（`workgroupConfigFields`）    |

## 2. 接口契约

### 2.1 schema（`shared/schemas/workgroup.ts`）

`workgroupConfigFields` 加：

```ts
autonomous: z.boolean().default(false),
```

`WorkgroupSchema` 加 `autonomous: z.boolean()`。migration ×1 给 `workgroups` 表加 `autonomous INTEGER NOT NULL DEFAULT 0`（bool 存 0/1）。

resolve 纯函数（单一事实源，table 测试）：

```ts
export function resolveCompletionGate(autonomous: boolean, storedGate: boolean): boolean {
  return autonomous ? false : storedGate // D3：autonomous 覆盖 gate
}
export function resolveClarifyEnabled(autonomous: boolean): boolean {
  return !autonomous // D3：autonomous 关反问邀请
}
```

> `completionGate` 存储值**保留**（关闭 autonomous 即恢复），仅派生视图被覆盖——同 `resolveWorkgroupSwitches` 对 fc 的处理。

### 2.2 prompt（`services/workgroupContext.ts`）

`renderWgProtocolBlock(role, config)` 末尾（`:353`）由无条件 push 改为条件：

```ts
if (resolveClarifyEnabled(...config.autonomous)) lines.push(WG_CLARIFY_BLOCK)
```

`WorkgroupRuntimeConfig` 需带 `autonomous`（`workgroupLaunch` 组装 runtime config 时透传，随任务快照，不改中途）。三 role（leader/worker/fc_member）统一受控。

### 2.3 引擎 gate 判定（`services/workgroupWake.ts:223`）

`decideWorkgroupOutcome` 里 leader `declaredDone` 分支的 `config.completionGate` 改读 `resolveCompletionGate(config.autonomous, config.completionGate)`：

- `resolve=false`（含 autonomous=true）→ `{kind:'done'}`（直接收尾，不 mint gate run）。
- `resolve=true` → 现状 `{kind:'awaiting_gate'}`。

### 2.4 引擎 leader-idle nudge（`services/workgroupWake.ts:226-229` + runner）

现状：leader 消费完、无派单、未宣告、无 humanPending → `{kind:'awaiting_human', reason:'leader-idle'}`。

改为（仅 `leader_worker` 且 `autonomous=true`）：

```
if autonomous && idle && nudgeCount < WG_AUTONOMOUS_NUDGE_LIMIT:
    → { kind: 'leader-nudge', nudgeCount }        // 新 outcome kind
else (非 autonomous，或 nudge 到上限):
    → { kind: 'awaiting_human', reason: 'leader-idle' }   // 现状兜底
```

runner 消费 `leader-nudge`：落一条**定向 leader 的 system 消息**（D5，形态对齐 RFC-176 kickoff 播种：`{authorKind:'system', kind:'chat', bodyMd:<nudge 文案>, mentionMemberIds:[leaderId]}`）→ kickResume/重跑 leader（leader 把 nudge 当「新活动」触发）。

**nudgeCount 与「进展」判定**：

- `nudgeCount` = **自上次进展以来**连续 leader-idle nudge 数。派生（不新增持久列）：数「最近一条非 nudge 的房间活动（派单/普通消息/宣告）之后」的 nudge system 消息条数——nudge 消息由平台落、可识别（`authorKind:'system'` + 约定 marker，见 §5）。
- 「进展」= leader 该轮产出新 assignment / 新 wg_messages / wg_decision done。有进展 → 下一趟 idle 从 0 起算（因为最近活动在 nudge 之后）。
- 双兜底：`nudgeCount < WG_AUTONOMOUS_NUDGE_LIMIT`（默认 3）**且** 恒受 `max_rounds` 约束（nudge 轮也是 leader 轮、计入 rounds）。

### 2.5 前端（`components/workgroup/WorkgroupForm.tsx`）

`sectionSwitches` 分区加一个「全自动」`<Switch>`（复用公共 `Switch`，`checked=value.autonomous`）。开启时：completionGate `<Switch>`（`:139-141`）`disabled` + 提示「全自动模式下不适用（宣告完成即收尾）」（mode/flag-conditional，同 fc all-on 的置灰处理）。房间侧信息卡 / 详情可加「全自动」`StatusChip` 徽标（复用现有 chip）。

## 3. 数据流

```
组定义 autonomous → 启动快照进 WorkgroupRuntimeConfig
  ├─ prompt：resolveClarifyEnabled → renderWgProtocolBlock 不 push clarify 邀请（三 role）
  ├─ gate：leader done → resolveCompletionGate=false → 直接 done（不 awaiting_review）
  └─ leader-idle：autonomous && nudgeCount<N → leader-nudge（落 system 催办 + 重跑 leader）
                  否则 → awaiting_human/leader-idle（兜底）
```

## 4. 与现有模块耦合点

| 模块                                     | 改动                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| `shared/schemas/workgroup.ts`            | +`autonomous` 字段 + `resolveCompletionGate`/`resolveClarifyEnabled`                   |
| `shared/schemas/workgroupRuntime.ts`     | `WorkgroupRuntimeConfig` 带 `autonomous`                                               |
| migration（新 0NNN）                     | `workgroups` +`autonomous` 列（statement-breakpoint；upgrade-rolling journal 计数 +1） |
| `services/workgroupLaunch.ts`            | 组装 runtime config 透传 `autonomous`                                                  |
| `services/workgroupContext.ts`           | `renderWgProtocolBlock` 条件 push clarify                                              |
| `services/workgroupWake.ts`              | gate 读 resolve + leader-idle nudge 分支 + `leader-nudge` outcome kind                 |
| `services/workgroupRunner.ts`            | 消费 `leader-nudge`：落 system 催办消息 + 重跑；nudgeCount 派生                        |
| `components/workgroup/WorkgroupForm.tsx` | +「全自动」Switch + gate 置灰                                                          |
| i18n                                     | 全自动开关 label/hint、gate 置灰提示、nudge 文案、徽标（zh+en 对称）                   |

## 5. 失败模式

- **nudge 无限循环**：`WG_AUTONOMOUS_NUDGE_LIMIT`（默认 3）+ `max_rounds` 双约束，到上限泊 `awaiting_human`。nudge system 消息带可识别 marker（约定前缀 / 专用 `kind` 复用），供 nudgeCount 派生**且**避免把 nudge 自身误判为「进展/新活动」造成计数不前进。
- **autonomous + storedGate 冲突**：`resolveCompletionGate` 单源覆盖，UI 置灰防误解，存储值不丢（关 autonomous 即恢复）。
- **升级已有组**：`autonomous` default false → clarify 邀请在、gate 按存储、leader-idle 直接泊——**零回归**（专测锁）。
- **free_collab**：无 leader → 无 leader-idle nudge；只 `resolveClarifyEnabled` 关邀请 + gate（fc 无 leader-done gate 路径，天然无影响）。测试覆盖 fc autonomous=on 仅影响 clarify 邀请。
- **dynamic_workflow**：autonomous 无效（mode-conditional），save 层不因 autonomous 报错（default false 无副作用）；不进 dynamic 生成/执行路径。
- **prompt 隔离**：`autonomous` 只入控流 / UI，绝不进 `compose*Prompt` 归属信息。

## 6. 测试策略（§测试策略）

必写 case：

1. `resolveCompletionGate` / `resolveClarifyEnabled` table：autonomous on/off × storedGate true/false（+ mode 无关性）。
2. prompt：`renderWgProtocolBlock` autonomous=true 三 role 输出无 `WG_CLARIFY_BLOCK`；autonomous=false 有（RFC-172 不回归）。
3. 引擎 gate：autonomous=true + leader done → `done`（无 gate run、无 awaiting_review）；autonomous=false + gate=true → awaiting_gate（现状）。
4. 引擎 nudge：autonomous=true + leader idle → `leader-nudge`（落 system 催办 + 重跑）；连续无进展到上限 → `awaiting_human`；中途有进展→计数重置；`max_rounds` 触顶优先。
5. 回归锁：autonomous=false 三条路径全维持现状（clarify 邀请 / gate / leader-idle 直接泊）。
6. 升级不回归：旧组（autonomous 缺省 false）行为不变。
7. migration：加列 + `upgrade-rolling` journal 计数 +1（title+断言+注释 N→N+1）。
8. 前端：`WorkgroupForm` 有「全自动」Switch、开启置灰 completionGate；i18n 对称。

Codex 设计门：批准前跑，findings 全折再请用户批准。
