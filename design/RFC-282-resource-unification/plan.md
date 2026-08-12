# RFC-282 · 任务分解

状态：Draft **v2**（已按双路设计门 20×P1 + 10×P2 修订；findings 落点见 design.md §10）

**PR 拆分原则**：主干开发直推 `main`，每批独立 `gate:local` 全绿、推完按 exact SHA 查 CI。

**回滚粒度**（设计门 P2-3 修正）：**只有最近一批可独立回滚**；B/C 批内部是线性依赖
（B2←B1、B3←B2、C3←C2、C4←C3），跨批回滚须按逆序。初版「每批独立可回滚」的说法收回。

**并发策略**（设计门 P2-6）：本 RFC 要动的正是全仓最热的文件（近 30 天 churn：
`scheduler.ts` 91 次、`runner.ts` 42、`runtime/types.ts` 31、两个 driver 各 20-31），
且 RFC-280 实现门此刻仍在收尾（工作树里 `startupVerification` 一批未提交）。因此：

1. **D 批优先启动** —— 它碰的是 `agent.ts` / `workflow.ts` / `workgroups.ts` /
   `scheduledTasks.ts` / `importRefs.ts` / `closure.ts`，与并发工作零重叠；
2. **开工 B 批前确认 RFC-280 实现门已收尾**；
3. **每批用 pin 到自己 commit 的分离 worktree 跑门禁**（`git worktree add --detach` +
   `bun install --frozen-lockfile`），否则共享树上的红不可归属；
4. 提交一律 `git add <精确路径>`，不用 `git add -A`。

**每批都对拍**（决策 19）：换装配路径的批次先写新旧双实现对拍证明等价，再同 PR 删旧
实现。**纯搬迁批次（C3）的对拍面另有定义**（见 C3 行与 design §9 复核项 4）。

## 任务表

### 批次 D — 资源抽象（**优先启动**，与并发工作零重叠）

| 编号 | 任务                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 依赖   | 交付  |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ----- |
| D1   | **ACL 判据收敛**（设计门 P2-1 修正射程）：全仓只有 `scheduledTasks.ts:389` 是**真副本**（私有函数遮蔽同名导出、只支持 3/6 类型）→ 改调共享 `canViewResourceInTx`。`agent.ts:838` / `workflow.ts:1006` / `workgroups.ts:856` **不是副本**，是写路径断言：内联算出的 `isAdmin`/`isOwner` 后面要复用判 403，且 404 必须用资源专属错误码、在 `assertNotBuiltin` 之前抛 ⇒ 只抽取其中的 **visible 子表达式**，保留 isAdmin/isOwner 与抛错顺序。**对拍**：四处改造前后的 (可见性, 错误码, 抛错顺序) 三元组逐一相等。**注意**：共享版判据是宽松的 `(visibility ?? 'public')`、副本是严格的 `=== 'public'`，对 legacy/raw-SQL 的 NULL 行是「从不可见变可见」⇒ 若存在此类行属可观察变更，须先查库确认为空集，否则进 §7 | —      | PR-D1 |
| D2   | **importRefs 共享底层**（决策 18）：grant 查询改调 `listGrantedResourceIds`；可见性判据复用 `resourceAcl`；selector 语义层保留独立                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | D1     | PR-D2 |
| D3   | **ref codec 三域接上生产**（决策 12）：`freezeCallClosure`（`execution/closure.ts:240/247/284-290/357/380/401`）改走 `decodeCallRef`/`encodeCallRef`；importSelector 与 intent 同理；删 `agentRefs.ts:22-24` 的 `m:`/`p:` 前缀键第二份；`RefResolver` 接口给出实现或删除。**对拍**：改造前后 ref key 与解析结果逐字符相等                                                                                                                                                                                                                                                                                                                                                                                    | —      | PR-D3 |
| D4   | **引用校验 fail-open 修复**：`resolveRefsUsableByName` 补 `grandfatheredIds`（与 id 域对称）；`RefCheckGroup.domain` 去掉 `'id'` 默认改必填（漏标从静默通过变编译报错）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | D2, D3 | PR-D4 |

