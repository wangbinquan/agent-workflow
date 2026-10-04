# 执行 effect 的本机投影切面

本批落实已批准 `execution-material-implementation.md` §4 中的一个有限单元：将本机请求指纹、writer workspace key、启动持久收据和结算收据投影移出 `application/processEffectObserver.ts`。它不关闭 H4/H5、A5 或 A-G；完整 Agent 材料、执行与取证接口、三入口和真根 selected binding 仍在后续实施范围内，CS 生产 adapter 与部署尚未开始。

`application/ports/processEffectProjection.ts` 定义显式必需的 `ProcessEffectProjection<TReceipt, TResult>`。协调器仅需要 `TResult.outcome` 进行原有结算分类；其余收据内容由所选 participant 解释。`describe` 提供执行实现拥有的请求指纹、额外资源和恢复协议版本；`recordSpawnReceipt` 接收同一次准备所得的 effect/attempt/node 身份并等待持久完成；`settlementReceipt` 提供该执行实现的持久投影。协调器不会选择默认本机实现，也不读取 PID、nonce、argv、cwd 或构造本机 JSON。

`infrastructure/local/processEffectProjection.ts` 保持原本机计算：`requestHash({ v: 1, processKind, argv, cwd })`、`workspace:${sha256Hex(writerWorkspace)}`、三个 RFC-328 恢复协议标记、原非空 nonce 要求，以及完整有序的 v1 reaped 收据。启动仍写原 `TaskExecutionEffectPersistence.recordProcessSpawn`，effect/attempt/node、PID、binary、nonce 和可选 runtimeParamsJson 的持久位置均保留。已有数据库和恢复 reader 不换格式。

`composition/processEffectObserver.ts` 为原本机 Agent/script 调用者装配该 participant，现有 public participant 名称和返回 API 保持。runner 与 `runOneScriptAttempt` 的 writer workspace 计算接入这个本机 participant；read-only 执行仍不添加 workspace key。这个兼容装配还不是完整部署环境选型入口，后续选中 execution/material binding 时应向中立协调器传入对应投影。

原 lineage、legacy slot fallback、operation family、generation、资源排队、token、retryAuthority、结算三档和 failureCode 保持。Task 仍由原 managedProcess launcher 在持久收据 ACK 后激活，没有新增 launcher、计时器、kill/reap 或恢复算法。系统 Agent、smoke 和 MCP 的 direct 路径不经过本批改动，完整三入口接线仍需单独验收。

原 RFC-359 双数据库 conformance 用例改为通过实际兼容 composition 调用，测试体和所有断言逐字保留。新增 `rfc370-process-effect-projection.test.ts` 覆盖 reference-only receipt、原 outcome 分类、准备前/重复准备、缺失 lineage、receiver 和 held/rejected ACK、本机完整指纹与收据、原启动持久事实，以及真实 Task target 在 ACK 前不激活。正式运行结果以新 exact-SHA GitHub CI 为准；没有运行本机 AW test/typecheck/build/service。

本批另外修复此前 launcher CLI 测试的 `describe.each` readonly tuple 类型不兼容：`2c341e291bbe2607567614dcc335c2f222fcba12` 已上库。旧 `75d1f4ec` Windows 的相关运行用例成功、typecheck TS2769 失败；该修复 commit 的 CI/Windows 被后继发布取消，不构成绿色验收。新执行候选还须完成独立功能门、原规则 canonical 生成及远端验证。

SOURCE9-R4 已独立有限 PASS：4183d3c08171089d8753dcb0546796676812b41534cccd199b6da9d021b166ef。最后修正保留资源 getter 单次读取、原 hash→资源顺序，以及携带 writerWorkspace 命名属性的原数组内容；旧全部测试体保持。原 scoped 生成及完整 validator／129库存静态核对已通过，sourceDigest sha256:c4b7972032fb94aa39a1ebe36661611dc12d35c9e692381f2196f5095bf9881f；本批 matching metadata 的有限门、发布和新 hosted CI 尚待完成，不能据此关闭完整 H4/H5 或部署。
