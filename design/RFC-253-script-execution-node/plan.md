# RFC-253 · 脚本执行节点 —— 任务分解

> 产品视角见 [proposal.md](./proposal.md)，技术设计见 [design.md](./design.md)，
> 设计门结论见 [design-gate-2026-08-03.md](./design-gate-2026-08-03.md)（判定不通过，findings 已逐条折入本文件）。
>
> **交付形态：main 上的原子提交切片**（设计门 F11）。本仓硬规则是主干开发、禁止分支与 PR
> （CLAUDE.md §工作准则），所以下面的 S1–S5 是**提交切片**，不是 PR。每个切片自带测试，
> 推前跑满 `typecheck && lint && test && format:check && depcheck`。

## 切片拓扑

```
S1 地基（shared 纯逻辑 + 8 张穷尽表 + 校验器 + 权限点定义）
  └─ S2 执行器（containedSpawn + 出网围栏 + 脚本 lifecycle）
        ├─ S3 依赖预装
        └─ S4 权限门 + 脱敏 + 读投影
              └─ S5 前端（CodeEditor + 节点 UI + 存量替换 + e2e）
```

S3 与 S4 互不依赖。S5 依赖 S4（无权只读态要有真门在）。

> **依赖倒置已修**（设计门 P1）：原 T17 承诺完整 lifecycle 却把 `ensureScriptDepsEnv` 排在 T20、
> 把解释器 config 排在 T26。现在 S2 只交付「无依赖脚本」的完整 lifecycle，S3 再把依赖阶段接进去；
> 解释器 config schema 提前到 S2 内。

---

## S1 · 地基

