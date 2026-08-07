# RFC-269 · 实施计划

> 产品视角见 [proposal.md](./proposal.md)，技术设计见 [design.md](./design.md)。
> 本仓主干开发（CLAUDE.md 硬规则：直接在 `main` 提交推送，不建分支）。下面的「批次」是**提交批次**，
> 每批自带测试、每批跑 `bun run gate:local` 全绿后再推，推完按 exact SHA 查 CI。

## 批次 A · shared 契约层（无运行时行为，先把所有穷尽表立起来）

| 任务 | 内容 | 依赖 |
|---|---|---|
| **T1** | `NodeKind` 新增 `'code-host-call'`；`CodeHostCallNodeSchema` / `CodeHostCustomRequestSchema`；`WORKFLOW_SCHEMA_VERSION` 4→5 + `WORKFLOW_SCHEMA_VERSIONS` 追加；`NODE_KIND_BEHAVIORS` 新行（design D1）。 | — |
| **T2** | `shared/src/codeHost/actions.ts`：19 个动作 × 2 provider 的完整注册表（design §4.1），`satisfies Record<CodeHostAction, CodeHostActionDef>`；unsupported 项带 `reasonKey`。 | T1 |
| **T3** | `shared/src/codeHost/template.ts`：模板渲染 + 三种位置编码（path / query / JSON 字符串）+ D13 sentinel 落点判定。 | T1 |
| **T4** | `shared/src/codeHost/path.ts`：自定义 path 的六条安全判据（design §5.3）。 | — |
| **T5** | `TRIGGER_CONTEXT_VARS`（= `WEBHOOK_TEMPLATE_VARS` \ `event_json`）；权限点 `code-host-calls:author` 三处登记；失败码常量。 | — |

**测试（随批交付）**：注册表穷尽性 + binding path 只引用已声明字段；三种编码位置 × 特殊字符
（引号 / 换行 / 反斜杠 / 中文 / emoji）；D13 四种落点；path 六条判据正反例；`TRIGGER_CONTEXT_VARS`
与 RFC-263 变量表的派生关系锁。

## 批次 B · backend 凭据面

| 任务 | 内容 | 依赖 |
|---|---|---|
| **T6** | 迁移：`code_host_connections` 表 + `tasks.trigger_context_json` 列（design §14）。 | T1 |
| **T7** | `services/codeHost/connections.ts` + `routes/codeHosts.ts`：GET（掩码）/ PUT（token 保留 vs 清除语义）/ DELETE；`settings:read` / `settings:write` 门；无 `secretBox` 时自我跳过（D5）。 | T6 |
| **T8** | `POST /api/code-hosts/:provider/test`：四类可区分错误（D7），永不回显 token。 | T7 |
| **T9** | 新凭据登记进 `shared/src/intentSecretSlots.ts` 闭合载体表 + redactor 接线（design §7.6）。 | T7 |

**测试**：PUT 三形态（新建 / 只改 base URL 保留 token / 空串清除）；GET 掩码且不回明文；非 admin 403；
PAT 拿不到；测试连接四类错误各一条；base URL 形态校验（GitLab 非 `/api/v4` 结尾 → 422，含子路径部署
正例）；redactor 变异测试。

## 批次 C · backend 执行层

| 任务 | 内容 | 依赖 |
|---|---|---|
| **T10** | `services/codeHost/call.ts`：header 组装、超时、重试与幂等分档（D18）、重定向策略（D19）、响应截断（§7.4）、脱敏（§7.6）。`fetch` 经依赖注入以便测试。 | T2, T7 |
| **T11** | project 解析（design §5.4）：显式值 / 单仓推导 / host 校验 / 多仓拒绝。 | T10 |
| **T12** | `scheduler.runCodeHostCallNode` + 分发分支（位置对称于 `script`）；`node_runs` 行、两个输出端口写入、失败码落地。 | T10, T11 |
| **T13** | `services/codeHost/authorGate.ts`：敏感投影哈希判定，覆盖保存 / YAML 导入 / 复制 / intent 四入口（对称 `scriptAuthorGate.ts`）。 | T1 |
| **T14** | `workflow.validator.ts` 规则 R1–R9（design §11）。 | T2, T3, T4 |
| **T15** | 并发池 `'code-host'` 第三池 + config 键 `maxConcurrentCodeHostCalls` / `codeHostRequestTimeoutMs` / `codeHostResponseMaxBytes`；`resizeAllNodePools` 与 `PUT /api/config` 热生效；**`buildChildDeps` 搬运新键 + 锚点锁**（RFC-243/266 踩过的漏接线）。 | T12 |
| **T16** | `webhookDispatch` 启动路径写入 `trigger_context_json`（投影，不含 `event_json`）。 | T6 |