### 批次 A — 防护先行

| 编号 | 任务                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 依赖 | 交付  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----- |
| A1   | **ESLint import 边界**：**扩展 `eslint.config.js:62-74` 既有 block 的 `patterns` 数组**（设计门 P1-8：新增 config 对象会因 flat config 同名规则整体替换而静默关掉既有跨包禁令）；pattern 同时覆盖别名与相对路径形态；例外清单按 `(规则, 文件, 匹配文本)` 三元组 + 陈旧棘轮（照抄 `scripts/depcheck.ts` 的 `staleIgnores`）。**正向证明**：新旧两组 pattern **各**做一次变异实证                                                                                                                                                                                                  | —    | PR-A1 |
| A2   | **源码层 grep 锁**：八类资源转换的定义点唯一 + 调用点白名单 + 禁止词族（driver 目录外不得出现 `OPENCODE_CONFIG_CONTENT`/`--mcp-config`/`.claude/`；不得 re-export runtime 内部 —— 堵 `runner.ts:2194/2195/2199` 那条洗白通道；`buildPlan` 不得替换 cmd/env/declared）。**A 阶段存量不唯一的（memory 织入 ×2、claude mcp-config 落盘 ×2、plugin enabled 过滤 5 处、`EMPTY_RUNTIME_PROFILE` 双定义）进 `RFC282_DEFINITION_EXCEPTIONS`，与 A1 清单同规格归零**（设计门 P2-4）。锁自身需 sanity 断言（走查文件数 > N + 已知形态确实命中）                                            | —    | PR-A2 |
| A3   | **启动自检 + 规则表建表**：引入 `RuntimeDriverCapabilities`（**改名避开既有 `DeclaredRuntimeCapabilities`**）与两 driver 表态（值照抄现状，含 `observationRequiresFreshRun`）；**同批建 `resourcePolicy.ts`，取值照抄现状**（plugin `fail-closed`、mcp `skip-and-declare`、agent `not-modeled`）—— 设计门 P1-5：自检要校验的表若在后面批次才建，A3 的自检就是假守卫。boot 校验三项，`'not-modeled'` 单独报告不计入已表态。**需同批加 driver 注册测试缝**（设计门 P2-3：`DRIVERS` 是私有 const，没有缝就写不出「mock driver 少一个面 → 拒绝启动」的正向证明）。**不改任何消费方** | —    | PR-A3 |

### 批次 B — 注入装配层（核心；开工前确认 RFC-280 实现门收尾）

