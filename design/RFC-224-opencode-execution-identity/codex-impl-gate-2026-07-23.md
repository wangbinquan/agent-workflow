# RFC-224 Codex 实现门（2026-07-23）

> 审查对象：当前共享 working tree 中 RFC-224 的生产接线、migration、测试、CI 与
> 运维文档。该对象尚未形成最终 commit，因此本记录只裁决实现 finding，不把本地
> 结果冒充 exact-SHA 远端证据。
>
> 最终裁决：**APPROVED / 0 P0 / 0 P1 / 0 P2 未关闭**。T28 本地全门已完成，
> 允许进入精确提交与远端门禁阶段；`plan.md` T32 以及 Linux real-sandbox /
> exact-SHA CI 终态继续保持 pending。

## 1. 最终 finding 计数

| 严重度 | 初审发现 | 后续复核 |  累计 | 最终未关闭 |
| ------ | -------: | -------: | ----: | ---------: |
| P0     |        0 |        0 |     0 |          0 |
| P1     |     5 组 |     7 组 | 12 组 |          0 |
| P2     |     4 组 |     5 组 |  9 组 |          0 |

“最终未关闭为零”表示当前源码/测试层面没有已知阻断 finding，不表示尚未运行的
平台矩阵或尚不存在的 commit SHA 已通过。

## 2. 初审 P1 与 resolution

| Finding                                                                                                                          | Resolution                                                                                                                                                                                            | Evidence                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| boot recovery 捕获 orphan-reap 异常后仍可伪造 `priorDaemonSandboxDead=true`，system ephemeral store 可能在旧 writer 存活时被删除 | `reapOrphanRunsForStoreRecovery` 只有在 orphan reap 全部成功且当前 daemon lock 仍归本进程时才签发 opaque、one-shot capability；`kill-failed` 直接中止启动，recovery 消费 capability 后才 scrub/remove | `src/services/orphans.ts`、`src/cli/start.ts`、`src/services/opencodeStoreRecovery.ts`；`rfc224-opencode-store-recovery.test.ts`、`rfc224-source-reachability.test.ts` |
| business/system 分别组装 verified plan，违反 T19 单一 admission core，容易令 official binary、bwrap、FFF 与 store 规则漂移       | 新增 `verifiedPlanCore.ts`，两类 builder 均只经 `buildVerifiedOpencodePlan` 取得 official snapshot、hermetic layout、root-owned bwrap 与 FFF proof                                                    | `verifiedPlan.ts`、`verifiedSystemPlan.ts`、`verifiedPlanCore.ts`；`rfc224-source-reachability.test.ts`                                                                |
| local MCP 以 executable 的父目录做 RO bind，遮蔽 real HOME/appHome 后又可能把整棵 secret tree 暴露回来                           | manifest 改为只 bind 精确 executable；mount renderer 拒绝能覆盖 secret mask 或 writable root 的祖先 bind，并只重建精确目标的父目录                                                                    | `sealedSubprocess.ts`、`verifiedPlan.ts`；`rfc224-sealed-subprocess.test.ts`                                                                                           |
| caller/node timeout 被归类为 permanent `execution-identity-timeout`，会错误阻止相同输入的正常 retry                              | runner 区分 caller attempt budget 与 verified launcher 自身 identity deadline；caller timeout 写 `node-timeout` 且不写 permanent failure code，仍执行 lease release/cleanup                           | `runner.ts`；`rfc224-runner-control-barrier.test.ts`                                                                                                                   |
| task delete、store lease/lock、boot 顺序与产品边界只有生产接线，缺少足以证明 fail-closed 顺序的行为锁                            | 补 opaque-capability、task store inspect/remove、locked/leased refusal、runner control、source reachability 与 policy regression tests；删除只在 task write lock 内检查且不移除 active store          | `taskDelete.ts`、`opencodeStoreRecovery.ts`；`rfc224-opencode-store-recovery.test.ts`、`rfc224-product-boundary-policy.test.ts`、`rfc224-source-reachability.test.ts`  |

## 3. 后续 P1 与 resolution

