# RFC-153 技术设计 — 取消 runtime 内置区分

## 数据模型

删 `runtimes.builtin`（schema.ts:103）。migration **0078**（HEAD=0077）走标准 **12-step
rebuild**——bun:sqlite 的 bundled SQLite 无 in-place `DROP COLUMN`，参照 0072（RFC-130 删
`agents.readonly`）/ 0058 / 0041：

```
PRAGMA foreign_keys=OFF;
CREATE TABLE `__new_runtimes` ( … 镜像 runtimes 全列 MINUS builtin … );
INSERT INTO `__new_runtimes` (显式列名) SELECT (显式列名) FROM `runtimes`;
DROP TABLE `runtimes`;
ALTER TABLE `__new_runtimes` RENAME TO `runtimes`;
CREATE UNIQUE INDEX `runtimes_name_unique` ON `runtimes` (`name`);
PRAGMA foreign_keys=ON;
```

每条语句 `--> statement-breakpoint`（[记忆 migration-statement-breakpoint]）。镜像列（MINUS
builtin，源 schema.ts:98-130 + 建表迁移 0055）：`id / name / protocol / binary_path /
enabled / model / variant / temperature / steps / max_steps / last_probe_json /
created_by / created_at / updated_at`。列名显式两侧对齐，防 builtin 偷偷回潮。

**无数据保留问题**：builtin 是标记、作为概念删除（同 0072 的 readonly「remove as a concept,
not re-homed」），无 pre-drop guard。既有行的 model / binary / enabled 等数据全部保留。
journal 77→78。

## 服务层（runtimeRegistry.ts）