**测试**：19×2 减 unsupported 的请求快照（method / URL / header / body 逐字节）；401/404/422 → failed
且 token 不泄（变异测试）；429 尊重 `Retry-After`；5xx 对 PUT 重试、对 POST 不重试（两条独立断言）；
跨主机 302 被拒；`job.log` 302 跟随一次且第二跳无 `Authorization`；300 KiB 响应截断 + 标记 + 仍 done；
project 三种路径；权限门四入口 × 三角色 × PAT；trigger 快照写入 / 手动启动为 NULL；**D16 双层锁**
（agent prompt 渲染后仍含字面 `{{trigger.`）；**T-lock-1**（`services/codeHost/**` 无 `Bun.spawn` /
`containedSpawn`）；三池独立 + `buildChildDeps` 锚点锁。

## 批次 D · frontend

| 任务 | 内容 | 依赖 |
|---|---|---|
| **T17** | palette 新分区 `integrations` + `PALETTE_DESCRIPTORS` 新行；画布节点卡片（glyph `⇄`）。 | T1 |
| **T18** | Inspector：provider `.segmented`、动作 `<Select group>` 四组、按注册表驱动的动态表单、unsupported 置灰 + 原因、`<TemplateVarChips>` 两组变量。 | T2, T17 |
| **T19** | `/settings` 新分区 `code-hosts`（access 组）：两家卡片 + 掩码 + 测试连接三态；非 admin 不渲染。 | T7, T8 |
| **T20** | i18n 双语（**注意 RFC-211 守卫：hint 里不得出现字面 markdown**）。 | T17–T19 |

**测试**：provider 切换字段随动；unsupported 禁用且有原因；四组表头渲染（role 断言）；设置页掩码 /
保存不回传明文 / 非 admin 不渲染 / 测试连接三态；`user` 角色下表单只读且 palette 无该行。

## 批次 E · 收尾

| 任务 | 内容 | 依赖 |
|---|---|---|
| **T21** | e2e：假 code host server → webhook 投递 → 任务 → 回帖，断言收到的请求体与线程 id。 | A–D |
| **T22** | 文档：新 `docs/code-host-calls.md`（动作对照 + 部署侧 token 最小权限建议）；`docs/webhook-triggers.md` §7.5 按 proposal §9 改写。 | A–D |
| **T23** | RFC-265 三处指代改写（`design/RFC-263-*/proposal.md` §9、`docs/webhook-triggers.md` §7.5、`design/plan.md` 索引条目）为「由 RFC-269 取代」。 | T22 |
| **T24** | `design/plan.md` 索引条目与 `STATE.md` 状态置 Done + CI 绿证（exact SHA）。 | 全部 |

## 依赖图

```
A(T1..T5) ──▶ B(T6..T9) ──┐
     │                     ├──▶ C(T10..T16) ──▶ D(T17..T20) ──▶ E(T21..T24)
     └─────────────────────┘
```

批次 A 与 B 可并行起步（T6 只依赖 T1 的 schema 形状）。C 必须等 B 的凭据服务可用。D 依赖 C 的注册表
消费面已定型。

## 门禁与提交纪律

- 每批 `bun run gate:local` 全绿再推（backend 4 分片 + quality 车道，约 5–6 分钟）。
- lint 是 `--max-warnings 0`，一个 unused import 就双 OS 红。
- 推完立刻按**自己的确切 SHA** 查 CI；共享 `main` 上并发 push 会取消自己的 run，按含本 commit 的
  superseding commit 判绿、按失败测试的 owning commit 归属。
- 多人并发：`design/plan.md` / `STATE.md` 是共享索引，提交时按路径精确 `git add`，绝不 `git add -A`。
- 按 CLAUDE.md：改完代码 declare done 前跑 **Codex 实现门**（分离 worktree，从 pin 到自己 commit）。

## 验收清单（对应 proposal §7）

| 批次 | 覆盖的 AC |
|---|---|
| A | AC-23（path 判据纯函数层） |
| B | AC-15, AC-16, AC-17, AC-18（凭据面部分） |
| C | AC-6, AC-7, AC-8, AC-9, AC-10, AC-11, AC-12, AC-13, AC-14, AC-18（执行面部分）, AC-20, AC-21, AC-22, AC-24, AC-25 |
| D | AC-1, AC-2, AC-3, AC-4, AC-5, AC-19 |
| E | AC-1 端到端复核 |

## 风险与预案

1. **动作映射与真实实例不符**（proposal §8 的七项待实测）。预案：注册表是纯数据，改一行即可；
   每个 binding 都有请求快照测试，改动可见。**不在 fixture 未实证前把动作宣称为"已验证"**。
2. **GitLab `approve` 可能仅 Premium 可用**。预案：若实测 Free 版 404，在 UI 该动作上标注版本要求
   （而非静默失败）；必要时降级为 unsupported + reasonKey。
3. **响应体上限争议**（256 KiB 对大 MR diff 可能不够）。预案：config 可调；截断标记保证下游不会在
   半截数据上下结论。
4. **权限门的敏感投影哈希漏面**。预案：照搬 `scriptAuthorGate.ts` 的投影定义与测试矩阵，四入口逐条
   对齐，不自创判据。
