# RFC-153 — 取消 runtime 内置/非内置区分（清理 builtin 标签）

状态：Draft
触发：用户 2026-07-08「内置的也要传模型名，为什么还要区分内置和非内置？内置不就是一个默认的通用的运行时吗——清理掉内置标签」（源于排查「opencode 运行时是不是没传模型」）

## 背景

runtime 注册表（RFC-112）给每行加了 `builtin` 布尔列，把框架预置的 opencode / claude-code
两个 runtime 标为「内置」，最初借用 RFC-104「框架内置资源只读锁」语义。演进至今这层区分
已经名存实亡：

- **内置 runtime 早已可编辑**（RFC-113 D8）：`updateRuntime`（runtimeRegistry.ts:372-398）
  注释白纸黑字「BUILT-INS are editable here (binary/model/params)」，函数体内**没有**
  `assertNotBuiltinRuntime`；`PUT /api/runtimes/:name`（routes/runtimes.ts:196-210）对内置
  放行。
- 于是 `runtimes.builtin` 列**只剩四个残留行为**：
  1. UI 列表挂一个「内置」徽章（RuntimeList.tsx:172-176）；
  2. **禁止删除**（`deleteRuntime` → `assertNotBuiltinRuntime`；前端隐藏删除按钮）；
  3. **保留名保护**——不能创建名为 opencode / claude-code 的 runtime
     （`validateName` → `BUILTIN_NAMES.has`）；
  4. seed 每次启动 **upsert + identity-reset**（删了重启会回来）。

### 与用户原始问题的关系

诱因是发现 opencode 运行时「没传模型」：内置 runtime 的 `model` 默认 NULL（`seedBuiltinRuntimes`
不带 model），而 `buildInlineAgentEntry`（inlineConfig.ts:104）仅在 `model !== null` 时写入
inline config，于是一路空到底、opencode 回落 `provider.defaultModel()`（opencode 源码
`agent/agent.ts:371` `input.model ?? provider.defaultModel()`）。

这在功能上并非「配不了」——内置早已可编辑 model——但「内置」这层特殊化（徽章 + 不可删 +
保留名 + 每次补种）造成了「内置被框架锁定、区别对待」的认知负担。用户判定这个区分多余：
内置本质就是「两个默认的通用 runtime」，应与自定义 runtime 一视同仁。

## 目标

1. **删除 `runtimes.builtin` 列**及其一切派生行为——opencode / claude-code 降级为**普通
   runtime**，与自定义 runtime 一视同仁。
2. 去掉 UI「内置」徽章；内置 runtime 可删除（受既有引用保护约束）；解除 opencode /
   claude-code 保留名保护；seed 改为**仅当 runtimes 表为空时首次预置，用户删了不再补种**。
3. model 传递语义**保持不变**——预置 runtime 开箱 `model = NULL`（交给 opencode
   `provider.defaultModel()`）；想指定就在 Settings → Runtime 编辑填入（现状即支持）。

## 非目标

- **不动 agents / workflows 的 RFC-104 内置只读**（skill-fusion workflow / skill-merger
  agent）——那是另一套资源只读机制，其 `builtin` 语义与本 RFC 无关，边界锁定。
- **不动协议名 → driver 兜底**：`resolveRuntimeByName`（runtimeRegistry.ts:176）里
  `BUILTIN_NAMES.has(n)` 保证「即使 DB 无此行，opencode / claude-code 协议名仍 resolve 到
  driver（+ NULL_PROFILE）」，是 dispatch 命脉，一律保留。
- **不改 model 传递机制**：inline config 的 `agent.<name>.model`、dispatch 时 freeze、
  opencode CLI 刻意不带 `--model` 等全不动。
- **不给预置 runtime 写死默认 model**（用户拍板：留空，交给 opencode 自身默认；agent-workflow
  不去猜用户的 provider）。

## 用户故事

- 作为 admin，我在 Settings → Runtime 看到 opencode / claude-code 就是两个普通 runtime，
  没有「内置」徽章、没有区别对待。
- 作为 admin，我想给 opencode runtime 指定 model → 直接 Edit 填入（现状即可）。
- 作为 admin，我不用 claude-code → 直接删除它，且**删了不会在重启后自动回来**。
- 作为 admin，删掉后若想重建同名 opencode runtime → 可以（保留名已解除）。

## 验收标准

1. `runtimes.builtin` 列删除（migration + schema + 类型 + view 全清）。
2. `GET /api/runtimes` 响应不再含 `builtin` 字段；RuntimeList 无「内置」徽章；删除按钮对
   所有 runtime 显示。
3. `DELETE` 一个预置 runtime（未被 agent / default 引用时）→ 200 成功；被引用时仍 409
   `runtime-in-use`（引用保护保留）。
4. 删除预置 runtime 后重启 daemon → **不补种**（表非空）。
5. 首次启动（runtimes 表为空）→ 仍预置 opencode / claude-code 两行。
6. 可创建名为 opencode / claude-code 的 runtime（与现存预置行冲突时走既有 `runtime-exists`
   409，而非 `runtime-name-reserved`）。
7. model 传递端到端不变：给预置 opencode runtime 配 model → dispatch 时 freeze → inline
   config 带上 `model`；不配则省略（回归防护，呼应用户原始问题）。
8. RFC-104 的 agents / workflows 内置只读**零回归**（边界锁）。
