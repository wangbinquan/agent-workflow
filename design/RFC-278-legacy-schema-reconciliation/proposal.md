# RFC-278 · 历史迁移漂移受控收敛

状态：Done（2026-08-10；`52196e1d`，CI 31380410981，live migration 与 UI probe 全绿）

## 1. 背景

RFC-276 发布后，设置页对默认 OpenCode 做深探测时出现：

```text
no parseable opencode events on stdout (exit 2)
stderr tail: unknown subcommand: __opencode-verified-run
```

现场证明这是版本错配，不是 OpenCode 不兼容：升级前 daemon 仍在内存中组装已退役的 verified
launcher argv，却调用了升级后已删除该入口的 CLI 文件。用 `v0.18.2` 当前
`runtimeSmoke` 直接探测同一台机器的 `opencode`，结果为 `conforms=true`，session 与 nonce 均被捕获。

停止旧 daemon、从 `v0.18.2` 重启后又暴露出第二个阻断：RFC-275 的 migration history preflight
拒绝本机数据库。真实 `__drizzle_migrations` 中 8 个 receipt hash 来自这些迁移仍在共享工作树中
编辑时的历史运行；当前 SQL 文件已经是后续定稿版本。此事实与 RFC-275 记录的 0125 现场一致，
不能通过“忽略 hash”或直接改 receipt 处理。

在 SQLite 在线备份副本上跳过 history preflight、只应用当前 pending 0142–0144 后，物理 schema
仍有 8 个差异：

- `recovery_events` 保留旧版行内 DDL 注释且缺两个正式索引；
- `mcp_runtime_test_create_receipts` 缺两个外键与 shape check；
- 已退役的 `recent_repos` 表仍存在；
- 上述形态连带产生三个 index manifest 差异。

当前数据验证为：19 条 `recovery_events`、1 条仍在 24 小时窗口但指向升级前 native session 的 MCP
create receipt、3 条已经没有生产读写方的 `recent_repos`。0144 会 reset 旧 MCP native session，
因此旧 create receipt 不应继续把重试指回已结束会话。安全恢复需要一个精简的 forward migration，
而不是恢复旧 runtime 加固链、重写历史 SQL 或伪造 receipt。

## 2. 目标

1. 只对现场已经确认的 8 组 `(migration tag, folderMillis, legacy hash)` 接受历史 receipt 别名；
   其他 hash、顺序、缺口、额外项继续由 RFC-275 fail closed。
2. 新增 0145 forward migration，把已知历史物理漂移收敛到当前完整 migration replay 的唯一形态。
3. 保留 `recovery_events` 全部行；为收敛真实 legacy DDL，在单事务内按显式列复制到 canonical 表并
   补齐缺失索引。
4. 把短期 `mcp_runtime_test_create_receipts` 作为 RFC-276 session cutover 状态直接清空并按当前契约
   重建，不保留指向旧 session 的 replay receipt。
5. 删除 RFC-165 已退役的 `recent_repos`，以及只服务 RFC-276 一次性回滚、生产零读取的
   `rfc276_legacy_runtime_archive`；自动 pre-migration backup 是恢复权威。
6. migration 完成后继续执行 RFC-275 postflight history 与完整 physical manifest 对拍；第二次
   reopen 必须幂等。
7. 允许 `v0.18.2+` daemon 正常启动，使界面 OpenCode 探测只走 RFC-276 的自然
   `opencode run ...` 路径。

## 3. 非目标

- 不恢复 `__opencode-verified-run`、verified launcher、sandbox、containment、identity、hermetic
  store 或任何 RFC-276 已退役安全入口。
- 不修改旧 migration SQL/meta，不 `UPDATE`/`DELETE` `__drizzle_migrations`，不提供跳过 schema
  admission 的环境变量。
- 不把任意 hash mismatch 都当作兼容历史，不按文件名、前缀或“来自旧版本”宽泛放行。
- 不自动猜测或保留 `recent_repos` / legacy runtime archive；两者都不再参与产品行为。
- 不改变 auth/ACL、secret redaction、DB integrity/backup、进程回收或 runtime profile 语义。

## 4. 产品决策

### D1 · 精确 receipt alias，不改 receipt

compatibility 表只包含下列完整 legacy SHA-256；匹配同时要求当前链中的 tag 与 `folderMillis` 正确：

| tag                                  | legacy hash                                                        |
| ------------------------------------ | ------------------------------------------------------------------ |
| `0052_rfc108_recovery_events`        | `3b5f02214e1c06a1b05ab2eaef4d1209815d60198850eba9ad4a899fa14c96f0` |
| `0069_rfc129_review_selection_stale` | `547c53f30c3a8a8fd4df278ce0310e4a2a89f3683b6336559c31093b669f4e24` |
| `0084_rfc164_workgroup_tasks`        | `8c9f8244e564b54951c284a5ed7f20f0c9077d621ff7d49465420490182024b7` |
| `0085_rfc165_task_space`             | `033da7e58069bce3c90c3f2688f018417fceb5bc0995577ce828a351590800a3` |
| `0095_rfc189_wg_round`               | `ae58ca1a757cc36c41af5b1a8a077a3bda436924ae074acf5a408babb5ccdfca` |
| `0107_rfc217_clarify_unify_t17`      | `7d9cc403ede0aea34d7a6557ff0f10de73a8adb04fad09430e973c94aee2b1b4` |
| `0125_rfc238_mcp_runtime_playground` | `475944d58ef1c8341ed86e3c88ce080aebcef8dbc23548ea43345be3a8eee450` |
| `0139_rfc261_webhook_delivery_scale` | `1c14427b8a7f740617841f759c302f9efbe0ab611e3dd23b553c4a6a1ded794e` |