| 编号 | 任务                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 依赖   | 交付   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ------ |
| B1a  | **新契约与旧方法并存**（设计门 P2-6：`scheduler.ts` 91 commits/30d，不做大爆炸提交）：加 `AgentSpawnContext` + 单一 `buildSpawn`（字段按 design §2.1 全集）；**旧三方法保留为 delegate 薄壳**。此时两条路径都活，对拍测试是**活的**而非一次性用品。§7-1a/1b 在此落地（含「claude 系统面条目不含 permission」正向锁）                                                                                                                                                                                   | A3     | PR-B1a |
| B1b  | **调用方逐个迁移 + 删旧方法**：五条链路依次切到 `buildSpawn`；全部切完后删 `buildBusinessSpawn` / `renderInjection` / 旧 ctx 类型。§7-6/§7-9（declared 渲染失败的降级归属）/§7-10（`buildPlan` 收窄 + 测试台声明回传）在此落地                                                                                                                                                                                                                                                                         | B1a    | PR-B1b |
| B2   | **解析层归位**：`prepareNodeRunInjection` + `resolveSkills` → `services/execution/resolveInjection.ts`；skill 门 throw → typed failure（**先补一条「quarantine skill → 任务级失败」红测再改**，§7-7）；6 入口全走它；`AgentInjectionSpec.skills` 拓宽为 `ResolvedSkill[]`（§7-8）；**writeSem 内调用点透传 `signal`**（design §9-5）。**对拍**：同 agent 新旧解析的 spec 逐字段相等 + 失败归属逐条比对。**新增回归锁**：零资源合成 agent 经 resolveInjection 恒返回 ok（设计门 P2-9 的新失败模式守卫） | B1b    | PR-B2  |
| B3   | **规则表接线**（**不改取值** —— 决策 4 已撤回）：`resourcePolicy.ts` 成为唯一可读点，5 个 `plugin-disabled` 产出点改为引用表中的 disposition 常量与理由（逻辑不搬、行为不变）；A2 白名单同步收紧                                                                                                                                                                                                                                                                                                       | A3, B2 | PR-B3  |
| B4   | **driver 内重复消除**：memory 织入 ×2 → 1；claude mcp-config 落盘 ×2 → 1（注意一处带 `mode:0o700` 一处不带）；plugin enabled 过滤 5 处 → 1；`declareSkills` 谓词内联 4 处 → 复用；`EMPTY_RUNTIME_PROFILE` 双定义 → 1；**plugin 去重键统一**；**subagent root 排除对称**；删死代码 `toClaudeMcpConfig`。A2 例外清单同步划掉                                                                                                                                                                             | B1b    | PR-B4  |

### 批次 C — runtime 围栏

| 编号 | 任务                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 依赖   | 交付                    |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----------------------- |
| C0   | **拆 re-export 洗白通道**（设计门 P1-8）：删 `runner.ts:2194/2195/2199` 对 opencode 内部的 re-export，把 `memoryDistiller` 与测试的 import 点改到真源；`ProbeOpts` 上提到 `runtime/types.ts`（设计门 P2-7：否则 C3 后 `claudeCode/probe.ts:7` 会变成 claude→opencode 跨边）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | A1     | PR-C0                   |
| C1   | **二进制覆写通道归一 + 关闭 Windows P2**（决策 17 收窄 + 决策 22）：`opencodeCmd` 与 `runtimeCmd` 双双退役 → 单一 `binaryOverride`；**`runtimeBinary` 冻结值保留由调用方传入**（design §2.1，不得让 driver 查 registry）；**124 个测试夹具分批迁移**；`rfc143-runtime-driver-capability.test.ts:333` 的精确 import 字符串锁同步；**把 `binaryOverride` 穿到 registry/smoke 路径，关闭 `docs/audit-backlog.md` 登记的 Windows 红**。**对拍**：改造前后 argv head 逐字节相等（覆盖 config.opencodePath / registry binaryPath / PATH 三种来源）+ Windows 上 runtime-smoke 转绿                                                                                                                                                                                                                                                                                                                                                                                                                        | B1b    | PR-C1（夹具迁移可再拆） |
| C2   | **显式能力声明接线**：`runner.ts:1830/1836` 与 `mcpRuntimeTest.ts:2551` 的 `readInventory` 代理判据改 `capabilities` 穷尽 switch，**保留 `observationRequiresFreshRun` 前置守卫**（design §2.2）；`DRIVERS[kind] ?? opencodeDriver` → **执行路径显式报错、读取/展示路径 `tryGetRuntimeDriver()` 降级**（决策 13 收窄）。**新增回归锁**：opencode followup 不产生验证记录                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | A3     | PR-C2                   |
| C3   | **opencode 专属代码搬迁**（约 **1700 行**，含 `src/opencode-plugin/` 目录 —— 初版「1300 行」低估约 30%）。**必须同步编辑的清单**（设计门 P1-4，缺一项即静默损坏）：①`scripts/build-binary.ts:34` 的 `pluginsDir` 硬编码路径与 `:201-202` 的「禁嵌套子目录」约束；②`opencode-plugin/index.ts:21` 对 `../embed.generated` 的相对深度；③`.github/workflows/integration-opencode.yml` 的 **push 与 pull_request 两个 trigger** 的 `paths:`；④`tests/opencode-integration-path-coverage.test.ts` 的 `CANONICAL` 数组（与 YAML 逐字相等）；⑤`.github/workflows/visual-regression-nightly.yml:32/53`；⑥8 个按字面路径读文件的测试；⑦42 条 import specifier。**注意 `util/opencode*.ts` 这条 glob 还覆盖不在搬迁清单里的 `util/opencode-models.ts`，收窄会静默丢它的 CI 覆盖**。**对拍面**（非符号相等）：`bun run build:binary -- --include-e2e` + 断言 `PLUGIN_FILES` 非空 + 一次真读 inventory 的集成跑通 + `git diff -M --find-copies-harder` similarity 100%（除 import 行）+ 完整 `bun run depcheck` | C0, C2 | PR-C3                   |
| C4   | **boundary 拆分下沉**：`composeOpencodeBoundary` + `opencodeDataDir` + `machineSkillRoots` → `runtime/opencode/boundary.ts`；`composeClaudeBoundarySettings` / `claudeExpressibleAuthorDirs` → `runtime/claudeCode/boundary.ts`；统一层只留 `BoundaryCtx` 类型与 `resolveBoundaryMounts`。**RFC-281 全部行为锁只改 import 路径、断言内容一字不改**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | C3     | PR-C4                   |

