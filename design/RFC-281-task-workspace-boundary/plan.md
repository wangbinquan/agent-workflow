# RFC-281 · 任务分解

> 前置：`proposal.md` 用户批准（含能力影响清单 B1-B7 逐项确认）+ Codex 设计门跑完并处置 findings。
> 排程约束：**在 RFC-280 当批（T4-T7 执行器收编）落地后 rebase 动工**（见 design §6）；若届时 `agentInjection.ts` / spawn 装配已被收编，各任务落点跟随新契约（`AgentProcessRequest.files`），任务内容不变。

## 任务

- **RFC-281-T0 · 实测清单落证**（不写生产代码）✅ **完成（2026-08-11）**
  design §5 的 8 项已逐项实测并回填「结论 + 复现」（claude 2.1.227 + Seatbelt / opencode 1.18.16 + deepseek）。**关键校准（改了设计）**：①claude 写面靠 sandbox 默认「写=cwd+tmp+allowWrite」，生产 appHome 在 home 下兄弟默认拒写 → **不下发 denyWrite**，且 denyWrite 祖先根会盖死 cwd（§5-2）；②读面 deny 只列固定敏感文件（宽 glob 误伤自己、allow 挖不回，§5-2 R2/R3）；③init 事件无 sandbox 字段 → 降级改平台自身判断机制可用性（§5-3）；④excludedCommands 数组跨层合并、CLI 压不住项目层 → 归 B8（§5-8）；⑤opencode E3 事故复现 / E2 deny 不翻转 / E4 键序坐实键位纪律。§2/§4.1/§4.4/§7 已按上述同步修订。**实验台教训**：claude sandbox 放行 /private/tmp，写边界必须在 home 下测。
  依赖：无。产出：design §5 实测记录 + §2/§4/§7 校准。

