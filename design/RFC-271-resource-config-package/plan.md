# RFC-271 · 任务分解 v4

配套 `proposal.md` / `design.md` v4（统一资源表达 + 配置包；**intent 不迁移**，仅决策 27 的
能力扩张）。
每个批次自带测试，`bun run gate:local` 全绿才推。

## 批次 A · `ResourceBundle` 表达层（shared）

- **T1** `shared/src/bundle/ref.ts`：`BundleRefSchema` **三形态**（`local:` / `external:` /
  **`name:<type>/<name>` late-bound**，第三种只许出现在 call 节点目标槽）+ 解析辅助。
- **T2** `shared/src/bundle/payload.ts`：六类 payload，**逐字段对照正式 create/snapshot
  schema**（不是只列相对 `Intent*Payload` 的差异）。已知两个缺口必须补：agent 的
  `network:'allow'|'deny'`（`agent.ts:267`）、技能文件路径的 Unicode 支持（intent 版只许
  ASCII，正式写路径只要求相对不越界）。引用槽一律 `BundleRef`；工作组人类成员补 `username`；
  技能文件改外部载体引用。
- **T3** `shared/src/bundle/op.ts`：`BUNDLE_OP_KINDS`（含 **`skill-update` / `plugin-update`**）
  + **12 分支严格 discriminated union**（create 必须有 slug、禁 target/expect；update 必须
  external target、禁 slug、**必须**带该类型 expect；kind 与 payload 绑定）+
  `BundleExpectTokenSchema`。⚠️ 缺这条约束时 `mcp-update` 不带 expect 能过 schema，而
  `commitMcpUpdateInTx` 只在 expect 非 undefined 时 CAS ⇒ 无 CAS 覆盖。
- **T4** `shared/src/bundle/bundle.ts`：`BundleSchema` + `assertBundleRefsClosed`
  （**拒重复 slug / 悬空引用 / 悬空 rootRef**）。⚠️ **`ops` 允许为空**（全 reuse 的包），
  引擎走 no-op 成功路径；`rootRef` 允许指向 external。闭包规模上限**显式披露**并配专门错误码。
- **T5** `shared/src/bundle/secrets.ts`：schema-valid 脱敏投影（design §4.2 的载体表），复用
  `SECRET_KEY_RE` / `looksHighEntropy` / `redactUrlForDump` 的判定逻辑，**不复用 dump 投影
  函数本体**。
- **T6** shared 五个测试文件；**`bundle-secrets.test.ts` 必须断言脱敏后仍过各自严格 schema**。

## 批次 B · `BundleApply` 引擎（backend）

**开工前置已完成**：`invariants.md` 是逐条读源码核实的 12 条清单（含锚点与原文引用）。
批次 B 落地后按其末尾的对照表**逐条打勾**——丢一条就是回归。
⚠️ 该表当场查出：9 条归引擎的不变量里，设计初稿只有 1 条完整；I1（scope 串行）、
I3（replay 三态）、I8（post-commit 绝不补偿）此前完全没写。

- **T7** 迁移 + 新表 `resource_bundle_applies`（泛化自 `intent_apply_journal`）。
- **T8** `services/bundle/provider.ts`：`BundleApplyProvider` 接口。
- **T9** `services/bundle/apply.ts`：五段生命周期，从 `applyChangeset.ts` 搬运并泛化。
- **T10** **`skill-update` 三段拆分**：`stageSkillVersion` / `commitSkillVersionInTx` /
  `publishStagedSkillVersion`；既有 `commitSkillVersion` 退化为三段的顺序组合。
  ⚠️ **发布段是 `swapInStaged` 从 staging 发布 live，不是 rename `versions/vN` 候选目录**
  ——后者是永久权威快照，`reconcileSkillLiveFiles()` 与恢复 handler 都依赖它。五相
  （`fs-staged`→`fs-versioned`→`db-committed`→`fs-published`→`done`）与「pre-commit 失败保留
  op 作恢复 oracle、post-commit 失败绝不回滚」逐条保持。
- **T11** **插件 record-before-act**：调用方**预铸** generation/op id，**先把精确路径写进
  journal artifacts**，再调 `installPlugin(..., {generationId})`。⚠️ 只把目录挂到抛出的错误
  上不够——进程可能在 mkdir 之后、返回/抛错之前被 SIGKILL。
- **T12** **最终事务内 owner 断言**（design §5.4）：对每个 update 目标断言
  `ownerUserId === actor.user.id`。引擎层实现，intent 侧同样受益。
- **T12b** **dependency planner + pending seams**：`pendingBundleIds` / `pendingAgentNames`
  让 preflight 接受同 bundle 未落库目标；按类型 + agent `dependsOn` 排序；agent 互相
  `dependsOn` 的闭环给出确定拒绝点。