### 批次 E — 收尾

| 编号 | 任务                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 依赖 | 交付   |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ------ |
| E1a  | **死代码清理**（设计门 P2-9：不是纯删）：`pumpLines`/`LinePump`（`runner.ts:2076/2126`，src 内无消费方）删除 + 锁迁到 managedProcess 的 `pump` —— **迁锁前必须逐条证明等价**（两者在丢空行/丢尾换行/截断标记文案上已知不同，`docs/dev-gotchas.md` 有记录），文案变更登记 §7；`FINAL_REAP_MARGIN_MS` **有活消费方**（`runner.ts:1362/1407`，含用户可见错误文案），与 `managedProcess.ts:21` 统一 = 动 kill 升级链实时路径，单独一条并带对照表                          | A–D  | PR-E1a |
| E1b  | **收口**：A1/A2 例外清单归零验证；`runtime/types.ts:533` 残留的 `RuntimeMcpTestCapabilityV1` 注释；`docs/OPENCODE_CONFIG.md` / `docs/dev-gotchas.md` / **`docs/audit-backlog.md`**（设计门 P2-8：spawn 入口锚点条目失效 + Windows P2 关闭）增补；**顺手修 `docs/dev-gotchas.md` 的过期指引**（它仍在教用 `markProductionOpencodeCommand` / `legacyTestPath` / `rfc224-source-reachability.test.ts`，三者已被 RFC-276 删除）；STATE.md 与 `design/plan.md` 索引置 Done | E1a  | PR-E1b |

## golden / source-lock 归属表（决策 16）

