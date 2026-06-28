# RFC-118：运行时启用/禁用开关

状态：In Progress

## 背景

当前运行时注册表（RFC-112/113）里，两个内置运行时 `opencode` / `claude-code` 是 `builtin=1` 只读种子——**既不能删、也不能停用**（`deleteRuntime` 的 `assertNotBuiltinRuntime` 直接拒；前端 `RuntimeList` 删除按钮 `!rt.builtin` 门槛）。

真实痛点（接 RFC-116）：`claude-code` 运行时因 daemon 无代理直连 Anthropic 被 403、当前环境用不了，但用户**无法把它从可选项里清理掉**——它仍出现在 agent 运行时选择器 / 默认运行时下拉里，容易被误选。物理删除内置又太重：会丢失 profile 配置、`seedBuiltinRuntimes` 启动还会复活（需 tombstone）、`resolveRuntimeByName` 回退语义也要重排。

**结论（依据用户拍板）**：要的不是物理删除，而是一个**启用/禁用开关**——内置也能禁用、但保留在列表里随时可启用；当前被设为默认的运行时受保护不可禁用。

## 目标

1. 运行时（含内置）可被**禁用/启用**（`enabled` 标记），禁用后**保留在列表**、视觉标记「已禁用」、随时可重新启用。
2. **当前 `config.defaultRuntime` 指向的运行时不可禁用**——要禁用它必须先把默认改指向别的运行时（Q2）。
3. 禁用的运行时**不出现在 agent 运行时选择器 / 默认运行时下拉**里，也**不能被新保存的 agent / config 选用**（后端校验兜底）。
4. 自定义运行时原有的「删除」能力保持不变；本 RFC 只新增「禁用」这条更轻、可逆、不丢配置的路径（内置走禁用、不走删除）。

## 非目标

- **不**物理删除内置运行时（不引入 tombstone / 不改 `seedBuiltinRuntimes` 复活语义）。
- **不**改 `resolveRuntimeByName` 的回退链，也**不**中断「存量已引用某运行时的 agent」的派发——禁用只阻止**新选**，不强行让在用的 agent 失效（避免静默改运行时）。前端在禁用被引用的运行时时给出提示。
- **不**改鉴权/spawn/代理（那是 RFC-116 + 运维范畴）。

## 用户故事

- 作为使用者，我把用不了的 `claude-code` 一键**禁用**，它从 agent / 默认下拉里消失、列表里灰显「已禁用」，不再被误选；将来配好代理可一键启用。
- 作为使用者，我尝试禁用 `opencode`（当前默认）时被拦截，提示「默认运行时不可禁用，请先更改默认」——避免把派发默认搞悬空。

## 验收标准

1. `runtimes` 新增 `enabled` 列（migration 0059，默认启用）；内置 seed 不覆盖用户的 enabled 设置。
2. 禁用/启用端点：admin-only；禁用 **effective 默认**（`config.defaultRuntime ?? 'opencode'`）的运行时 → 409 拒绝（先改默认）。
3. 禁用的运行时不出现在 agent 运行时选择器 / 默认运行时下拉；后端保存 agent.runtime / config.defaultRuntime 指向**禁用**运行时时拒绝（独立兜底）。
4. 前端 `RuntimeList`：每行启用/禁用开关（复用公共 `Switch`）；默认行开关置灰 + 提示；禁用行灰显 + 「已禁用」标记。
5. 存量已引用某禁用运行时的 agent 派发不受影响（resolve 不变）。
6. 门禁全绿 + Codex 设计/实现双 gate findings 全 fold。
