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

- **RFC-281-T2 · claude settings 载体与声明节点修复**
  `buildClaudeSpawn` 落 per-run `settings.json` + `--settings`（最小形状，design §4.1：`sandbox.enabled` + `allowUnsandboxedCommands:false` + `filesystem.allowWrite`；**无 denyWrite、v1 无 permissions.deny 敏感面**）；`CLAUDE_PLATFORM_OWNED_FLAGS` 扩展；声明 permission 节点补 `additionalDirectories`（读）+ `permissions.allow` 的 `Edit/Write(//<mount>/**)`（写，B4 多仓 mounts 修复，§5-5——业务可用必需）。未声明节点 argv 其余部分逐字节不变（锁）。
  测试：settings 生成器全分支（**无 denyWrite 锁** + allowWrite 只含 mounts/白名单/git 兜底 + 不含 appHome 根）；argv 锁；AC-7（多仓读写正向）。
  依赖：T0。

- **RFC-281-T3 · claude sandbox 写边界与告警放行**
  settings `sandbox` 段（写边界；`gitMetaDirs` 按 §5-6 结论——T0 已证 linked-worktree 自动放行，兜底 allowWrite 仅 fusion/缓存克隆布局需要）；机制可用性判断（macOS=Seatbelt 恒有 / Linux 探 bwrap+socat）→ 不可用则**告警放行不阻断**（结构化日志 + 落观测，两态非多级，§4.4）。
  测试：macOS gated 集成 AC-5（Bash 写兄弟 EPERM / 写 cwd 成功 / `git add+commit` 在 iso worktree 全链成功）；AC-8 claude 敏感面**写**拒绝一条；resume（`--resume`）边界仍在；告警放行分支单测 + 告警断言（AC-6：不静默、不阻断）。
  依赖：T2。

- **RFC-281-T4 · 作者白名单跨 runtime 兑现与保存面**
  `external_directory` 白名单：opencode 侧殿后合成（T1 已含机制，本任务补语义测试）；claude 侧字面目录 → `additionalDirectories`+`allowWrite`，glob/scalar → 保存告警（agents 保存路由 + i18n 双语文案）。
  测试：AC-4（含 claude 侧真 runtime 读 + **写**用例）；映射函数全分支；保存告警接线（前端可见性走既有告警面，不新建 UI 组件）。
  依赖：T1、T2。

- **RFC-281-T5 · 声明/观测面 + 文档 + 收口**
  DeclaredManifest 增 `workspaceBoundary`（**只放声明**：机制/mounts/白名单，不进 prompt）；实际降级级别落 RFC-280 startup verification **观测侧**，同步扩 `declaredHasContent` 与前端 banner 判据（design §6，纯边界 run 也要落库可见）；`docs/OPENCODE_CONFIG.md` 边界章节（机制、白名单写法、残洞清单 B6/B8、措辞不称隔离、**回避 rfc276 守卫词族**，见 proposal §6）；`docs/dev-gotchas.md` 如有新通用坑补录；`design/plan.md` 索引置 Done + `STATE.md` 记账。
  测试：manifest 声明断言 + 判据扩展回归（纯边界 run 落库）；AC-9 文档存在性 + 措辞锁（沿用 rfc276 文档措辞锁模式）。
  依赖：T1-T4。

## PR 拆分

默认单 PR（`feat(runtime): RFC-281 任务工作区边界`）。如 T0 实测周期长，允许拆两笔：PR-1 = T0+T1（opencode 侧独立成立），PR-2 = T2-T5（claude 侧 + 收口）；每笔独立跑全门禁。

## 验收清单（对照 proposal §7）

- [ ] AC-1 opencode 越界拒绝（真 runtime，红绿对；含原生子代理用例）
- [ ] AC-2 `--auto` 不翻转 deny（mutation 证明）
- [ ] AC-3 skill/tmp/tool-output re-allow 回归
- [ ] AC-4 作者白名单 opencode 放行 + claude 读写用例 + scalar 接管 + ask 告警
- [ ] AC-5 claude Seatbelt 越界写拒绝 / cwd 写成功 / iso 内 git 全链成功 / argv 其余不变
- [ ] AC-6 sandbox 不可用时告警放行、不阻断、不静默（有告警+测试）
- [ ] AC-7 claude 多仓 mounts 可读写（读=additionalDirectories，写=permissions.allow）
- [ ] AC-8 opencode 敏感面读写拒绝（paths.ts 遍历）+ claude 敏感面写拒绝一条（读 v1 不测）
- [ ] §0 业务可用回归：多仓写 / git 全链 / 注入资源可读 / 作者白名单放行正向用例
- [ ] AC-9 文档章节 + 措辞锁（回避守卫词族）
- [ ] resume 双 runtime 边界重注入回归（T1/T3）
- [ ] AC-10 `gate:local` 全绿；推后 exact-SHA CI 确认