| Finding                                                                                                      | Resolution                                                                                                                         | Evidence                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 显式 `model:null`/空白被旧值兜底，OpenCode runtime 可绕过 T24 的 operator-selection 保存门                   | config/runtime save 与共享 effective-runtime policy 统一把显式清空视为缺失 model 并稳定阻断；UI 不允许带病保存                     | `routes/config.ts`、`routes/runtimes.ts`、`executionPolicy.ts` 及 config/runtime route tests                                       |
| `/api/runtime/models` 在 source fingerprint 最终复核前即可提交缓存，repo source race 可能留下可信缓存        | cache write 移到最终 source guard 之后；fingerprint 漂移时不提交任何 model cache                                                   | `routes/runtime.ts`、`rfc224-source-guard.test.ts`、`rfc224-source-reachability.test.ts`                                           |
| runtime probe 的成功 receipt 与 config/profile 更新存在 TOCTOU，陈旧成功可写回新 profile 或同名重建行        | migration `0120` 增加 durable `probe_fence`；receipt 绑定 row id、完整 profile、fence 与 effective binary，最终检查和 SQL CAS 同锁 | `runtimeRegistry.ts`、`routes/runtimes.ts`、`migration-0120-rfc224-runtime-probe-fence.test.ts`、`runtime-routes-registry.test.ts` |
| RuntimeList 仍可按后端 raw message 分支或显示身份错误，稳定错误码未成为产品单一事实源                        | status/probe 只投影闭集 failure code，列表用本地化标题与可操作 hint，任意 raw wire text 不进入 UI                                  | `schemas/runtime.ts`、`rfc135-runtimes-status.test.ts`、`RuntimeList.tsx`、`runtime-list.test.tsx`                                 |
| ModelSelect 的 model-list 失败仍走字符串错误，无法稳定区分身份拒绝与普通加载失败                             | model API 保留已知 identity code 并安全 fallback；组件统一走 `ErrorBanner`/`resolveApiError`                                       | `routes/runtime.ts`、`ModelSelect.tsx`、`model-select.test.tsx`                                                                    |
| Homepage runtime 摘要仍依赖通用 Claude 缺失文案，身份阻断在少量行和聚合态均不可操作                          | runtime status schema 增 optional closed-union `failureCode`；首页两种布局均按稳定码渲染本地化 blocker                             | `schemas/runtime.ts`、`HomepageGreeting.tsx`、`homepage-runtime-status.test.ts`                                                    |
| model inventory 的直接子进程退出后可能残留闭 stdio descendant；正 PID fallback 还会在 PID 复用时误杀无关进程 | `finally` 只向负 PGID `SIGKILL` 并 bounded poll group exit，绝不退化到正 PID；新增后台 descendant marker 负测                      | `util/opencode-models.ts`、`opencode-models.test.ts`                                                                               |

## 4. 初审 P2 / 夹具漂移与 resolution

