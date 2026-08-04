# Webhook 触发器运维指引（RFC-257）

面向**商用内网部署**（自建 GitLab + 几百个仓库）的接入手册。产品/技术契约见
`design/RFC-257-code-host-webhook-triggers/`。

## 1. 一次性接入（管理员）

### 1.1 平台侧

1. 确认 daemon 网络可达：`config.json` 的 `bindHost` 从默认 `127.0.0.1` 改绑
   内网地址（或前置反代）。**影响**：整个 `/api/*` 管理面随之暴露到内网——
   所有管理路由强制鉴权，但建议配合防火墙/反代收窄来源。
2. 配置 `publicBaseUrl`（生成给 GitLab 填的完整 URL 的唯一来源；建议指向反代
   的 HTTPS 地址——`X-Gitlab-Token` 是明文 header，GitLab → daemon 链路要么
   走可信内网段要么由反代终止 TLS）。
3. 设置 → Webhook 端点 → 新建端点。**Secret 只显示这一次**，当场复制。

### 1.2 GitLab 侧

- 几百仓共用一个 hook：**Group → Settings → Webhooks**（组级，付费版；评论
  事件齐全）或 **Admin Area → System Hooks**（实例级；**原生没有 Note/评论
  事件**——评论指令场景必须用 group/project 级 hook）。
- 粘贴平台给的 URL 与 Secret token，勾选事件：Push events / Tag push events /
  Merge request events / Comments / Pipeline events。
- 保存后用 GitLab 的 Test 按钮发一条，平台投递历史页应出现记录。

### 1.3 bot 账号（修复类场景必需）

1. GitLab 建专用 bot 账号（如 `aw-bot`），对目标仓库群授予 Developer+。
2. 发一个 `write_repository` scope 的 PAT，配进 **daemon 宿主机**的 git
   credential helper（或把宿主机 ssh key 加到 bot 账号）——修复产出要
   push 回 MR 源分支，凭据由宿主机管理，平台不托管。
3. **把 bot 的 username 填进每个触发器的「忽略用户名单」**——bot 自己的
   push / MR 更新 / 评论不再触发（防自触发风暴）。注意：**流水线事件不受
   此名单过滤**，这是修到绿循环的前提（bot push 引发的 pipeline_failed 仍
   会触发下一轮修复，循环由熔断上限兜底）。

## 2. 触发器配置要点

- **触发器绑规则不绑仓**：repo 范围（全部 / path 前缀 / 精确清单）× 事件
  类型 × 分支 glob × 评论指令前缀。几百仓用一条「前缀 = group path」的触发
  器罩住。
- 任务的仓库来自事件本身；事件仓未导入平台时默认按 payload URL 自动 clone
  （触发器可关）。**统一 URL 形态**：内外网双 host / 大小写路径别名会造成
  同一仓的双份缓存——GitLab 侧保证 `git_http_url`/`git_ssh_url` 一致即可。
- 分支过滤语义：MR 类事件按**目标分支**匹配（`main` = 只审进主干的 MR），
  push/tag 按事件分支。
- 修到绿循环 = pipeline_failed 反复触发 + supersede（新事件取消同 MR 在跑
  的旧任务）+ 熔断（同一 MR 连续触发默认 3 次后跳闸；开发者本人 push 会
  重置计数，或在触发器的「触发记录」里手动重置）。

## 3. 排障对照表

| 现象 | 看哪里 | 处置 |
|---|---|---|
| GitLab Recent Deliveries 红色 401 | 平台投递历史 `rejected(invalid-token)` | Secret 不一致：平台轮换后重贴 GitLab |
| GitLab 显示超时 | —— | 不应发生（平台三段式立即应答）；检查网络/反代超时设置 |
| 事件到了但没起任务 | 投递历史 `ignored(no-trigger-matched)` | 规则没罩住该仓/事件类型/分支；核对触发器 |
| 触发了但任务失败 | 触发器 → 触发记录 `launch-failed` | 看 error（repo clone 凭据 / 模板渲染 / 目标不可用） |
| `skipped-owner-invalid` | 同上 | 触发器 owner 被禁用或对目标失去权限；admin 改 owner 后重放 |
| `skipped-circuit-open` | 同上 | 熔断：人工重置或等开发者 push |
| daemon 重启后有 `failed(interrupted)` | 投递历史 | GitLab 不自动重投——用重放按钮恢复 |
| **hook 整个不发了** | GitLab webhook 编辑页 | **auto-disable**：GitLab 对连续失败的 hook 自动禁用（4xx 永久、5xx 退避）。平台侧已把可忽略情形一律 200 规避；若仍发生，在 GitLab 重新启用并排根因 |

## 4. 恢复语义（重要）

- **自建 GitLab 对失败投递不自动重试**，只有 Recent Deliveries 里的手工
  Resend。平台侧的**重放**（投递历史页）是主恢复路径：验签失败的投递不可
  重放（先修 Secret 再 Resend）；重放新建投递行并绕过去重。
- 投递原始 body 保留 30 天（之后清空，重放不可用）、行保留 90 天。
- **备份迁移**：webhook Secret 用 `secret.key` 密封，备份包不含该文件——
  restore 到新机后所有端点 Secret 失效，需在 UI 重新生成并重贴 GitLab。

## 5. 安全模型速记

授权主体是**触发器 owner**（建触发器 = 预授权「命中规则的事件以我的身份跑
这个目标」），每次触发都重建 owner 身份并重校验目标权限；GitLab 侧评论者
身份不做平台侧鉴权（内网全员可信，D10）。端点 Secret 面走
`webhook-endpoints:manage`（admin/manager，任何 PAT 拿不到）。