| 既有断言                                                          | 打红原因                                  | owning | 新断言                                                            |
| ----------------------------------------------------------------- | ----------------------------------------- | ------ | ----------------------------------------------------------------- |
| `runtime-buildspawn.test.ts` 系统面精确形状                       | §7-1a opencode 统一产出多出字段           | B1a    | 按统一产出重锁；**同批加 claude 系统面「不含 permission」正向锁** |
| `rfc143-runtime-driver-capability.test.ts` 接口面                 | §7-6 driver 三方法 → 一个                 | B1b    | 锁单一装配方法 + capabilities 表态                                |
| `rfc143-runtime-driver-capability.test.ts:333` 精确 import 字符串 | §7-3 `resolveOpencodeCmd` 退役            | C1     | 锁 `binaryOverride` 的唯一注入缝                                  |
| 124 个测试夹具的 `opencodeCmd` 注入                               | §7-3                                      | C1     | 改走 `binaryOverride`（分批）                                     |
| RFC-281 boundary 测试 import 路径                                 | §7-4 下沉                                 | C4     | **只改 import，断言内容一字不改**                                 |
| `runner-stream-bounds.test.ts`                                    | E1a 删 `pumpLines`                        | E1a    | 迁到 managedProcess `pump` + 等价性对照表                         |
| skill quarantine 失败归属                                         | §7-7 throw → typed failure                | B2     | **先补红测**锁现状，再改为节点级                                  |
| `rfc223-pr6-injection-identity.test.ts`                           | **不打红**                                | —      | 原样保留                                                          |
| scheduler `plugin-disabled` 用例                                  | **不打红**（决策 20 撤回）                | —      | 原样保留                                                          |
| startup-verification 形状断言                                     | **不打红**（决策 4 撤回，声明面形状不变） | —      | 原样保留                                                          |

## 验收清单

**归一（机器可校验）**

- [ ] A1/A2 例外清单归零（含陈旧棘轮通过）
- [ ] 八类资源转换各唯一实现（grep 锁 + 调用点白名单 + 锁自身 sanity 断言）
- [ ] `RuntimeDriver` 只剩单一装配方法（类型层核验）
- [ ] 启动自检：`declarationFaces` 覆盖全集、`'not-modeled'` 单独报告，缺面拒绝启动
- [ ] `resolveInjection` 在 `services/execution/`，6 入口全走它
- [ ] `canViewResourceInTx` 的真副本清零（`scheduledTasks.ts:389`）
- [ ] call / importSelector / intent 三域 codec 有生产调用点
- [ ] 约 1700 行 opencode 专属实现全在 `runtime/opencode/`，且 `depcheck` 全绿
- [ ] `DRIVERS[kind]` 执行路径报错 / 读取路径降级；`readInventory` 不再作 runtime 判据
- [ ] `docs/audit-backlog.md` 的 Windows 命令数组缝 P2 已关闭（runtime-smoke 在 Windows 转绿）

**功能不受影响**（决策 21；设计门 P2-5 要求可机械核对）

- [ ] **测试文件哈希基线**：A 批产出全部测试文件哈希基线；每批 PR 打印被改动的测试文件集，与 §7 归属表做差集，**非空即红**（取代不可验证的「既有测试零改动通过」）
- [ ] 每个换装配路径的 PR 含新旧对拍，等价证明后同 PR 删旧实现；C3 用 build-binary 对拍面
- [ ] RFC-280 / RFC-281 / RFC-223 行为锁不改断言通过
- [ ] **点名 e2e**：`e2e/main.spec.ts`（业务节点全链）、`e2e/rfc253-script-node.spec.ts`、
      `e2e/mcp-runtime-playground.spec.ts`、`e2e/intent-builder.spec.ts` —— 每批 declare done
      时按 exact SHA 查这几条腿（`gate:local` 不跑 Playwright）
- [ ] 四道守卫各有「能抓到违规」的变异实证（A1 需覆盖**新旧两组** pattern）
- [ ] 每批在 pin 的分离 worktree 跑 `gate:local` 全绿；推完按 exact SHA 查 CI

## 交付前必过清单

- [ ] 双路独立子代理设计门（已完成，20×P1 + 10×P2 全处置，落点见 design §10）
- [ ] 实现门（declare done 前）跑一次并修 findings
- [ ] design §9 的 5 项复核项已有结论（v2 已填）
- [ ] `design/plan.md` RFC 索引登记；`STATE.md` 顶部指向本目录；完工后置 Done

## 实施记录（2026-08-12，实现 session）

