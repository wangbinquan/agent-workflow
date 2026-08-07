# RFC-266 · 任务分解

单 PR（默认形态）。改动集中在一条数据流上，拆开反而会让 `main` 中间态出现「新键存在但没人读」的假门。

## 依赖图

```
T1 (config schema) ─┬─► T2 (漏斗①) ─► T3 (漏斗②) ─┐
                    │                              ├─► T6 (调度器换池) ─► T8 (集成测试)
T4 (双池模块) ──────┴─► T5 (扇出注册表) ───────────┘
                                     └─► T7 (路由热生效) ─► T8
T9 (前端字段 + 文案) ── 依赖 T1
T10 (文档 / 注释改正) ── 依赖 T6
T11 (门禁 + 实现门)
```

## 子任务

| 编号            | 内容                                                                                                                                                                                 | 验收                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| **RFC-266-T1**  | `shared/src/schemas/config.ts` 加 `maxConcurrentScriptNodes`（`z.number().int().positive()`）+ `DEFAULT_CONFIG` 默认 4                                                                 | 存量 config.json 读取回填成功，`$schema_version` 不变            |
| **RFC-266-T2**  | 漏斗① `resolveLaunchRuntimeConfig` 补读 `multiProcessSubprocessConcurrency` + `maxConcurrentScriptNodes`                                                                               | T-C                                                             |
| **RFC-266-T3**  | 漏斗② `StartTaskDeps` 两个新字段 + `runtimeConfigOpts` 的 `Pick<>` 与返回体；`RunTaskOptions` 加 `maxConcurrentScriptNodes`                                                            | T-D、T-M                                                        |
| **RFC-266-T4**  | `processNodeConcurrency.ts` 升为按 `NodePoolKind` 键控双池；导出 `getNodePoolSemaphore` / `resizeAllNodePools`；改调用点并同步更新既有源码锚点断言                                     | T-A、T-N                                                        |
| **RFC-266-T5**  | 新模块 `services/taskFanoutPools.ts`（getOrCreate + resize-on-read + `resizeAllTaskFanoutSems` + idle-guard `gcTaskFanoutSem` + 计数器），模块文档写明「gc 只许 runTask finally 调用」的理由 | T-B                                                             |
| **RFC-266-T6**  | `scheduler.ts`：`globalSem`→`agentSem`/`scriptSem`，`subprocessSem`→注册表取；脚本分支改取 `scriptSem`；runTask finally 加 `gcTaskFanoutSem`；锁序与池名注释更新                        | T-I、T-J、T-L；持槽窗口逐字不变                                 |
| **RFC-266-T7**  | `routes/config.ts` 在既有线性化点后 resize 三处池                                                                                                                                     | T-E、T-F、T-G、T-H、T-K                                         |
| **RFC-266-T8**  | 集成测试落地（wall-clock 手法复用 `scheduler-boundary-fanout-concurrency.test.ts`）                                                                                                    | AC-9 / AC-10 / AC-11                                            |
| **RFC-266-T9**  | 前端：`settings-drafts.ts` limits 组加新键（**漏加即保存不上去**）；`settings.tsx` 三字段补 hint + 新字段；zh/en 六条文案                                                              | AC-12；前端既有 settings 测试不红                               |
| **RFC-266-T10** | 改正 design §6 表格列出的 6 处过期断言（含 `docs/agent.md` / `docs/architecture.md` 同段的 readonly 叙述）                                                                             | AC-13                                                           |
| **RFC-266-T11** | 门禁 `typecheck && lint && test && format:check` 全绿 → Codex 实现门 → 推 main → 按 exact SHA 查 CI → 更新 `STATE.md` 与 `design/plan.md` 状态为 Done                                   | 仓规四项 + 实现门 findings 清零                                  |

## 实现期追加发现（T6 扩容，已落地）

**RFC-243 子任务的 `buildChildDeps` 只透传了 `maxConcurrentNodes`。** 对新的脚本池而言这不是「子任务跑默认值」这么轻——脚本池是 daemon 级单例且 **resize-on-read**，所以每一次调用节点派生子任务都会把管理员配置的脚本上限**静默改回默认 4，且影响整个 daemon**，不只是那个子任务。扇出子池同理（子任务的分片恒跑 4，正是本 RFC 要修的缺陷下沉一层）。两个键已一并补进 `buildChildDeps`，并加了源码锚点断言（`rfc103-launch-config-passthrough.test.ts`）。

通用教训已沉淀进 `docs/dev-gotchas.md` §构建 / 后端 wire：①设置项要穿过**三段**漏斗（`resolveLaunchRuntimeConfig` / `runtimeConfigOpts` / `buildChildDeps`）；②「读的时候顺便 resize 共享对象」的设计里，漏传参数不是保持原值而是**倒灌默认值**；③「改了不生效」通常不是没接线，而是只在启动时读。

## PR 拆分建议

不拆。若实现门要求拆，唯一安全切法是 `T1+T2+T3+T9`（接线与配置面，自身可独立跑绿）与 `T4~T8+T10`（池分裂），**顺序不可颠倒**——先分池后接线会让分片子池在中间态继续空转。

## 验收清单（declare done 前逐条勾）

- [ ] AC-1 ~ AC-3 接线
- [ ] AC-4 ~ AC-8 热生效（含增容放行排队者、缩容不抢占、运行中任务子池）
- [ ] AC-9 ~ AC-11 脚本独立池
- [ ] AC-12 文案双语三字段
- [ ] AC-13 六处过期断言改正
- [ ] AC-14 源码锚点回归防护（含首次为脚本取闸行为上锁）
- [ ] `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿
- [ ] Codex 实现门（分离 worktree，pin → 自己 commit）findings 清零
- [ ] 推 main 后按 exact SHA 查 CI 绿
- [ ] `STATE.md` + `design/plan.md` RFC 索引状态改 Done