- **T13** `rfc271-bundle-engine.test.ts` + `rfc271-bundle-owner-gate.test.ts` +
  `rfc271-skill-update.test.ts`。

## 批次 C · intent 的一处能力扩张（决策 27，**不是迁移**）

本 RFC **不迁移 intent**（决策 26）。这里只做一件事：批次 B 的三段技能内核建好后，intent
自己那条路径也能调它。

- **T14** 解开 `copyOnlyTargetsFor`（`applyChangeset.ts:135`）里 skill/plugin 的
  `'in-place update for this resource type is not supported yet'` 分支，改为调用三段内核。
- **T15** ⚠️ **`ownerUserId` 判据一字不动**——他人拥有的资源仍强制 copy；既有 copy 语义
  （slot derivation / copy rewiring / finalName / receipt `fromCopy`）逐条保持。
- **T16** `rfc271-intent-skill-update.test.ts`：**双向锁**——自己的技能原地更新成功、
  他人的技能仍强制 copy。intent 测试套除该分支相关用例外**零改判**。

> 这一条独立成 commit 推送并跑完 CI，与包的工作解耦。

## 批次 D · 配置包导出

- **T18** `util/zip.ts` 的 `encodeZip`（store-only，与 `decodeZip` round-trip 单测）。
- **T19** `services/resourcePackage/closure.ts`：批量装载器 + `walkClosure`。
- **T20** **name 域解析与 `freezeCallClosure` 逐字一致**（AC-7c：cache 优先、其次最老可见），
  且「零匹配」与「全不可见」逐字节同形（AC-7b）。
- **T21** `serialize.ts`：闭包 → `ResourceBundle`（分配 local slug）+ requirements 五段 +
  builtins + secrets 索引 + `ambiguousCallRefs`。
- **T22** 三道门：行级可见性（含传递）/ 分轴特权 / 体积。
  ⚠️ **不要**加第四道类型级 `*:read` 门——AC-7d 是反向锁。
- **T23** `manifest.yaml` + `README.md`（中英双段）生成器。
- **T24** `rfc271-export-gates.test.ts` + `package-closure` 矩阵。

## 批次 E · 配置包导入

- **T25** `parse.ts`：解 zip（复用 `decodeZip` 归一化）+ manifest 校验 + 防夹带 +
  `formatVersion` 判定。
- **T26** `preview.ts`：逐条匹配（`ownMatches[]` 可多个）+ 动作可选性 + 建议名 + 权限缺口 +
  密钥字段 + **`expect` 内容 token 下发**（AC-24b）+ **稳定 `importId`**（AC-24e）+
  **`packageDigest`**（AC-24d）+ 内置件 + 人类席位。
- **T27** `commit.ts`：**校验 `packageDigest`** → **服务端重算 `allowedActions`** → 决策表
  翻译成 `ResourceBundle` → 调引擎。`reuse` 不产 op / `new` → create / `overwrite` →
  update+expect；**指向 reuse 与 overwrite 项的引用都要改写成 `external:`**（v3 只写了
  reuse 那一半）。
- **T28** package `BundleApplyProvider`（`resolveExternal` = 决策表；`readSkillFile` = 从 zip 取）。
- **T29** `rfc271-import-preview.test.ts` + `rfc271-import-commit.test.ts` +
  `rfc271-package-antitamper.test.ts`。

## 批次 F · 路由与 client

- **T30** 六条 `GET /api/{类}/:id/export-package`，**六类都接 exact-revision token**
  （工作流/工作组 `expectedVersion`、代理 `expectedUpdatedAt`、MCP/插件 `expectedConfigHash`、
  技能 `contentVersion`）。
- **T31** `POST /api/resource-packages/preview` + `/commit`，`tokenAccess:'allow'`，
  **路由门只做身份准入**——资源类型权限按包内实际条目动态计算（AC-30c）。挂六类 `*:read`
  的 AND 会与逐条预检自相矛盾。
- **T32** 错误码族登记 + `route-error-code-coverage` 点名。
  ⚠️ 新文件先 `git add -N` 再跑门禁。
- **T33** `client.ts` 八个方法 + `rfc271-routes.test.ts`。

## 批次 G · 前端

- **T34** `lib/resource-package-download.ts`（抽出 `safeDownloadBaseName`）。
- **T35** 六类详情/编辑页「更多操作」导出入口（工作流那条原地改名）。
- **T36** `components/ResourcePackageImportDialog.tsx`（`<Dialog size="full">` + `.segmented`
  + `<Select>` + `<Field>/<TextInput>` + `<StatusChip>`，零自写 chrome）。
- **T37** 六类列表页导入入口 + 统一入口 + 类型不符跳转 + 导入报告视图。
- **T38** 中英双语 i18n（⚠️ i18n 值里禁字面 `**`）。
- **T39** 前端两个测试文件 + **视觉对齐自查**（与 `/agents`、`/workflows`、`/repos`、
  `/settings` side-by-side）。