**已落 main 的批次**：D（4532faad）→ A（be7c2342）→ B1a（ed713bcc）→ B1b 迁移半场
（92f3cf7c）→ B2（a6c462d0 + 22cb6b41 锁补账）→ B3（0196c60d）→ B4（8cb234f7）→
C0+C2（c76305fe）→ C1 第一段（32dafa0d）→ C3（5ee77b23）→ C4（6c7151a7）→ E 批。
每批 pin worktree `gate:local`（backend 全绿；三次 quality/backend 红均为宿主并发
负载 flaky，无负载复跑绿：worktree-files/runScope/daemon-start、auth-form-tabs、
agents-split-page）。

**执行偏差（相对 plan v2，均已在 commit message 声明）**：

1. **B1b「删旧三方法」推迟**：`rfc280-startup-verification.test.ts` 是并发 RFC-280
   session 的未提交工作区文件，删除 `renderInjection` 会强制改它（多人纪律）。五条
   链路已全部迁移到 `buildAgentSpawn`（facade），旧三方法成为 driver 内部真身；
   RFC-280 收尾落库后做「删接口面 + buildAgentSpawn 必填化改名 buildSpawn +
   AgentSpawnContext.legacyHeads 删除」的收尾提交。
2. **C1 收窄为两段**：本 RFC 落了 probe/smoke 的命令数组缝（Windows P2 补缝）；
   **124 个夹具的 opencodeCmd→binaryOverride 机械迁移**（128 文件 / 422 处）与
   **resolveOpencodeCmd 12 入口收拢**推迟。后者的正解是把 config.opencodePath
   兜底并进 resolveFrozenRuntime 冻结链（现状 spawn 时实时读 config ⇒ resume 后
   head 可随 config 漂移；并入后更符合 RFC-111 D15）——属冻结语义可观察微变，
   待用户拍板。
3. **§7-1a 未触发**：facade 形态下系统面产出逐字节不变（description/options 字段
   差异是「允许」而非「必须」的变更）；深层装配合一留待旧方法删除后。
   `runtime-buildspawn.test.ts` 因此**零改动**（比 golden 表预告更保守）。
4. **A1 落地形态修正**（已记 design §4.2 实现修正注记）：共享 patterns 常量 +
   backend src/非-src 双 block（tests 33 条合法 driver 单测 deep import 不误伤），
   新旧 pattern 双向变异实证。
5. **D2 顺带**：`resourceRefs.assertRefsUsableInTx` 的第三份 grant SQL 一并收敛
   （proposal 只点名 importRefs）。
6. **E1a 事实修正**：`EMPTYRUNTIME_PROFILE` 实为「第二导出通道」非双定义；
   `pumpLines` 截断 marker 文案随锁迁移改为 managedProcess 现行文案
   `…[line truncated]`（§7 登记）。

**SHA 归属勘误（实现门 P3-4）**：C3 的 11 个 git mv rename 物理上落在
`ddd04965`（docs(state) 事故登记——staged renames 被附带提交，见 dev-gotchas
新条目），`5ee77b23` 承载全部 import 修复与清单同步；按 owning-commit 考古时
两个 SHA 须一起看。

**实现门记录（2026-08-12）**：独立子代理对抗评审（Codex wedge 先例延续），
0×P1 + 2×P2 + 5×P3，总判定「可收工」；P2-1（/api/runtimes 脏行 500）、
P2-2（wrapPlan 类型收窄为 wrap-only）、P3-1/2/3/4/5 全部已在收尾提交处置。

**残留 followup —— 2026-08-12 二次收尾已全清**（用户拍板「把没做的全部收尾」，
并发 session 撤场解锁）：

- ✅ B1b 删除半场（17b9215b）：契约面只剩 buildSpawn(AgentSpawnContext)，旧三
  方法体抽为 driver 内具名装配函数，11 个测试文件迁真身；
- ✅ C1 第二段（17b9215b）：config.opencodePath 并入 mint 冻结（driver.defaultBinary
  差分、零 kind 字面量；resume 读冻结快照——D15 对齐，为**有意行为微变**：
  已铸 run 的 head 不再随 config 后改漂移）；15 入口收拢为 scheduler 单点；
  opencodeCmd/runtimeCmd → binaryOverride 全链改名 + legacyHeads 删除 +
  约 90 文件夹具迁移；