| #      | 任务                                                                                                                                                                                                                                | 验收                                                                                                                             |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **T1** | `schemas/workflow.ts`：`'script'` 进 `NODE_KIND`；新增 `SCRIPT_LANGUAGES` / `SCRIPT_DEFAULT_OUTPUT_PORT` / `ScriptOutputPortSchema` / `ScriptNodeSchema` 等。**不** bump `$schema_version`                                          | v1–v4 兼容 fixture 全绿                                                                                                          |
| **T2** | 填**全部 8 处**穷尽点：`node-kind-behavior` / `nodePorts` / `workflow-node-references`（含新增 `opaqueFields` 描述符）/ `runLiveness.livenessSourceOfKind` / 前端 `WorkflowCanvas` / `NodeInspector` / `nodePalette` / `wrapperFit` | 编译即门；`env` 键名叫 `FOO_NODEID` 时不再刷假的 `node-reference-inventory-unmanaged`                                            |
| **T3** | `shared/scriptNode.ts` 纯函数：`scriptEnvSuffix` / `scriptPortEnvCollisions` / `declaredScriptOutputs` / `scriptOutputMode` / `planScriptPortEnv`（32 KiB 单值、256 KiB 累计、确定性排序）                                          | 两个边界值 + 冲突 + 排序确定性各一例                                                                                             |
| **T4** | `serializeScriptSensitiveProjectionV1`：**脚本字段 + 入边 + wrapper 归属与迭代上限**（设计门 P1）。返回规范化字符串而非哈希（`workflow-canonical.ts` 先例，碰撞面归零）                                                             | 改正文/依赖/env/network/readonly/outputs/增删/**改入边**/**挪进 wrapper**/**改 maxIterations** ⇒ 变；改位置/标题/无关节点 ⇒ 不变 |
| **T5** | 依赖校验**按语言分档** + 精确版本强制；`normalizeScriptDependencies`；`serializeScriptDepsEnvKeyV1`                                                                                                                                 | pip/npm 正例各 3 条 + 反例 7 条（flag / URL / VCS / 路径 / 元字符 / marker / 未钉版本）                                          |
| **T6** | `SCRIPT_FAILURE_CODES` 进 `FAILURE_CODES`（emit + 读双域，不进 followup 域）                                                                                                                                                        | 历史码 + 新码混合分页解析不炸                                                                                                    |
| **T7** | `permission.ts` 新增 `scripts:author`：进 `SYSTEM_DOMAIN_POINTS` + `MANAGER_EXTRA`；不进 `USER_BASELINE` / `MANAGER_DENIED_PERMISSIONS`。**不**登记 `HANDLER_CONSUMED_POINTS`（该符号不存在——设计门 F2）                            | admin 有 / manager 有 / user 无 / 任何 PAT 都不含；另加「系统域 ≠ 仅 admin」正交性锁                                             |
| **T8** | 校验器规则（design §9 全表，含 `script-in-fanout-unsupported`、`script-output-kind-path-unsupported`、`script-env-key-reserved`、`script-dependency-version-unpinned`）                                                             | 每条一例，`target.nodeField` 定位正确                                                                                            |
| **T9** | `workflow-yaml.ts` 脚本节点导出/导入（env 值按 **T24** 脱敏占位）                                                                                                                                                                   | 往返等价（env 走脱敏语义断言）                                                                                                   |

## S2 · 执行器

| #       | 任务                                                                                                                                                                                                                                                         | 验收                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| **T10** | `services/execution/containedSpawn.ts`：包沙箱、行泵、**独立的原始字节累加器**（设计门 F8）、kill 升级链、`onSpawned` 回执（设计门 P0-3）                                                                                                                    | 正常/非零/超时/abort/起不来/顽固子进程 六条路径；`a\n\nb\n` 端口值逐字保留 |
| **T11** | `Bun.spawn` 站点登记棘轮，runner 既有站点入表标 `removeWhen: 迁移到 containedSpawn（WP-2）`                                                                                                                                                                  | 变异实证：新增未登记站点即红                                               |
| **T12** | 出网围栏：能力 `outerNetworkDeny` + **一个** profile `outer-netless-v1`（复用 `runner-filesystem-v1` 作 allow 档——设计门 F3）；Linux `--unshare-net` + `--tmpfs /run` + `--tmpfs /var/run`（设计门 P0-2）；macOS `(deny network*)` 置于 `(allow default)` 后 | 渲染字节锁；SBPL 顺序错位用例必红                                          |
| **T13** | fail-closed 由 **coordinator 拥有**：profile 带 `failClosed`，`#evaluate` 对该档在 enforce/warn/off 三档一律 `blocked`；caller 只 `await admit()`                                                                                                            | 三档各一例；另加「caller 不含任何 mode 判断」的源码锁                      |
| **T14** | `services/scriptRun.ts`：解释器解析（PATH + config 覆盖，config schema 一并落）、环境装配（**平台键最后覆盖**、保留表拒绝）、脚本与溢出输入物化到 run 私有目录                                                                                               | 环境最小集 / 私有 HOME / 覆盖顺序 / 溢出落盘 各一例                        |
| **T15** | `scheduler.ts` `runOneNode` 的 `script` 分支：**复用原语而非 agent 那段循环**（设计门 F6），自带 pending→running（DB 先写再广播）、iso/merge-back、重试循环、canceled vs interrupted                                                                         | 最小流 / 非零 / 超时 / 取消 / 重试后 iso 重建                              |
| **T16** | 产出收口：单端口取原始字节；信封走 `extractLastEnvelope(_, nonce)` + `parseEnvelope`，**显式**判 `missingDeclared` → `script-port-missing`、`malformedPorts` → `script-envelope-malformed`                                                                   | nonce 拒伪 + 缺端口 + 破损信封 各一例                                      |
| **T17** | 事件与审计：stdout/stderr 逐行入事件、截断显式标记、`pid`/`spawn_binary_path`/`{script:{interpreter,…}}` 落库、token 列 NULL                                                                                                                                 | 事件顺序 + 截断标记 + `tok_*` NULL                                         |
| **T18** | 不可重试码接进真实永久失败 predicate（设计门 P1）                                                                                                                                                                                                            | 四个码各断言「不进重试」                                                   |
| **T19** | D24 分路径测试：普通 fresh retry / wrapper-loop 迭代 / resume 三条（fanout 已按 F7 禁止）                                                                                                                                                                    | 三条各一例                                                                 |

## S3 · 依赖预装

| #       | 任务                                                                                                                                                                                                         | 验收                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| **T20** | `ensureScriptDepsEnv`：命中 manifest 零进程零网络复用                                                                                                                                                        | spawn 计数断言                                                               |
| **T21** | 安装走 `containedSpawn` + `runner-filesystem-v1`（独立放网）；pip `--only-binary=:all:`、npm `--ignore-scripts`；私有 HOME/TMPDIR。**如实记录**：外层沙箱不是 jail，安装器仍能写 appHome 外路径（设计门 F4） | 源码分发包 ⇒ 失败且无 `setup.py` 执行                                        |
| **T22** | 原子上架 + 并发（rename + 按 depsHash 的 in-process mutex）                                                                                                                                                  | 两节点并发首用同一集合 ⇒ 一份环境、双成功                                    |
| **T23** | 只读挂载：复用 `policy.readOnlyAllowSubtrees`（设计门 F5，不新造入参）；注入 `AW_DEPS_DIR`/`PYTHONPATH`/`NODE_PATH`；**readonly 档一并把 `${appHome}/repos` 降级只读**（设计门 P1）                          | 能 import；写 envDir 被拒（**Linux/macOS 各跑一次真实写探针** —— 设计门 P2） |
| **T24** | 失败面 + 解析结果落 manifest/运行记录；安装超时 config                                                                                                                                                       | 三种失败形状各一例                                                           |
| **T25** | 回收：每小时后台任务按 `lastUsedAt` + TTL 整棵删；命中即 touch                                                                                                                                               | 过期/未过期/touch                                                            |

## S4 · 权限门、脱敏、读投影

| #       | 任务                                                                                                                                                    | 验收                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **T26** | `assertScriptAuthorAllowed` 落在**持久化原语** `insertWorkflowInTx` / `prepareWorkflowSave`（设计门 P1），而非仅 HTTP 入口；copy 以显式 provenance 放行 | 403 矩阵：新建/保存/YAML 导入(new+overwrite)/intent create/intent update 各一例 |
| **T27** | 无点者可复制、可启动（D21 / AC-24），并加锁防未来"顺手也加上"                                                                                           | 两例                                                                            |
| **T28** | 脱敏：`intentSecretSlots` 新增 `script-node-env` carrier，接进详情/列表/YAML 导出/校验器消息/诊断五个读面；执行期明文                                   | ✅ 2026-08-07：见 AC-22…28 行；残留=任务快照面已登记 `docs/audit-backlog.md`    |
| **T29** | env 键校验：`mcpEnvIssues` 复用 + 脚本保留表（设计门 P1）                                                                                               | 非法名/NUL/`LD_*`/保留键/`AW_` 前缀 各一例                                      |
| **T30** | MCP/REST 负向锁：全矩阵 PAT 仍 403                                                                                                                      | 一例                                                                            |
| **T31** | **读投影**：NodeRun DTO 暴露解释器路径 + depsHash（设计门 P1，AC-35）                                                                                   | DTO 断言                                                                        |

## S5 · 前端

| #       | 任务                                                                                                                                                                   | 验收                                                    |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **T32** | 公共 `components/CodeEditor.tsx`（CodeMirror 6，`--code-*` 主题令牌、inset 焦点环、Tab 缩进但 Esc 可逃出）                                                             | 受控值/只读/双主题/键盘可达                             |
| **T33** | 调色板新分区 `scripts` + 描述符 + `wrapperFit` 尺寸；**picker 分类条与计数表**（设计门 P2：`WorkflowNodePicker.tsx:140`、`lib/workflow-node-picker.ts:86` 是非穷尽的） | 拖放落节点 + 分区计数                                   |
| **T34** | `nodes/ScriptNode.tsx` 卡片（语言/依赖数/deny/readonly 标记）                                                                                                          | 组件测试                                                |
| **T35** | `inspector/ScriptEdit.tsx`（语言 segmented、CodeEditor、端口编辑、依赖 ChipsInput、env 表、两个 Switch、**入参提示区**）                                               | 入参提示随边变化；依赖非法即时报错                      |
| **T36** | 无权只读态 + `<ErrorBanner>`（AC-30）；重试副作用文案（D24）落 UI 与 `docs/`                                                                                           | 组件测试 + 文案断言                                     |
| **T37** | 前端开放式输入链（设计门 P1）：`dropTarget.ts:65`、`workflow-connection-plan.ts:451`、`workflow-transition.ts:82` 三处把 script 当开放输入                             | 三处各一例                                              |
| **T38** | G3 多文档 review：`nodePorts.resolveReviewInputKind` + 前端 connection-plan + 后端 validator 三层放行脚本作为 review 源（设计门 P1）                                   | 三层各一例                                              |
| **T39** | 存量替换：`JsonField` / `McpFields`×2 / `PluginFields` / `routes/workflows.tsx` YAML 导入框；散文类不动                                                                | 相关 e2e 全绿 + 视觉基线更新                            |
| **T40** | i18n 双语齐全                                                                                                                                                          | i18n 完备性测试                                         |
| **T41** | e2e：拖入 → 写代码 → 连线 → 启动 → 见 stdout → output 拿到值（Chromium + WebKit）                                                                                      | 双浏览器绿                                              |
| **T42** | `intentDoc.ts` supported node forms 补 script（设计门 P2）                                                                                                             | ✅ 2026-08-07：`rfc234-intent-doc.test.ts::RFC-253 T42` |
| **T43** ✅ 2026-08-07 | **作者辅助样例**（design §8.3，AC-37…40，起因=用户实测「信封怎么写 / nonce 怎么填」）：shared 加 `buildScriptEnvelopeSnippet` / `buildScriptInputSnippet` 两个纯函数（按语言转义分档，nonce 从环境读）；`ScriptEdit.tsx` 输出区与输入区各挂 `<CodeEditor readOnly>` + `btn--xs btn--ghost` 复制（`copyText`）；订正 `scriptInspector.outputEnvelope` 的误导文案（双语） | 三语言样例**真跑一遍**后经 `parseEnvelope` 全端口解析；端口名含引号/反引号/`$`/`\` 仍语法正确；样例随端口与语言变；单端口模式不出样例 |

## AC → 测试追踪表（设计门 P1 要求，替代"AC 各有测试"这种不可证伪表述）

实现期逐行填 `测试文件::用例名`，空行即未交付：

| AC              | 测试文件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 可观察 oracle                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| AC-1 / 2 / 3    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 端口值逐字节相等 / 环境变量存在性           |
| AC-4            |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | fanout 真实扇出分片数                       |
| AC-5 / 5b / 5c  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 伪造信封不被采信 / 失败码 / `a\n\nb\n` 逐字 |
| AC-6 / 7 / 8    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 终态 + exit_code + 无孤儿                   |
| AC-9 / 10       |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `git_diff` 含改动 / canonical 未被写        |
| AC-11 / 11b     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 校验器报错码                                |
| AC-12 / 13 / 14 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 真实出网被拒（**两平台各一次**）/ 三档阻断  |
| AC-15 / 16      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 读不到 crown jewels / 保留键被拒            |
| AC-17 … 21      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | spawn 计数 / 无 `setup.py` / 写 envDir 被拒 |
| AC-22 … 28      | 403：`rfc253-script-author-gate.test.ts`；脱敏五面（T28，2026-08-07）：`intent-secret-slots.test.ts::RFC-253 T28`（carrier+dump 走查器+诊断掩码）· `rfc234-dump-builder.test.ts::RFC-253 T28`（intent dump）· `rfc234-resolve-bundle.test.ts::RFC-253 T28`（sentinel 槽位/字面拒绝/回填）· `rfc247-token-redaction.test.ts::RFC-253 T28`（详情/列表/导出等 7 出口 PAT 掩码 + 接线计数锁）· `rfc253-script-validator.test.ts::T28`（校验器消息不回显值）· `rfc253-script-execution.test.ts::T28`（scheduler 诊断掩码源码锁）；明文：`rfc253-script-execution.test.ts::T28`（assembleScriptEnv 逐字） | 403 码 / 脱敏五面 / 明文                    |
| AC-29 … 32      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 组件与 e2e                                  |
| AC-33 … 36      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 事件流 / DTO 字段 / 重启后可定位 pid        |
| AC-37 … 40      | 生成器：`rfc253-script-node.test.ts::T43 — envelope snippet` / `::T43 — input snippet`（shared，含引号/`$`/反引号/换行转义与单端口空串）；**真跑**：`rfc253-script-snippets.test.ts`（backend，三语言 × 信封解析 / 恶意端口名 / 内联读取 / 溢出回落，argv 与扩展名直接 import `INTERPRETER_SPEC`）；UI：`rfc253-script-snippet-inspector.test.tsx`（前端，单端口无样例 / 只读 + 语言跟随 / 复制内容不含字面 `$AW_ENVELOPE_NONCE` / 输入样例先查溢出）；AC-40：`rfc253-script-validator.test.ts::a port name that no envelope can express is refused at save time` | 样例真跑后可被 `parseEnvelope` 解析 / 组件  |

## 交付前必过清单

- [ ] 8 处穷尽点全部填齐（编译即门）
- [ ] AC 追踪表**无空行**
- [ ] 两平台围栏真实探针（Linux `--unshare-net` + macOS `deny network*`）
- [ ] fail-closed 三档各一例，且 caller 无 mode 判断（源码锁）
- [ ] 供应链：源码包拒绝 / 依赖反例 / 缓存只读**真实写探针**
- [ ] 权限：五个持久化入口 403 + 复制放行 + 启动放行 + PAT 不可达
- [ ] `Bun.spawn` 棘轮变异实证
- [ ] `typecheck && lint && test && format:check && depcheck` 全绿
- [ ] 推后按**自己的确切 sha** 查 CI
- [ ] Codex **实现门**跑一次并修 findings
- [ ] `design/plan.md` 索引与 `STATE.md` 同步；`docs/audit-backlog.md` 登记三条残留
      （git `filter.*` 侧入口的第二消费者、macOS `setsid()` 后代、外层沙箱非 jail）