alias 同时供 preflight/postflight 使用，使 DB 永远保留真实历史 receipt；physical admission 仍以完整
当前链 fresh replay 为唯一最终权威。任一 hash 改一个 nibble、换 tag、换 timestamp 或加第九项都拒绝。

### D2 · 0145 只做 forward repair

0145 只做必要变更：

1. 在同一 migration transaction 内逐列复制 `recovery_events`，替换为 canonical DDL 并重建
   task/kind 两个索引；19 条审计行逐字段不变；
2. `DROP TABLE mcp_runtime_test_create_receipts`，再按当前 0125 canonical DDL 创建空表、两个
   `RESTRICT` 外键、shape check 与 expiry index；
3. `DROP TABLE IF EXISTS recent_repos`；
4. `DROP TABLE IF EXISTS rfc276_legacy_runtime_archive`。

daemon 的既有启动顺序仍保证 pre-migration backup 早于这些写入；migration 由 Drizzle 单事务执行。

### D3 · 最终准入不降级

0145 后照常执行：foreign key check → exact history postflight（含 exact aliases）→ full-replay physical
manifest。若还有任何额外/缺失/变化对象，daemon 仍不开放 HTTP/scheduler。alias 只解决“历史 bytes
不同”，不替代物理正确性证明。

### D4 · Runtime 问题通过同代重启解决

当前 production probe 不增加旧协议兼容分支。发布/本地切换必须停止旧 daemon，再由新 binary/source
启动；成功启动后 probe 自然调用 registered `opencode`。旧 daemon + 新 CLI 文件的错配不通过复活
隐藏子命令处理。

## 5. 能力与兼容性影响清单（需用户确认）

- **C1（精确历史兼容）**：上述 8 个 legacy receipt 不再单独阻断启动；任何未列 hash 仍阻断。
- **C2（审计表无损收敛）**：`recovery_events` 在 migration transaction 内逐列重建，不删行；任何
  复制失败都会回滚。
- **C3（短期 receipt reset）**：`mcp_runtime_test_create_receipts` 清空重建；当前 1 条未过期 receipt
  会失效，因为它指向 0144 必须 reset 的升级前 native session。新请求继续使用同一 24 小时幂等契约。
- **C4（退役表删除）**：`recent_repos` 及其 3 条历史行、`rfc276_legacy_runtime_archive` 一次性归档表
  均从 live schema 删除；后者内容仍存在于 pre-migration backup。
- **C5（旧进程必须退出）**：切换到本修复时会优雅重启 daemon；没有 running/queued 业务任务时
  才执行现场切换。awaiting/interrupted/done 数据不删除。
- **C6（准入保留）**：RFC-275 的未知 history/physical drift fail-closed、quick_check、backup 与最终
  manifest 对拍全部保留；不存在全局 bypass。
- **C7（安全加固不复活）**：OpenCode probe/business/system/MCP 继续只有自然路径；不重新加入任何
  RFC-276 已删入口或安全护栏。

## 6. 验收标准

- **AC-1** 8 个 exact alias 的真实前缀 fixture 可升级；每个 alias 单 nibble mutation、错 tag、错 when
  与未知第九 hash 均在 migrate 前失败。
- **AC-2** 0141 历史形态 fixture 经 0142–0145 后 full physical manifest 与 fresh replay 完全相同。
- **AC-3** recovery rows 逐字段前后相等且两个索引存在；MCP create receipt 表为空且正式 PK、
  indexes、FKs/CHECK 恢复；两个 retired archive 表均不存在。
- **AC-4** 升级前 create receipt replay 明确失效；升级后新建/重放/过期清理的业务测试继续通过。
- **AC-5** fresh DB、canonical 0144 DB、legacy DB 与第二次 reopen 全绿；rolling upgrade toy task 仍可运行。
- **AC-6** RFC-275 原有“已应用 SQL 改一字节必拒绝”测试保持绿，证明 alias 没扩大为通配。
- **AC-7** 真实 DB 只在自动 pre-migration backup 成功后升级；升级后 `PRAGMA quick_check`、
  `foreign_key_check`、schema admission 全绿。
- **AC-8** 当前主仓库对真实 `opencode` 深探测仍返回 `conforms=true`，源码与 argv 不含 retired
  OpenCode launcher 入口。
- **AC-9** backend focused/full、shared/frontend、`bun run gate:local` 与三平台 CI 全绿。
