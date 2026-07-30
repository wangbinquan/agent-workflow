# RFC-237 意图构建器支持 Claude Code 运行时（proposal）

- 状态：Draft（待用户批准）
- 日期：2026-07-30
- 关联：RFC-234（意图驱动的资源构建）、RFC-235（意图构建 UX，进行中）、RFC-111/112/113/117/143/153/154（runtime 体系）、RFC-224/227（opencode 执行身份）、RFC-233（隔离准入单一事实源）

## 背景

RFC-234 落地的意图构建器（intent builder）把每个生成轮跑在一个冻结只读权限 profile
`intent-read-v1`（工具面 read/grep/glob、会话 cwd 之外 deny）的 ephemeral 系统代理上。
v1 实现里该 profile 只有 OpenCode verified 路径能物化并证明（hermetic 受控配置 +
same-instance attestation），于是运行时选择被三重 fail-closed 锁定为 opencode 协议：

- 保存门：`packages/backend/src/routes/config.ts:79-91`（`intentBuilderRuntime` 解析后
  `protocol !== 'opencode'` → 422 `intent-runtime-unsupported`）；
- 启动门：`packages/backend/src/services/intent/turnEngine.ts:671-676`（launch 时二次校验，
  防手改 config.json / 历史遗留值）；
- driver 门：`packages/backend/src/services/runtime/claudeCode/driver.ts:83-87`（claude
  driver 对任何非 `all-deny` 的 systemPermissionProfile 直接 throw）。

而 claude-code 自 RFC-111 起就是平台的第二运行时（`runtimes` 注册表、完整 driver、模型表、
设置页 picker、业务节点执行全部可用）。五个内置系统代理（commit-push / memory distiller /
merge-conflict resolver / intent builder / skill-fusion）中**唯有 intent builder 拒绝
claude-code**。对已把默认运行时切到 Claude Code 的用户，意图构建功能整体不可用；且前端
`RuntimeSelect` 不按协议过滤（`packages/frontend/src/components/RuntimeSelect.tsx`），用户可以
选中 claude-code、直到保存才收到 422——体验与「runtime 即 profile、注册即扩展」
（RFC-112/143）的产品承诺不一致。

Claude Code CLI 实测（v2.1.220，2026-07-30 本机验证，完整记录见 design.md §2.1）具备物化
只读 profile 的能力面：`--tools Read,Grep,Glob` 直接**裁剪装载工具集**（init 事件回显
`"tools":["Glob","Grep","Read"]`；Write 调用返回 `No such tool available … not enabled in
this context` 的 is_error tool_result，进程不挂起继续运行；Bash 完全不可见）、
`--permission-mode dontAsk` 权限层兜底、`--strict-mcp-config` 空配置下零 MCP、
`--setting-sources ""` 切断 user/project/local settings 注入、私有 `CLAUDE_CONFIG_DIR`
（RFC-111 D16 既有机制）切断 skills / plugins / auto-memory / 凭据面。

## 目标

1. **放行**：intent builder 的运行时选择接受 claude-code 协议——设置页可保存、turn 可启动、
   整链（dump → 生成 → 信封解析 → 草稿 → 提交）与 opencode 行为一致；turn 执行过程
   （RFC-235 Session 视图）在 claude 下同样可见。
2. **受控深度 =「声明式受控 + 加固」**（用户 2026-07-30 拍板）。claude 路径物化
   `intent-read-v1` 为：
   - 工具面：`--tools Read,Grep,Glob` 装载裁剪 + `--permission-mode dontAsk` 兜底
     （**不再** `bypassPermissions`）；
   - 配置面：私有 `CLAUDE_CONFIG_DIR`（既有）+ `--strict-mcp-config` +
     `--setting-sources ""` + `--disable-slash-commands`；
   - 二进制：对齐 opencode 的 copy-seal TOCTOU 围栏（0700 私有目录独占复制、0500、复制
     前后双 hash 与 inode/size/mtime/ctime 复核、exec 前再验）；
   - 环境：剥离 Claude Code 内部运行时标记（`CLAUDECODE` 等）并注入遥测 / 自动更新 /
     非必要流量关闭。
3. **能力声明化**：运行时可物化的窄化 profile 从 protocol 字面量判别改为 `RuntimeDriver`
   能力声明；未声明的（未来第三）运行时在保存与启动两道门仍 fail-closed。同时消除
   RFC-143 源码锁未覆盖的判别旁路（`!==` / `kind` / `defaultRuntime` 形态）并强化该源码锁。