| Finding                                                                                                                                         | Resolution                                                                                                                                                                                                              | Evidence                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/runtime/models` 每次把随机 official snapshot 路径当 cache key，导致稳定 binary 也永远 cache miss                                          | `listOpencodeModels` 支持独立稳定 `cacheKey`；执行仍使用 exact-hash private snapshot，cache 按原始 binary identity 命中                                                                                                 | `routes/runtime.ts`、`util/opencode-models.ts` 及 runtime models/status tests                                                          |
| 历史 runtime/status/ACL 测试用 shell fake、model-less OpenCode、plugin/dependsOn fixture，与 RFC-224 正式门禁冲突                               | 新增纯代码 test dependency seam 与 exact-hash 0500 official fixture；不增加 env/config/HTTP 绕过。与 OpenCode identity 无关的 ACL closure 改用显式 claude-code fixture，skill route 明确 seed 合法 model 并断言创建成功 | `tests/helpers/officialOpencodeFixture.ts` 及 runtime/RFC-223/skill route focused suites                                               |
| daemon HTTP 合同测试仍用 fresh model-less OpenCode 做无关 config PUT，RFC-224 完整 merged system-agent policy 正确返回 422                      | 仅修测试夹具：同一 PUT 为 memory distill、commit-push、merge system profile 提供显式测试 model；生产 fail-closed policy 未放宽                                                                                          | `tests/daemon-start.test.ts`                                                                                                           |
| 旧 source guards 依赖全文件计数或旧单行形态，把 recovery、multipart、distiller cwd/env、runtime protocol 与 migration/CI pin 的合法演进报成回归 | 将 RFC-223 identity sink 改为 exact AST inventory，将 S15/runner/follow-up/multipart guards 收窄到真实语义作用域，并同步 official version pin；没有删除生产检查或扩大 allowlist                                         | `rfc223-identity-structural-guard`、`scheduler-audit-s15-*`、`rfc103-*`、`opencode-spawn-pwd-env`、`upgrade-rolling` 等 focused guards |

## 5. 后续 P2 / 回归证据与 resolution

| Finding                                                                                   | Resolution                                                                                                  | Evidence                                                                               |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| smoke 的 `execution-identity-failed` outcome 未完整走稳定码本地化                         | smoke/status 结果保存 closed failure code，UI 只从 i18n 映射生成文案                                        | `runtimeSmoke.ts`、`RuntimeList.tsx` 及对应 backend/frontend tests                     |
| probe 失败/配置变化时 `lastProbe` 的清除与保留语义不够精确，可能显示过期成功              | execution-profile/fence 变化清除继承 receipt；no-op 保留；外部 config 漂移在读取/materialize 时 fail closed | `runtimeRegistry.ts`、`runtime-routes-registry.test.ts`                                |
| OpenCode model 缺失时，列表/表单的危险态与 Test/Set default/Save 三个动作缺少完整回归锁   | UI 明示危险状态，并在选择合法 model 前禁用全部三个动作                                                      | `RuntimeList.tsx`、`ModelSelect.tsx`、`runtime-list.test.tsx`、`model-select.test.tsx` |
| model-only probe race 测试曾通过 binary 预检查提前返回，未真正证明 SQL CAS                | 固定相同 binary，仅把 model 5.6→5.7；hook 证明已到 CAS，断言 fence 增长、409 且 receipt 未写                | `runtime-routes-registry.test.ts`                                                      |
| stable-code 实现演进后 source-reachability 仍锁旧字面量，可能形成假红或诱导放宽生产 guard | 守卫改锁 closed-union 判断、安全 fallback 与动态 `incompatibleReason: code`，不降低生产可达性约束           | `rfc224-source-reachability.test.ts`                                                   |

## 6. 当前本地证据

- RFC-224 focused：**286 pass / 0 fail**。
- stale/source guards focused：**80 pass / 0 fail**。
- 需 localhost 与自有子进程信号权限的 WS/daemon/process 17 文件：
  **109 pass / 0 fail，392 assertions**。受限 sandbox 内的 `EADDRINUSE`、
  `command-mismatch`、`waitDead=false` 已由授权环境复跑证明是平台限制及其级联，
  不是生产回归。
- 最终 `bun run test` 三包同轮 **0 fail**；其中 shared
  **1438 pass / 0 fail**，frontend **5257 pass / 0 fail**，backend 全量也在同一
  exit-0 命令中完成。最终独立复核另跑 backend focused **94/94**、frontend focused
  **43/43**、source reachability **8/8**。
- `bun run format:check`、`bun run typecheck`、`bun run lint`、`git diff --check`
  均绿；`bun run depcheck`：**1455 modules / 4482 dependencies / 0 violations**。
- `bun run build:binary` 通过，产物
  `dist/agent-workflow-macos-arm64`（92.5 MiB）；built-in version smoke 通过。
  compiled help 不暴露 `__opencode-*`；两条畸形 hidden-command 调用均 exit 1，
  stderr 精确为 `AW_OPENCODE_FAILURE execution-identity-store-unsafe`。
- 本机 official OpenCode **1.18.3 darwin-arm64** no-LLM
  config/provider/agent/skill/root-session preflight：
  **1 pass / 0 fail（7 assertions）**。

## 7. 诚实保留的发布证据

以下不是未关闭 P0/P1/P2，而是尚未完成的门禁/发布证据，因此不得在提交信息或
`STATE.md` 中提前写成已绿：

1. 本机 macOS 无法提供 Linux root-owned bwrap 的 real escape/double-fork 权威
   结果；该项等待 `integration-opencode` Ubuntu job；
2. 尚未精确 stage/commit，co-author trailer 尚未针对最终 commit 核验；
3. 尚未 push，因此不存在可归因于本次实现的 exact-SHA CI/integration 终态，
   T32 保持未勾选。

## 8. 裁决

实现门在当前源码与已运行证据范围内为 **APPROVED**：最终未关闭
**0 P0 / 0 P1 / 0 P2**，T28 已完成。后续只可在 T32 的真实结果完成后声明
“exact-SHA CI/integration 绿”；若 Linux integration 出现新产品失败，应重新打开
实现门，而不是把它记成环境噪声。
