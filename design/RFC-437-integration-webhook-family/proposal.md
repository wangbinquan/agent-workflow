# RFC-437 代码平台 Webhook 家族归入 integration（RFC-294 W4 B / D 第三步）

- **状态**：Done（2026-11-03；`450abf2ca` + `386adedb8`，`450abf2ca` 的主 CI run 41768590656 红在两处：设计文档链接检查（本 RFC 漏改的两条 RFC-370 证据链接，后继 `386adedb8` 修复）与后端 22/44 的一条与本 RFC 无关的偶发用例；后继 `386adedb8`（父提交即 `450abf2ca`，只改那两条链接）的主 CI run 41772634009 首轮 70/70 全绿）。用户 2026-11-02「好，你继续推进RFC294，过程中你以最优架构进行自行判断不用提交给我审批」：本会话调研、设计、
  实施与集中验证，按授权记为已批准（取舍见 §6，可推翻）；不派 Codex（用户 2026-10-31）。设计门免；实现门由本会话按路径限定、只审功能地自审。
- **母 RFC**：[RFC-294](../RFC-294-backend-layered-target-architecture/proposal.md) plan §4.1 W4 B / D（入站适配器不再深引 legacy 与模块内部），
  以及 design §2「`services/` 按 owner 迁入模块后删除」
- **前序**：[RFC-434](../RFC-434-inbound-adapter-public-contracts/proposal.md)、[RFC-436](../RFC-436-module-inbound-http-bindings/proposal.md)
- **落位**：integration 的 `domain`、`application`、`application/ports` 与 `inbound/http`；composition、`server.ts` 与 bootstrap 只改连接。

## 1. 背景

代码平台 Webhook 是 integration 的能力：端点管理、入站接收与验签、投递审计与重放、触发器管理、命中触发器后的任务启动。
它的实现却分散在 legacy 层：

- `services/webhook/` 下 10 个文件：适配器注册表与 GitHub / GitLab 适配器、投递存储、分发器合同、触发器匹配、限流、
  终态工作区清理策略、触发器校验、分发器本体（985 行）；
- `services/webhookEndpoints.ts`、`services/webhookTriggers.ts`；
- `routes/webhooks.ts`、`routes/webhookDeliveries.ts`、`routes/webhookEndpoints.ts`、`routes/webhookTriggers.ts`。

这些文件基本是 integration 端口与领域规则之上的薄协调，却因为身处模块外，产生了三类偏离：

- **20 条 `R1-inbound-module-internals` 边**：它们深引 integration 的 `application/ports` 与 `domain`（198 条中的 20 条）。
- **反向缠绕**：integration 自己的 composition 与 infrastructure 又回头 import `services/webhook/*`（分发器合同、匹配、触发器解析、仓库解析类型），
  模块与 legacy 互相依赖。
- **路由里的应用逻辑**：
  - 入站路由自己做适配器选择、端点查找、限流、验签、解析、归一化与停用端点判定，再调已验证投递接收；
  - 重放路由自己执行重放规则（拒绝、在途、正文已清、终态投递的血缘与控制事实），并直接调事件中心的管理句柄。
    为此它深引 `event-center/composition` 与 `integration/composition/webhookIngress`，是 RFC-436 之后余下的 4 个深引路由之一。

## 2. 目标

- **G1 家族整体归入 integration**：上述 10 个服务文件、两个服务与四个路由全部迁入 integration，原文件删除，不留 facade。
  - 纯规则（适配器、匹配、触发器校验）进 `domain`；
  - 协调与用例（分发器、投递存储、端点与触发器管理、终态工作区清理策略、限流）进 `application`；
  - 分发器合同进 `application/ports`。
- **G2 入站接收成为应用用例**：
  - 适配器选择到已验证投递接收的整段流程归 `application/receiveCodeHostWebhook`，返回闭合的结果；
  - 绑定只读请求体（流式截断）、按适配器白名单取头、调用用例并映射为 HTTP 响应。
- **G3 投递重放成为应用用例**：
  - 重放规则归 `application/replayWebhookDelivery`，经已有的事件端口（observe / notify）发布；
  - 可用性由 composition 判定，绑定不再接触事件中心句柄与分发器。
- **G4 四个绑定入 `inbound/http`**：只依赖本模块与传输工具，不 import `services/`，不深引其他 context。
- **G5 public 面收窄**：`VerifiedWebhookIngressCommands` 与 `WebhookIngressPersistence` 只剩模块内消费者，移出 `public/commands`。
- **G6 行为不变**：路由、方法、权限点、令牌访问、公开理由、请求解析、响应状态与字节、错误码、投递状态与原因、日志事件全部不变。

## 3. 非目标

- 定时任务（`services/scheduledTasks.ts` 与 `routes/scheduledTasks.ts`）：它对其他 context 的 legacy 服务有值级依赖，
  需要先抽端口，另立 RFC-438。composition 里依赖定时任务服务的启动准入与保存校验随之保留在原处。
- 端点、触发器、分发器内部的语义重写；本 RFC 只移动位置并把两段路由逻辑抽成用例，不改规则。
- 安全相关改动。

## 4. 用户可见变化

无。

## 5. 验收标准

- **AC-1**：
  - 上述 16 个文件不再存在，`services/webhook/` 目录删除；
  - 四个绑定位于 `integration/inbound/http`，只依赖本模块与传输工具；
  - 迁入的文件都不 import `services/`（integration 里另有几处更早的 legacy 依赖，不在本 RFC 范围）。
- **AC-2**：入站接收与投递重放各是一个应用用例，绑定只做解码、调用与映射；两条用例的每个分支都有直接用例。
- **AC-3**：账本按实测更新：
  - `R1-inbound-module-internals` 198 → 178；
  - 深引模块内部的路由 4 → 3，import `services/` 的路由 28 → 24；
  - `integration/public/commands` 只剩维护命令；
  - 其余结构门不回退。
- **AC-4**：Webhook 接收、重放、端点与触发器管理、分发、终态工作区清理、维护与 provider 适配器的用例全部通过。
- **AC-5**：推送后 exact SHA 的 GitHub Actions 全绿。

## 6. 已作出的取舍（用户授权本会话按推荐决定，可推翻）

1. **整个家族一次迁移**：任何一个文件单独迁入，都会让仍在模块外的 import 方变成新的模块内部深引（例如分发器 import 投递存储与适配器）。
   家族的 import 闭包是全部 16 个文件，拆成多次只会先加账再还账。
2. **入站与重放抽成用例，不原样搬路由**：RFC-294 的 inbound 层只做 decode → call → map。两段逻辑是 integration 的业务规则，
   放在绑定里就是在入站层写领域流程；搬迁时一并归位，代价最小。
3. **适配器进 `domain`**：适配器只描述 provider 的头、判别符、验签与归一化，都是纯函数（验签只做 HMAC 与常量时间比较），
   归一化本就在 `domain`。
4. **限流进 `application`**：两档速率（每端点、未匹配全局）是入站接收的准入规则，由用例按原顺序判定；时钟可注入。
5. **public 收窄**：绑定入模块后，入站命令与持久化类型只在模块内使用，按 RFC-294 design §3.3 移回 `application/ports`。