4. **UI 呈现**（用户拍板：标注差异）：设置页 intent 卡 hint 中性化为「仅可选支持只读意图
   构建 profile 的运行时」；当**有效**运行时（显式选择或经 `defaultRuntime` 继承解析后）
   为 claude-code 协议时，额外一行说明：只读约束由 CLI 权限声明实施，无 opencode 的
   配置验证（attestation）。

## 非目标

- 不为 claude-code 构建 attestation / loopback direct-API / behavior codec / session
  owner-lease 的等价物（Claude Code 无对应的服务器可验面；差异以文档 + UI 标注呈现）。
- 不动业务工作流节点的 claude 路径（`--permission-mode bypassPermissions` 现状，
  `packages/backend/src/services/runtime/claudeCode/spawn.ts:105-107`；含 golden byte-lock）。
- 不动 `all-deny` 在 claude 系统代理（distiller / runtime smoke）上的历史语义（RFC-117
  现状：接受该 profile 但以 bypass 语义运行；本 RFC 在 types 注释里如实记录这一差异，
  行为字节不变——见 design.md §1.3）。
- 不加 per-session / per-turn 运行时选择 UI（仍是全局 `config.intentBuilderRuntime` →
  `defaultRuntime` 继承链，RFC-117 三级回落）。
- 不做 `node_runs.opencode_session_id` 等列名遗留清理（claude 复用同列的现状不变）。
- 不改 containment 层（system agent 恒 `runner-filesystem-v1`，
  `packages/backend/src/services/systemAgentRun.ts:263`，两协议一致）。

## 用户故事

1. 管理员在 设置 → System agents → Intent builder 选择 claude-code 协议的 runtime，保存
   成功；发起意图会话，Goal/Generate/Review/Apply 四步旅程正常推进；点开 turn 的执行过程
   能看到 claude 的完整主会话事件流。
2. 管理员把 `defaultRuntime` 设为 claude-code、intent runtime 留空继承：保存与运行同样
   放行；设置页 intent 卡显示 claude 实施差异标注（继承链解析后的有效协议驱动标注）。
3. 未来注册第三协议 runtime、其 driver 未声明 `intent-read-v1` 能力：保存被 422 拒绝，
   错误码仍是 `intent-runtime-unsupported`——fail-closed 语义不因放行 claude 而放松。
4. claude 可执行文件在封印窗口被并发替换（TOCTOU）：turn 以 `identity-failed` +
   `execution-identity-untrusted-binary` 失败并保留 scratch；被替换的字节从未被执行。
5. 管理员的 claude 未登录 / 凭据失效：turn 以清晰的错误结束（claude 的 "Not logged in"
   经 is_error result 上浮为 turn error），不静默降级。

## 验收标准

- [ ] `PUT /api/config` 接受 claude-code 协议的 `intentBuilderRuntime`（反转
      `packages/backend/tests/rfc234-config-intent-runtime.test.ts` 的既有 422 用例），并
      保留「未声明能力协议仍 422」的 fail-closed 用例。
- [ ] `resolveIntentTurnConfig` 放行 claude；mock-claude 全链 turn（seed dump → 信封 →
      changeset → draft 铸造）通过。
- [ ] claude intent spawn plan 断言：argv 含 `--tools Read,Grep,Glob`、
      `--permission-mode dontAsk`、`--strict-mcp-config`、`--setting-sources ""`、
      `--disable-slash-commands`；head 为封印快照路径；`bypassPermissions` 不出现；env 无
      `CLAUDECODE`/内部标记、含 `DISABLE_AUTOUPDATER=1` / `DISABLE_TELEMETRY=1` /
      `DISABLE_ERROR_REPORTING=1` / `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`。
- [ ] 二进制封印：独占复制 + 双 hash + source 竞态复核 + exec 前再验；失败 →
      `identity-failed`；封印实现抽入通用模块后，opencode 侧 import 面与既有
      RFC-224/227 测试**零改动**通过。
- [ ] `systemAgentRun` 子会话补捞改走 driver 能力方法；opencode 行为回归不变（distiller /
      intent / smoke 既有用例）；claude intent turn 的主会话事件经 stdout sink 完整落
      `intent_turn_events`（RFC-235 Session 视图可渲染，含 capture 终态）。
- [ ] RFC-143 源码锁正则强化（`!==` / `kind` / `defaultRuntime` 形态纳入）后全树旁路
      清零；`cli/start.ts` 启动软探入白名单并注明理由。
- [ ] 设置页 hint（en/zh × intentHint/intentRuntimeHint 四处）更新；有效协议为
      claude-code 时渲染差异标注（渲染测试，新测试文件，不触碰他人未提交的
      `settings-system-agents-render.test.tsx`）。
- [ ] `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿；
      推送后按 exact SHA 查 CI。