## 批次 H · CLI

- **T40** `cli/package.ts`：两条命令，**都必须 `--as-user`** 并构造与 HTTP 同构的 `Actor`；
  导出支持 **`--id`**（同 owner 可有两个同名工作流，`--type --name` 选不中）。
- **T41** `--plan` / `--apply` 决策文件 schema；`--on-conflict`（与 `--plan` 互斥）。
- **T42** `cli/start.ts` 注册 + `--help`（写明 break-glass 边界）+ `rfc271-cli.test.ts`。

## 批次 I · 能力下线（C1–C6）

**最后做**，前面全绿后才拆旧的。

- **T43** 删两条旧路由 + `services/workflow.yaml.ts` 中只服务它们的部分
  （⚠️ `workflowDefinitionToSelectors` / `stripCallWorkflowNodeIds` 保留）。
- **T44** 删 `workflow-draft-export.ts` 的本地草稿路径（C3）+ 编辑页救援态按钮。
- **T45** 删 `WorkflowImportDialog.tsx`（C2）。
- **T46** `rfc271-capability-removal.test.ts` + 显式改判既有断言（design §9 表格六项，
  **intent 测试套除 copy-only 分支外零改判**）。

## 批次 J · 文档

- **T47** `docs/resource-bundles.md`：表达层规范（BundleRef / payload / op / 引擎生命周期 /
  Provider 契约）。
- **T48** `docs/resource-packages.md`：包格式、manifest 字段、导入流程与收敛语义、CLI 用法、
  「技能文件树里的密钥属于作者责任」、失败原因对照表。
- **T49** `design/plan.md` 索引改 Done；`STATE.md` 加条目；勘误 RFC-234/199/223/243/270 中
  受影响的表述。
- **T50** `docs/dev-gotchas.md` 沉淀两条通用教训：
  ① **多资源批量落地前先找仓里既成的 bundle / pre-stage / commit 内核**——本 RFC 三轮设计门
  里至少五条 findings 同此根因；
  ② **给模型看的 dump 投影 ≠ 可导入投影**——`projectMcpForDump` 输出的 `oauth` 是字符串，
  直接复用会让产物过不了自己的 schema；
  ③ **泛化一个既有引擎前，先把它的承重不变量列成清单**——凭注释和函数签名推断会漏，
  `applyChangeset.ts` 实际有 ~13 条而不是注释里显眼的那 6 条。

## PR / commit 拆分

| # | 内容 | 独立可绿 |
|---|---|---|
| 1 | 批次 A（表达层） | ✅ 纯 shared |
| 2 | 批次 B（引擎 + 新表） | ✅ 引擎有自己的测试，尚无消费者 |
| 3 | **批次 C（intent 能力扩张）** | ✅ **单独推并跑完 CI** |
| 4 | 批次 D + F 导出半边 | ✅ |
| 5 | 批次 E + F 导入半边 + G + H | ✅ |
| 6 | 批次 I + J | ✅ |

## 验收清单

- [ ] AC-B1…B6 + AC-K1/K2 + AC-1…AC-34 逐条有测试点名
- [ ] **AC-K1/K2：自己的 skill/plugin 可原地更新、他人的仍强制 copy**
- [ ] **AC-15b：伪造 overwrite 他人资源被最终事务拒绝**
- [ ] AC-6：六类文档脱敏后仍过各自严格 schema
- [ ] AC-7b：零匹配 vs 全不可见逐字节相同
- [ ] AC-7c：与 `freezeCallClosure` 逐字一致（cache 优先）
- [ ] AC-7d：反向锁（可见但缺类型权限点 → 导出成功）
- [ ] AC-20：journal 各 phase 边界注入中断 + 重启收敛到二态之一
- [ ] AC-25b：技能覆盖失败后两个技能都没被改
- [ ] `bun run gate:local` 全绿；推后按 exact SHA 查 CI
- [ ] Codex 实现门跑一次并修 findings

## 风险与回滚

| 风险 | 缓解 |
|---|---|
| 决策 27 误伤 intent 既有 copy 语义 | AC-K2 双向锁；`ownerUserId` 判据一字不动；独立 commit 先推 |
| 泛化丢掉某条既有不变量 | 开工前列不变量清单，泛化后逐条对照 + 点名测试 |
| ~~新旧 journal 并存~~ | **随 intent 不迁移而消失**：`intent_apply_journal` 一字不动 |
| `skill-update` 两段拆分回归 | 既有 `commitSkillVersion` 保留为顺序组合 |
| 盘子过大 | 六个独立可绿的 commit |
| C1/C2/C6 打断既有自动化 | 已逐条呈用户确认；发布说明点名 |

**回滚**：批次 I 之前任何时点可停（新路径纯增量）。批次 C 若出问题回滚该 commit 即可——
它只动 intent 的一个分支，引擎与表达层对 intent 零影响。
