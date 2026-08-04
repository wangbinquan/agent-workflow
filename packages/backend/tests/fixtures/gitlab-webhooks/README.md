# GitLab webhook fixtures（RFC-257 T3）

本目录存放**真实自建 GitLab 实例**导出的 webhook payload（脱敏后）。在真实
fixture 落地前，`tests/rfc257-gitlab-adapter.test.ts` 使用按 GitLab 官方文档
形态手写的 builder payload——**字段路径以真实 fixture 为准，不符处回改
`services/webhook/gitlabAdapter.ts` 与 `design/RFC-257-*/design.md §2.3`**。

## 实测清单（proposal §8 / plan T3；逐项在部署侧 GitLab 上核准）

1. push 事件的作者字段是**顶层** `user_username`/`user_name`（无 `user{}`），
   MR/note/pipeline 是 `user{username,name}` —— adapter 的 `parseUser` 兼容
   两形，但需确认无第三形。
2. **pipeline 事件的 `user` 是否 = 触发流水线的 push 者**——这是 D14/D22
   熔断语义的前提（bot push → pipeline_failed 的 author 必须是 bot）。
3. GitLab「Resend」是否复用同一 `X-Gitlab-Event-UUID`。
4. **自建 GitLab 对失败投递确无自动重试**；webhook auto-disable 的触发阈值
   与恢复方式（Recent Deliveries UI）。
5. system hook 的事件覆盖（原生无 Note 事件）与 payload 是否与 project/group
   hook 同构（`object_kind` 判别是否一致）。

采集方法：GitLab → Webhooks → Recent Deliveries → Request body 原样保存为
`<event_type>.json`，把真实 host/用户名/邮箱替换为 `gitlab.example.com` /
`user-a` 等占位。
