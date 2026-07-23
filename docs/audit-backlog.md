# 审计 backlog 与未决项（多人协作）

> 全仓各专项审计的**索引 + 未决项**，从个人 memory 汇入代码仓供全体可见。大多数审计有独立报告在 `design/*-audit.md`；本文件是总览 + 承载**没有独立报告的发现**（尤其权限/安全审计）。改动前重读对应 `file:line` 确认未被并发 session 动过。

## 审计报告索引（`design/`）

| 报告 | 主题 | 状态 / 未决 |
|---|---|---|
| `design/scheduler-audit-2026-06-10.md` | 调度专项深查 | 2 P0 + 9 P1；WP-1~10 路线；重构走 RFC |
| `design/dedup-audit-2026-06-13.md` | 全仓重复实现 | 68 确认 + 4 伪重复；9 处已漂成 bug；路线 §5 |
| `design/flag-audit-2026-07-07.md` | 标志位控流 | 六大 P0 + ≥12 真 bug + RFC-G1~G10；**§8 有 3 决策点待用户拍板** |
| `design/frontend-primitive-audit-2026-07-21.md` | 前端公共原语 | 160 确认 / 91 驳回；头号=三态闸门 + ErrorBanner 缺 onRetry；5-RFC 路线（部分已落 RFC-214） |
| `design/test-guard-audit-2026-07-21/` | 测试防护缺口 | 131 缺口 / 9 逃逸机制 / 15 结构守卫；加固批已落 + RFC-212（WS 授权撤销，方案 D） |
| `design/ux-audit.md` · `design/ux-functional-audit-2026-07-16.md` | UX / 功能 | 见报告 |
| `design/workgroup-e2e-audit.md` | 工作组 e2e | 见报告 |
| `design/codex-impl-gate-misc-2026-07-22.md` | Codex 实现门杂项 | 见报告 |

## 权限 / 安全审计（2026-07-15，7 路并行）——**无独立报告，全文在此**

RFC-099 资源 ACL + 任务成员制 + auth 层全面审计。骨架扎实（单一事实源 `services/resourceAcl.ts`、admin 按 identity 不按 permission、RFC-170 OCC CAS 无 check-then-write 缝、prompt 归属隔离双锁、五资源 detail 404 同形防探测、禁用/降权每请求即时收敛）；缝集中在**非 HTTP 旁路 + 后备旧路由 + 前后端门漂移**。多项被 2-3 路 agent 独立命中（可信度高）。

### ✅ 已修复并推送（origin/main 硬验证）
- 后端 `bda0d4fb`：worktree-files 缺门 + symlink 逃逸、OIDC 开放重定向、repos 任意路径、retryNode 先 CAS 后校验、workgroup addMembers 不落 collaborator（均带红→绿回归）。
- 前端 `fb7ccda3`：memory 门 `usePermission→useIsAdmin`、登出 `queryClient.clear` + IDB 草稿清理 + draftStore 改名（前端 4296 测试绿）。

### ⏳ 未决 P0（**安全，待用户拍板**）
- **cached_repos 明文 URL 含 git 凭据跨用户泄漏**：`services/gitRepoCache.ts:182` `rowToCached` 同时上 `url`(明文)+`urlRedacted`；wire schema `shared/schemas/cachedRepo.ts:7-8` 自注 "may contain credentials"；`GET /api/cached-repos`（`repos:read`=全体登录用户）返回明文。私有仓 PAT 塞 URL 是既定接入方式 → **任意登录用户可拉全体凭据**。
  修复触及 launch 复用契约（前端 `RepoSourceRow` 用明文 url 作 repoUrl 回填、后端按 `url_hash` 复用）——正解需**凭据移出 URL** 或 **launch 改按 `cachedRepoId` 复用**，非纯 bug 修复，故待决策。

### ⏳ 未决 P2（一致性 / least-privilege / 审计）
- workgroup 六资源中唯一无 method 权限点（无 `workgroups:read/write`，`server.ts` 无门）→ PAT 收窄失效。
- 空 PAT scopes = 全量 role 权限：`auth/actor.ts:35` 仅 `patScopes.length>0` 才缩窄；`auth.ts:161` 过滤后为空 → 静默全权限。
- 任务操作面无写权限点：cancel/resume/retry 只过 `canViewTask`（读门），`tasks:cancel:own/all` 零引用死点。
- review 评论 PATCH/DELETE 不验作者不留痕 + delete 无 decided 冻结（对照 update 有）。
- `updateTaskMembers` 缺 OCC + in-tx active（`resourceAcl` RFC-170 已修、成员面没跟）；`buildLaunchCollabRows` 不排除 `__system__`。
- WS 连接 actor 升级期钉死：撤销/降权/移出成员不断开在连，clarify 帧含全量问答（→ RFC-212 方案 D 处理）。
- 导入单向放宽 visibility：`workflow.ts:54` / `skill-zip.ts:430` 硬编码 public → 私有资源导出再导入静默转公开。
- memory admin 门谓词漂移：前端 `usePermission('memory:approve')`（`memory.distill-jobs.$jobId.tsx:43` / `MemoryPendingBadge.tsx:35`）因 D12 并入 `USER_BASELINE` 恒 true → 普通用户 WS 无限重连 + badge 拉全体候选；对照 `memory.tsx:47` role 判定正确。
- 前端详情页(agents/skills/mcps/plugins/workgroups.detail)不按 owner 做写门 → 非 owner 可编辑、编辑器拖动即撞 403；`acl-*` 错误码全无 i18n（英文裸串）；`AclPanel` 409 后知情整表覆盖；builtin 前端零感知。
- workgroup confirm/dw-confirm 门决策不落决策人归属（对照 review D7）。

### ⏳ 未决 P3（选摘）
`sweepExpiredSessions` WHERE 重复谓词(`sessionStore.ts:139`)；`resource_grants` 无删除清理(孤儿累积，ULID 不复用故无越权)；`searchUsersPublic` disabled 过滤 `|| excluded.size===0` 语义耦合；403 回带 `actorPermissions`；token 可 `?token=` query；OIDC allowlist `endsWith` 后缀混淆(`provisioning.ts:62`)；邮箱大小写不归一；运行时子进程继承全 `process.env`；403 vs 404 存在性口径混杂；协作草稿 PUT catch-all 吞错；401 不自动跳登录。
前端抽取机会：`AclPanel`↔`TaskMembersPanel` ~150 行复制且漂移(后者缺 onError refetch)、`useIsAdmin()` 身份门 hook、`RoleBadge`(admin 配色三处矛盾)、表单命名空间清剿(4 套平行 input)、`UserPicker` 键盘/ARIA 照抄 `MultiSelect`、`ConfirmButton` 铺到破坏性单击。

> ⚠️ 此环境曾持续污染工具输出回显（幻觉/自相矛盾）。只信 git 硬命令 / 单整数 grep / 测试 pass-fail 计数 / exit code；提交后用 `git cat-file` / `git log origin/main` 验真落地。

## 其他 backlog

- **CI 提速**：macOS `check`(870s) 是瓶颈且 gate 一切；backend 738 文件串行（`--parallel` 死锁全套，daemon flock）；安全赢 = 跨 runner 分片 + lint/typecheck 移出 macOS。
- **前端 i18n**：~134 硬编码串已抽 bundle；deferred = 4 RFC-087 结构项 + 4 基建缺口。
- **Demo 资产（非仓库代码）**：daemon DB 里有 2026-07-20 建的 11 个 agent + 5 个工作组（三模式全覆盖）；勿误删/重复建。