- **RFC-281-T1 · opencode 边界合成（两级）**
  新增 `services/execution/workspaceBoundary.ts`：`composeOpencodeBoundary`（纯函数）+ `BoundaryCtx` 装配（mounts/runDir/stagedSkillDirs/tmpGlobs/**gitMetaDirs** 全部取自 scheduler/runner 既有结构，禁止路径形状推断）。注入两级：顶层 `OPENCODE_CONFIG_CONTENT.permission.external_directory`（覆盖原生子代理，design §3.1）+ 业务 agent 条目级作者白名单合成。改写 `renderOpencodeAgentEntry` 的 RFC-276 注释为「作者声明 + 平台工作区边界」。
  测试：合成键序（含下标断言）/scalar 接管/告警全分支；渲染源码锁；真 opencode 集成（gated）AC-1（含原生子代理）/2/3 红绿对 + AC-8 opencode 敏感面遍历用例 + resume（`--session`）边界仍在。
  依赖：T0。
  - ✅ **part1 完成（`842ed9ab`）**：纯函数 + 9 单测 + M1/M2 策略修正（回填 design §5-9/§3.1：跨层键序不可控 → 每条目自 map 内注入、追加作者 `'*'` 后；顶层只管原生子代理）。
  - ✅ **part2 完成（`92ad0cb7`，主 CI + integration-opencode 双绿）**：`buildInlineConfig` 加可选 `boundaryCtx`（每条目重算 external_directory + 顶层覆盖原生子代理，不传字节不变）；runner 从 `templateMeta.repos[].worktreePath` 提取 `taskMounts`（单仓回退 cwd）→ 扩 `BusinessNodeSpawnContext` → driver 构造 `BoundaryCtx`。scheduler 未动，系统 persona 不碰。8 fixture + rfc143 对拍 + `runner-permission-inject-e2e` 断言更新（RFC-276→281 修订）；pin worktree 完整 gate:local 过。
  - ✅ **part3 完成（`cc8276e0`，主 CI + integration-opencode 双绿；本机真 opencode 5 pass）= gated 真 opencode 集成（AC-1/2/3）**：`tests/integration-opencode/` 复用 gate+auth+`ensureGitRepo`，经生产 `buildInlineConfig(agent,…,boundaryCtx)` 起真 opencode 读兄弟 → DeniedError；mutation 去 boundaryCtx → 读到（红绿对）。provider/model 默认。T0 已 deepseek CLI 手动验证同款，此步固化为 CI。

- ✅ **RFC-281-T2 · claude settings 载体与声明节点修复（`78645971`）**
  `buildClaudeSpawn` 落 per-run `settings.json` + `--settings`（最小形状，design §4.1：`sandbox.enabled` + `allowUnsandboxedCommands:false` + `filesystem.allowWrite`；**无 denyWrite、v1 无 permissions.deny 敏感面**）；`CLAUDE_PLATFORM_OWNED_FLAGS` 扩展；声明 permission 节点补 `additionalDirectories`（读）+ `permissions.allow` 的 `Edit/Write(//<mount>/**)`（写，B4 多仓 mounts 修复，§5-5——业务可用必需）。未声明节点 argv 其余部分逐字节不变（锁）。
  测试：settings 生成器全分支（**无 denyWrite 锁** + allowWrite 只含 mounts/白名单/git 兜底 + 不含 appHome 根）；argv 锁；AC-7（多仓读写正向）。
  依赖：T0。

- ✅ **RFC-281-T3 · claude sandbox 写边界与告警放行（`78645971` + `2ec53a9f`）**
  settings `sandbox` 段（写边界；`gitMetaDirs` 按 §5-6 结论——T0 已证 linked-worktree 自动放行，兜底 allowWrite 仅 fusion/缓存克隆布局需要）；机制可用性判断（macOS=Seatbelt 恒有 / Linux 探 bwrap+socat）→ 不可用则**告警放行不阻断**（结构化日志 + 落观测，两态非多级，§4.4）。
  测试：macOS gated 集成 AC-5（Bash 写兄弟 EPERM / 写 cwd 成功 / `git add+commit` 在 iso worktree 全链成功）；AC-8 claude 敏感面**写**拒绝一条；resume（`--resume`）边界仍在；告警放行分支单测 + 告警断言（AC-6：不静默、不阻断）。
  依赖：T2。

- ✅ **RFC-281-T4 · 作者白名单跨 runtime 兑现（`78645971`；保存面告警改为 spawn 期 driver 告警——同一披露职责、少一处 UI 面）**
  `external_directory` 白名单：opencode 侧殿后合成（T1 已含机制，本任务补语义测试）；claude 侧字面目录 → `additionalDirectories`+`allowWrite`，glob/scalar → 保存告警（agents 保存路由 + i18n 双语文案）。
  测试：AC-4（含 claude 侧真 runtime 读 + **写**用例）；映射函数全分支；保存告警接线（前端可见性走既有告警面，不新建 UI 组件）。
  依赖：T1、T2。

- 🔸 **RFC-281-T5 · 文档 + 收口已完成（`14220a0c`）；DeclaredManifest 声明字段未做（他人占用 startupVerification.ts，见验收清单末条）**
  DeclaredManifest 增 `workspaceBoundary`（**只放声明**：机制/mounts/白名单，不进 prompt）；实际降级级别落 RFC-280 startup verification **观测侧**，同步扩 `declaredHasContent` 与前端 banner 判据（design §6，纯边界 run 也要落库可见）；`docs/OPENCODE_CONFIG.md` 边界章节（机制、白名单写法、残洞清单 B6/B8、措辞不称隔离、**回避 rfc276 守卫词族**，见 proposal §6）；`docs/dev-gotchas.md` 如有新通用坑补录；`design/plan.md` 索引置 Done + `STATE.md` 记账。
  测试：manifest 声明断言 + 判据扩展回归（纯边界 run 落库）；AC-9 文档存在性 + 措辞锁（沿用 rfc276 文档措辞锁模式）。
  依赖：T1-T4。

## PR 拆分

默认单 PR（`feat(runtime): RFC-281 任务工作区边界`）。如 T0 实测周期长，允许拆两笔：PR-1 = T0+T1（opencode 侧独立成立），PR-2 = T2-T5（claude 侧 + 收口）；每笔独立跑全门禁。

## 验收清单（对照 proposal §7）

- [x] **AC-1** opencode 越界拒绝（真 opencode 1.18.16 本机实跑：sibling marker 不出现 + 权限拒绝 + 会话存活；`rfc281-boundary.integration.test.ts`）
- [x] **AC-2** `--auto` 不翻转 deny（同文件 mutation 红绿对：去 boundaryCtx 后同 prompt 读到 sibling marker，复现事故本身）
- [x] **AC-3** 边界开启后自己 worktree 内读写照常（同文件 LIVE 用例；re-allow 清单含 runDir/staged skill/tmp）
- [x] **AC-4** 作者白名单：opencode 殿后合成放行 + scalar 接管（`rfc281-workspace-boundary`）；claude 字面目录 → allowWrite/additionalDirectories、中段 glob → `claude-external-directory-glob-unsupported` 告警（`rfc281-claude-boundary-spawn`）
- [x] **AC-5** claude：settings 下发 + argv 除 `--settings` 外不变（RFC-242 契约锁）；写边界由 sandbox 默认承担（T0 §5-2 真机实测 Bash 写兄弟 EPERM / 写 cwd 成功 / iso 内 git 全链成功）
- [x] **AC-6** 机制不可用 → 告警放行不阻断：`claudeWriteBoundaryAvailability` 四分支测试 + driver `claude-workspace-boundary-unavailable` 告警
- [x] **AC-7** claude 多仓 mounts：allowWrite 全含 + 声明节点补 additionalDirectories（B4）
- [x] **AC-8** 敏感面：opencode 侧断言无 allow 规则匹配 `db.sqlite`/`secret.key`/`token`/`config.json`/其他任务 iso·runs·worktrees + appHome 根从不 re-allow；claude 侧断言均不入 allowWrite
- [x] **§0 业务可用回归**：多仓 allowWrite / 自己 worktree 读写 / 注入资源 re-allow / 作者白名单放行 / boundary 缺失即 fail-open（不发 settings）
- [x] **AC-9** 文档 §3.1 + §6.1（机制、白名单写法、残洞清单、措辞不称隔离）；rfc276 守卫 4 pass 确认无禁词
- [x] **AC-10** pin worktree `gate:local` 跑过（抓到并修 `runner-permission-inject-e2e` × 2 与 `runtime-extra-args` × 1）；exact-SHA 主 CI + integration-opencode 双绿

## 实现门（2026-08-11）

Codex `codex exec` 连续 wedge（0 字节输出、零 CPU，与 memory 记录的已知问题同形），按止损姿势改用**独立子代理**（全新上下文 + 同强度对抗 prompt + 「构造不出具体失败输入的丢弃」）执行等效评审，如实记录该替代关系。报 13 条，**全部处置**（`8fb0167e` / `d9190c0a` / `b981f75c`）：

- **P1-1 dontAsk 多仓写不可用**（AC-7 名不副实）：补 `permissions.allow` 的 `Edit(//<dir>/**)`。核官方文档纠正两处：`//` 前缀才是文件系统根（`/mnt/a` → `Edit(//mnt/a/**)`，非三斜杠）；只发 `Edit(...)`（覆盖 Write/NotebookEdit，单独 `Write(...)` claude 接受却从不查询 = 无效行）。
- **P1-2 机器级 skill 根被静默切断**：deny 基线遮蔽了 opencode 默认白名单里的 `skill.dirs()`（`~/.claude/skills` 等）→ SKILL.md 进 prompt 但读同目录脚本被拒。新增 `machineSkillRoots()` 按同口径放行回来（proposal B9）。
- **P1-3 `allowUnsandboxedCommands:false` 焊死逃生阀**：claude schema 原文为 false 时 `dangerouslyDisableSandbox` 被完全忽略——典型 build 节点（写 `~/.bun/cache` 等）撞 EPERM 后无人可救。改为不下发该键（proposal B10）。
- **P2-4 存量 extraArgs 可顶掉边界**：spawn 期过滤平台独占 token + 告警。
- **P2-5 原生子代理 LIVE 用例缺失**（顶层注入是唯一依赖跨层合并、且唯一没真跑验证的一级）：补 task→`general` 委派读兄弟的 LIVE 用例，**本机真 opencode 7 pass**。
- **P2-6/P2-7 claude 拒绝分支与 AC-6 告警零断言**：新增 `boundaryHostProbe` 注入 seam（生产省略=行为不变）+ 三条断言（缺机制仍 spawn 且告警 / 可用主机不告警 / 作者 glob 披露）。
- **P3-7/P3-8/P3-9/P3-10/P3-11/P3-12**：§0 guard 提纯函数 `resolveBoundaryMounts` 并加源码锁（原测试是复制品）、AC-8 改为遍历 `Paths` 并按 findLast+Wildcard 真实语义裁决、fail-open 判据先过滤空串、`gitMetaDirs` 未接线状态写进类型注释、`agentInjection` 过期注释改写、集成测试 ctx 与生产对齐 + 补 AC-3 staged-skill 回归。

## 第二轮实现门（2026-08-11，评审「上一轮修完的终态」）

双路并跑（Codex 直驱 —— 清掉一个陈旧 broker 后恢复正常；+ 独立子代理交叉评审），两路共 20+ 条、多条独立命中同一问题。**独立子代理用真 claude 2.1.227 做了红绿实验**，推翻本 RFC 一个根本假设，我逐条亲手复现后修完（`1e64d691` / `5a50b42a` / `ba622f6b`，另 `ecb40719` 是评审期间的自查发现）：

**根本性发现：claude 的 sandbox 是命令级围栏，不是文件写边界。** 它只管 Bash/子进程；`Edit`/`Write`/`NotebookEdit` 是进程内工具、只由 `permissions` 层裁决，而未声明 permission 的节点走 `bypassPermissions` 把那层整个跳过 ⇒ **RFC 起因的事故形态在 claude 默认节点上原样可复现**（实测：Write 工具把文件写进了兄弟任务目录）。T0 只测了 Bash 写（那条确实被拦），恰好只覆盖成立的那一半。

- **P1-1 修**：下发兄弟任务目录的 `Edit`/`Read` deny（deny 在所有 permission-mode 下都生效）。只列兄弟的**具体**目录、绝不含本任务任何路径。实测：越界 Write 被拒、cwd 内 Write 照常。`scanSiblingTaskRoots()` 扫 appHome 的 iso/runs/worktrees，**按 taskId 排除自己在其他容器下的目录**——新测试当场抓到：只按 mount 前缀排除会把自己任务的 runs/worktrees 当兄弟 deny 掉。
- **P1-2 修**：钉死 `autoAllowBashIfSandboxed: false`。它默认 true ⇒ sandbox 一开 Bash 自动放行、不再过 permission 判定；实测「开 sandbox 反而读到了兄弟 secret，不开反而被拒」——我引入的、方向相反的能力扩张。修后实测越界读被拒、cwd 内读照常。
- **P1-3 用户决策保留 + 如实文档化**：模型撞 EPERM 后可自行 `dangerouslyDisableSandbox` 重试成功（实测复现，headless 下无需批准、平台无日志）。关掉它会让 build 节点（写 `~/.bun/cache` 等）无人可救 —— 保留，但文档写明「Bash 那半边界是**劝告性**的」。
- **P2 键序抬升**（两路共同命中，已用 remeda mergeDeep 语义复算证实）：项目配置只要提一句 `external_directory` 就能把平台键抬到作者 `'*'` 之前、findLast 取 allow ⇒ 边界溶解。**不再依赖键序**：把作者顶层 `'*'` 展开成具体权限名，`external_directory` 由平台独占。
- **P1（Codex）claude dependsOn 子代理白名单未进 settings**：settings 是整进程的、子代理共享，只取 root 会让子代理声明静默失效 ⇒ 合并 root + 每个 dependent。
- **P2 `--add-dir` 漏出平台独占列表**（存量 runtime 行写 `["--add-dir","/"]` 即扩到根）+ extraArgs 丢弃循环按 valueless/variadic/单值精确消费（原实现对变参只吃一个值，留下的游离 token 会被 claude 当 prompt）。
- **P3 作者白名单 `~`/`$HOME`/相对路径**：opencode 展开、claude 不展开 ⇒ 原实现生成 `/~/refrepo` 这种垃圾路径且 lossy 为空（作者以为兑现了）。现同口径展开，非绝对路径进 lossy 走告警。
- **自查 S1/S2**（评审期间探针发现）：`claudeEditRuleFor` 对含 `)` 的目录名生成语法破损规则、对目录名里真实的 `*` 生成放宽规则。核实官方文档确认规则是 gitignore 语法且「自写规则不转义」、右括号无转义说明 ⇒ 按「不确定就别生成」处理：含 `( ) * ? [ ] \` 的目录不进 `permissions.allow`，仍进 sandbox `allowWrite` 与 `additionalDirectories`（纯路径列表），并打告警。
- **测试有效性 P2/P3**：AC-8 用例改用**生产同源 ctx** + 真实默认裁决（`ask`），并做**变异实证**（注入一条 `${homedir}/*` allow → 当场变红，还原即绿；修之前抓不到）；原生子代理 LIVE 用例的阳性对照真跑发现**委派链无边界时挂到 300s 超时**（真 LLM 不可靠），改为确定性 wire 断言，LIVE 仍证明 opencode 遵守该形状。
- **local MCP 子进程**：如实列入不覆盖面 —— 独立进程、不经权限层，要约束需 OS 沙箱（RFC-276 废弃、本 RFC §3 非目标）。

`gate:local` 全绿（backend 9501 / frontend 6275）；真 opencode gated 集成 8 pass。

**未做（有意，已登记）**：DeclaredManifest 的 `workspaceBoundary` 声明字段与前端观测面——`startupVerification.ts` 在本轮全程被并行 RFC-280 session 占用（未提交改动），按多人协作原则不动他人在途文件；该项是观测增强、不影响边界功能本身，留作独立跟进。resume 边界重注入已由 T0 §5-7 实测确认（claude `--resume` 重新应用本次 `--settings`；opencode `--session` 同一注入路径），未单独加 CI 用例。
