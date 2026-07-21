# RFC-205 — 任务分解

单 RFC 单批交付(后端为主 + 前端状态 chip)。依赖:RFC-204 已 Done(url_enc/urlRedacted 既有)。

- **RFC-205-T1** `services/sandbox/policy.ts`:`computeSandboxPolicy` + `renderSeatbeltProfile`
  (SBPL 转义)+ `renderBwrapArgs`。单测(测试策略 §4-1)。
- **RFC-205-T2** `services/sandbox/probe.ts`(探测+缓存,spawnFn 可注入)+ shared config
  `sandboxMode`('enforce'|'warn'|'off',default 'warn')+ DEFAULT_CONFIG。单测(§4-3)。
- **RFC-205-T3** `services/sandbox/index.ts`(`wrapSandbox`/`buildSandboxCtx`)+ 三处 spawn
  接线(runner / memoryDistiller / runtimeSmoke;可选 ctx,缺省零包装)+ 降级 alert
  (lifecycle_alerts rule=`sandbox-degraded`,每任务去重)+ enforce launch 拒
  (`sandbox-unavailable`)。单测(§4-2/§4-4)。
- **RFC-205-T4** G1 origin 凭据下盘:clone 后 `set-url origin <redacted>`、`runGitAuthed`
  (askpass + 0600 凭据文件)、存量镜像幂等清洗、helper 脚本落盘。测试(§4-5)。
- **RFC-205-T5** 可观测:`/api/runtimes/status` 加 `sandbox` 字段 + 前端 RuntimeTab
  StatusChip + i18n 双语 + 前端 vitest。
- **RFC-205-T6** gated 集成测试(§4-6,机制探测到才跑)+ 回归红线全量(§4-7)。
- **RFC-205-T7** 文档(docs/sandbox.md 或并入现有 runtime 文档)+ `design/plan.md` 索引 /
  STATE.md 登记。

## 验收清单(对 proposal §5)

- [x] AC-1 沙箱生效时 secret.key/db.sqlite/backups/他任务 worktree 拒,本任务 worktree/
      runDir/镜像/auth 通(gated 集成)。
- [x] AC-2 被沙箱 agent 内 git diff/log/status/commit 正常(worktree gitdir→镜像放行)。
- [x] AC-3 新 clone 与存量清洗后镜像 config 无凭据;fetch/push 照常(askpass)。
- [x] AC-4 三档语义(enforce 拒/warn 降级告警一条/off 逐字节同现状——wrap 零调用锁)。
- [x] AC-5 Settings→Runtime 可见可改,即时生效。
- [x] AC-6 既有桩/golden/e2e 零破坏(不装配 ctx 即零包装)。
- [x] AC-7 spawn 日志 + 降级 alert 可追溯。
- [x] AC-8 全门禁绿,新行为全带测试。

## 交付记录（2026-07-22，单批）

T1-T7 全交付。AC 逐条：AC-1/AC-2 由 gated 真机集成锁（RUN_SANDBOX_ITEST=1,macOS 实测
sandbox-exec 拒读 secret.key/db、放行本任务 worktree；镜像读写放行使 git 全功能保留）；
AC-3 clone 用 redacted+askpass 生来无凭据+warm fetch 幂等 set-url 清洗存量+源码锁（变异
必红）；AC-4 三档语义测试（off 由「全部既有测试零 provider 全绿」自证零包装）；AC-5
RuntimeSelect 沙箱徽章+segmented(PATCH sandboxMode)+i18n；AC-6 golden/argv 桩/镜像家族/
runner 家族零改动全绿；AC-7 spawn 日志 sandboxed 标记+sandbox-degraded 每任务去重告警
（单测锁）；AC-8 typecheck/lint/format/后端全量/前端 5090/单二进制 smoke 全绿。

**实现即评审的真伤修复**：gated 集成首跑抓到 macOS $TMPDIR 符号链接使 SBPL 按内核真实
路径匹配、deny 静默落空——wrapSandbox 对全部策略根 realpath 规范化（符号链接 $HOME 部署
同修）。**范围修订**：memoryDistiller/runtimeSmoke 两处系统代理 spawn 留 v1.1（威胁主面
是跑不可信仓代码的业务节点,系统代理输入为平台数据）；子模块 push/refresh 的远端凭据独立
于主仓,不在 askpass 机制内（已知限制,docs/sandbox.md）。auto-push 凭据经
setPushCredentialResolver（start.ts 装配 db+secretBox 闭包）,agent 进程不可达。