| 位置                                                                           | 现状                                                | 改动                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------ | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assertNotBuiltinRuntime` (:250-257)                                           | 内置只读守卫                                        | **删除**                                                                                                                                                                                                                    |
| `deleteRuntime` (:453)                                                         | 调 `assertNotBuiltinRuntime(row)`                   | **删该调用**；保留 `findRuntimeReferences`（agent / default 引用 → 409 `runtime-in-use`）                                                                                                                                   |
| `findRuntimeReferences` (:291-301)                                             | `isDefault: defaultRuntimeName === name`            | **F1 修复**：改 `(defaultRuntimeName ?? 'opencode') === name`（折叠 effective default，对齐 `setRuntimeEnabled`）；否则 config.defaultRuntime 未设时删 opencode 不被挡 → claude-code 让表非空 → seed no-op → 无 opencode 行 |
| `validateName` (:265-269)                                                      | `BUILTIN_NAMES.has(name)` → `runtime-name-reserved` | **删该 check**（解除保留名）；`RUNTIME_NAME_RE` 格式校验保留                                                                                                                                                                |
| `createRuntime` (:352-361)                                                     | 插入 `builtin: false`                               | **删该字段**                                                                                                                                                                                                                |
| `RuntimeRow` (:52-64) / `RuntimeView` (:80-92) / `runtimeRowToView` (:112-136) | 含 builtin                                          | **删字段 + 映射**                                                                                                                                                                                                           |
| `seedBuiltinRuntimes` (:481-500)                                               | upsert + identity-reset 分支                        | **改语义**（见下）                                                                                                                                                                                                          |
| `assertConfigDefaultsMigrated` (:573)                                          | `.where(eq(runtimes.builtin, true))`                | **F3 修复**：改查两个协议默认行（`name in BUILTIN_NAMES ∧ protocol === name`）——预置行 name===protocol 且 protocol immutable，排除用户自建同名撞车行污染「迁移已跑」判据                                                    |
| `migrateConfigIntoBuiltins` (:510-527)                                         | 按 name backfill binary_path                        | **F2 修复**：backfill 加 protocol 校验（仅 `row.protocol === 期望协议` 时写）——解除保留名后防把 opencode binary 写进用户自建 name=opencode/protocol=claude-code 行                                                          |

### seed 语义变更（核心）

用户拍板「库为空时才首次预置，删了不补种」。判据 = **整表为空**（`length === 0`），
**不是**「opencode 行缺失」：

```ts
export async function seedBuiltinRuntimes(db: DbClient): Promise<void> {
  const existing = await listRuntimes(db)
  if (existing.length > 0) return // 非空 → 完全不动（含用户删过预置行的情形）
  for (const b of BUILTIN_RUNTIMES) {
    await db
      .insert(runtimes)
      .values({ id: ulid(), name: b.name, protocol: b.protocol, binaryPath: null })
  }
}
```

删除原 upsert 的 identity-reset 分支（:488-497）——不再有 builtin 概念可 reset；预置行既然
可删，也就没有「纠正被用户抢占的保留名」的必要。`cli/start.ts:266-272` 调用点不变（仍
`seedBuiltinRuntimes` + `migrateConfigIntoBuiltins`，语义由函数内部改变）。

### 命名取舍（明确记录）

`seedBuiltinRuntimes` / `BUILTIN_NAMES` / `BUILTIN_RUNTIMES` 内部符号**保留原名**：

- 它们描述「框架预置的默认 runtime 名（= 协议名，派生自 DRIVERS 注册表）」，语义仍成立。
- `BUILTIN_NAMES` 更是 `resolveRuntimeByName` 的 dispatch 兜底命脉（非目标，保留）。
- 用户要清理的是**用户可见的「内置 vs 非内置」区别对待**（DB 列 + 徽章 + 只读 / 保留名 /
  补种行为），而非代码里每个 Builtin 字样。

仅在注释里澄清「这不再是只读标记，是框架首启预置的默认 runtime」。若后续要连符号名一并
去 Builtin 字样，另开 follow-up（避免与并行 G4-G10 抢 runtime 文件重命名）。

## 路由层（routes/runtimes.ts）

不直接引用 builtin 列（调 service）。`runtimeRowToView` 去 builtin 后 GET 响应自然不含该
字段；`deleteRuntime` 的内置保护在 service 层已删。**无路由逻辑改动**。

## 前端

- `RuntimeList.tsx`：
  - `RuntimeView` interface 删 `builtin` (:51)；
  - 删「内置」徽章块 (:172-176)；
  - 删除按钮去掉 `!rt.builtin` 门槛 (:232) → 所有行显示删除（后端 `findRuntimeReferences`
    引用保护兜底，被引用则 409 + ErrorBanner）；
  - 相关注释（模块头 :6-8、:214-217）更新。
- i18n：删 `runtimes.builtin` key（en-US.ts:632 / zh-CN.ts:3123 + 类型声明 zh-CN.ts:741）。
- `HomepageGreeting.tsx`（:113-161）/ `agents.tsx`（:42-46）：用 `isDefault`，**不动**。

## 失败模式

> **设计门修订（Codex adversarial-review 2026-07-08，3 × high）**：`builtin` 列除「只读标签」外，
> 还隐式充当「框架预置行的 canonical 身份」，被三处 name/default 机制依赖。删列前必须恢复
> canonical 判定——预置行 `name===protocol` 且 protocol immutable，(name,protocol) 对可把用户
> 自建的撞名行排除。F1/F2/F3 修法见服务层表。

1. **删除 effective default（opencode）**〔F1〕：`findRuntimeReferences` 原判据
   `defaultRuntimeName === name` **未折叠 unset→opencode**——config.defaultRuntime 未设时删
   opencode 不被挡，claude-code 又让表非空 → seed no-op → 无 opencode 行、dispatch 静默落
   NULL_PROFILE 兜底。修：`isDefault` 用 effective default `?? 'opencode'`（对齐
   `setRuntimeEnabled`）→ 恒 409 `runtime-in-use`。
2. **删除被 agent 引用的 runtime**：`findRuntimeReferences` 检 `agentNames` → 409。保留。
3. **dispatch 引用已删 runtime 名**：`resolveRuntimeByName` 的 `BUILTIN_NAMES` 兜底（协议名
   → driver + NULL_PROFILE）保证不 brick；非协议名 → fallback opencode（既有 + warn）。
4. **创建 opencode 同名**：预置行仍在 → `createRuntime` existing check → 409
   `runtime-exists`（既有，name unique）；已删 → 允许创建（预期）。
5. **name backfill 污染**〔F2〕：解除保留名后用户可建 name=opencode/protocol=claude-code 行；
   `migrateConfigIntoBuiltins` 原按 name backfill 会把 opencode binary 写进它。修：backfill 加
   protocol 校验（仅协议匹配才写）。
6. **RFC-115 守卫误判**〔F3〕：`assertConfigDefaultsMigrated` 原按 name 查会把用户自建同名行的
   profile 当「迁移已跑」证据 → 可能放行并丢 legacy defaults。修：加 `protocol === name` 校验。
   守卫真正服务的「pre-RFC-113 首升」场景下 runtimes 表本次启动才全新 seed、无用户污染（与
   删/建同名的时间窗互斥），故 canonical (name,protocol) 判据准确。
7. **升级路径**：删列 rebuild 保留所有行数据（含 admin 已配 model / binary）。

## 测试策略

- **服务**：seed 空表建两行 / 非空 no-op（删过预置行也不补）；删除预置 runtime 成功；删
  被 agent 引用 → 409；保留名解除后可创建 opencode / claude-code 同名（现存则 409
  `runtime-exists`）。
- **设计门 3 回归**：
  - **F1**：删 opencode 且 `config.defaultRuntime` 未设 → 409（effective default 折叠）。
  - **F2**：存在 name=opencode/protocol=claude-code 的用户行时，`migrateConfigIntoBuiltins`
    **不**把 config.opencodePath 写进它（protocol 不匹配）。
  - **F3**：同上撞名行的 profile **不**让 `assertConfigDefaultsMigrated` 放行（仍按真正的
    协议默认行判 → legacy 存在且真预置行 profile 全空则仍 abort）。
- **model 端到端**（呼应用户原问）：给预置 opencode runtime 配 model → freeze 进
  `runtime_params_json` → `buildInlineConfig` 带上 `agent.opencode.model`；不配 → 省略。
- **迁移**：0078 rebuild 保数据 + `builtin` 列消失；`upgrade-rolling` journal 77→78 +
  注释计数 bump（[记忆 migration-bumps-journal-count-test]）。
- **前端**：RuntimeList 无「内置」徽章 + 删除按钮对预置行显示 + RuntimeView 无 builtin。
- **边界锁**：`rfc104-builtin-readonly.test.ts`（agents / workflows / skill）零回归——本 RFC
  不触碰 `systemResources.ts` / `resourceAcl.ts` 的 builtin。

## 现有测试翻转清单

- `runtime-registry.test.ts`：`oc.builtin===true`（:48/:51/:75）、`row.builtin===false`（:98）
  删；`resets IDENTITY (protocol/builtin)`（:60-75）重写为「表非空 seed 不改已有行」；
  `built-in delete is 403 read-only`（:151-153）**反转**为「预置 runtime 可删（解除引用后
  200）」；`seedBuiltinRuntimes does NOT re-enable disabled builtin`（:268）改为幂等语义
  （表非空第二次 seed 完全 no-op）。
- `runtime-routes-registry.test.ts`：`.every((r) => r.builtin)`（:90）删；opencode PUT 200 +
  model=sonnet（:139-144）保留；`DELETE … built-in → 403`（:147-152）改为「预置可删 /
  被引用 409」。
- `rfc115-config-defaults-guard.test.ts` / `rfc135-runtimes-status.test.ts` /
  `runtime-freeze.test.ts` / `agent-runtime-validation.test.ts` / `runtime-routes.test.ts` /
  `scheduler-node-overrides.test.ts`：调 `seedBuiltinRuntimes`，多数只需两行存在（新语义
  空表建兼容）；含 `builtin` 断言者同步删。