- ✅ RFC-280 遗留两文件落库（d6760d24，banner 判据 + mock MCP 状态缝）。
- ✅ 收尾修正（ce96e6a6 + 3f755757）：C1 改名初版漏掉 StartTaskDeps/FusionDeps/
  daemon auto-resume deps 三个顶层载体——spread 透传把 opencodeCmd 键静默丢在
  RunTaskOptions 门外（spread 不触发 excess property check），mock 失联、三个真
  子进程 e2e 红。全链改名后 41 文件 107 处显形断链 tsc 错误驱动清零；rfc143/154
  的 claude 语境 mock 头修回 runtimeCmd（内部装配 ctx 合法字段，P1-1 断言即验）；
  RFC-257 secretBox 源码锁随 buildStartTaskDeps 新签名迁移。
  教训（通用坑已沉 dev-gotchas）：**字段改名必须枚举全部承载类型**——spread
  透传链上任何一环留旧名，tsc 全绿但键在边界处静默蒸发，只有真子进程 e2e 能抓。

**Codex 实现门（第二轮，2026-08-12，真 Codex）**：CLI 升 0.147.0 后 7 月底的
companion×CLI 互挂已修复,pin worktree（dc2529b8）`--base 1ba863ee` 全量 diff
真跑成功。findings：**3×P1，全部指向 C1 config-freeze 链的「改造前行为丢失」**，
逐条核实属实并当轮修复（e75a05ff）：

- P1-1 `buildChildDeps` 漏转发 `configPath`——call-workflow/call-workgroup 子任
  务 mint freeze 拿不到 binaryConfig（dev-gotchas 三段漏斗第三段再实锤，自己刚
  写完第五形态条目又中第三段）。修：转发 + rfc103 锚点锁。
- P1-2 commit/merge session 的 inherit-literal 冻结点未传 binaryConfig：
  NULL-profile + config 场景旧靠 `opts.opencodeCmd` 供头,改造后回退 bare。修：
  两站点补第 6 参；mint inherit 分支 NULL 兜底并把头冻进新行（与 fresh-resolve
  同语义）。考古排除：turnEngine/changeNarrative/mcpRuntimeTest/memoryDistiller/
  applyChangeset 旧代码只吃 profile.binaryPath 或零 config 参与，无回归；
  autoRepair 已走任务链。
- P1-3 pre-C1 存量行 `runtime_binary=NULL` 的语义是「头走 opencodeCmd 通道、
  spawn 时现读」，already-frozen 早退直读 NULL 使升级后 resume 回退 bare。修：
  NULL 行按当前 config 现算兜底、**不回填列**；**D15 收窄为「非 NULL 冻结值
  不漂移」**（上文 C1 第二段的「有意行为微变」注记按此修正：冻结只对显式头
  生效；铸时无 config 贡献的行保持旧的 config-现值跟随行为——兼容读法，
  rfc282-c1-binary-freeze 新增 4 条回归锁）。

**Codex 实现门（第三轮复审，同日）**：修复落地后（28db5370）同 base 全量 diff
再跑，判定「No actionable regressions identified」= **0 findings 收口**。非空洞
证明：job log 451 条命令，修复面被针对性复查（buildChildDeps ×6、nodeRunMint
×10、resolveFrozenRuntime ×12）；其自跑测试仅遇 Codex 沙箱 EPERM（非代码问题
——同 SHA pin-worktree 门禁与 CI 36 checks 均绿）。实现门就此收口。

**仍开放（低优先，独立小项）**：`declaredMcpServers` 改由 `declared.mcpServers`
承接（design §2.1 预留）；系统面统一产出（§7-1a，待 B4 式真身合一时触发）。
