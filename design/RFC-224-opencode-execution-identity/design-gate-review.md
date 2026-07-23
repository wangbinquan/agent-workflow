# RFC-224 Codex 设计门（2026-07-23）

> 审查对象：`proposal.md` Draft v1–v4、`design.md`、`plan.md`，以及
> OpenCode 官方 tag `v1.18.3`
> (`127bdb30784d508cc556c71a0f32b508a3061517`)。
>
> 最终裁决：**APPROVED / SHIP**。第一路审查批准后，第二路独立复审发现
> 3 个 P1；v5 修订后两路均重新确认无剩余 P0/P1/P2。

## 1. 门禁结论

| 严重度 | 最终未关闭 |
|---|---:|
| P0 | 0 |
| P1 | 0 |
| P2 | 0 |

设计门只批准 RFC 的实现顺序与安全合同，不代替实现门。生产接线完成后仍须
按 `plan.md` T30 进行独立 Codex 实现审查。

## 2. 已关闭的阻断项

| Finding | Resolution |
|---|---|
| upstream inline config 后仍有 managed/MDM、mode、repo、V2 plugin/custom-tool 等覆盖面 | 改为 hermetic source/env、强制 final raw config、same-instance `/config` + `/agent` seal；任何未知 source fail closed |
| 版本字符串无法证明 executable identity，源文件可在 hash 后替换 | 固定四个平台/架构 executable digest，单 token resolve，private `COPYFILE_EXCL` snapshot，0500/no-symlink，并在每次 exec 前 re-hash |
| `run --attach`、plugin transcoder 与内联 patch 无法证明同一官方实现 | 删除 attach/plugin 路径；hidden launcher 只驱动 sealed official `serve` 的 direct API |
| 模型 shell/MCP 可读 daemon HOME、XDG、provider secret、loopback server 或其它 PID | secure v1 仅 Linux bwrap；嵌套 no-network/private-PID sandbox、mask daemon HOME/XDG/seal/shared temp，精确 RW/RO mount |
| upstream file tools与 `external_directory` 自动规则可能绕过 seal | 全部 V1 file/skill/web/task/lsp tools deny；精确 `Truncate.GLOB` deny 后再 wildcard deny；逐项 seal 最终 permission tail |
| FFF 可用性判断会 fallback 到未 seal 的 ripgrep/download | build manifest pin capability codec；real server 前在 no-network/no-rg/empty-cache bwrap 内用随机 basename 做 exact FFF proof |
| OpenCode 会自动发现 AGENTS/CLAUDE/skills/references | 关闭 project/Claude/external skill discovery；repo surface no-symlink scan；平台 AGENTS/SKILL 独立 copy/re-hash 后仅作为 prompt 文本注入 |
| provider auth endpoint 不证明实际 credential 类型，active account 不只在 `auth.json` | 本地 strict auth schema 只接受 selected provider API key；exclusive store lock 下事务清空并验证 OpenCode SQLite account tables，同时处理 WAL/SHM |
| 新 session 在 owner 持久化前可能已经发出模型请求 | `SpawnPlan.control` strict marker + nonce ACK；runner 在 prompt 前原子 insert/verify owner、CAS run、获取 lease，launcher 收到 ACK 后才连 SSE/POST |
| node_run 行不能作为可恢复 session 的唯一 owner，迟到 cleanup 有 ABA | 独立 `opencode_session_owners`；immutable provenance + single-writer lease；释放/repair 使用 session+run+nonce triple CAS |
| fanout/loop/system run 的 private store key 会碰撞或被误保留 | fresh business 使用 random chain/root-run key；resume 复用 owner store；system/distiller/smoke 每次 ephemeral，business 按 owner/task GC |
| `/experimental/session` cursor 与直接 GET session 可能 boot foreign instance | frozen owner title + exact saved id 分页唯一定位；cursor/同 timestamp ambiguity fail closed；当前 instance 验证完成前不访问 session route |
| caller 使用平台 ULID，且 tool loop 会产生多个 assistant message | 实现官方兼容 ascending `msg_` codec；绑定恰好一个 caller 和有序 assistant ID 集，逐步校验 parent/model/agent/path/完成顺序 |
| idle 与同步 POST response 存在竞态，失败后 idle 可误报成功 | 成功必须同时观察 POST 2xx final WithParts 与 idle，顺序不限；error/permission/question 一旦发生不可逆失败 |
| capture 会回退到用户全局 OpenCode DB | plan 携带 frozen `sessionStore.dbPath` locator；live/post capture 禁止全局 resolver |
| runner、distiller、smoke 的取消路径和 bypass 可漂移 | 三入口只可使用 verified builder/launcher；统一 process-group TERM → grace → KILL → bounded reap/drain，source reachability test 锁 bypass |
| null model、plugin、dependsOn 与普通 retry/followup 行为在各入口不一致 | shared effective-runtime policy + stable failure union；OpenCode model 必选，unsupported 状态覆盖 save/launch/schedule/probe/UI；identity failure permanent 且不进入普通 retry/followup |

## 3. 官方实测证据

- 四个官方 unpacked executable SHA-256 已从 v1.18.3 release artifact 复核；
  本机 darwin/arm64 executable 命中
  `43f7083d450567706a80b6441331a25b5ed6d6c9f742826790545b068229cbb2`。
- 隔离实例的 `/config` 验证了 `share=disabled`、`autoupdate=false`、
  `snapshot=false`、`formatter=false`、`lsp=false`、`compaction.auto=false`
  等最终形状。
- `/agent` 实测证明精确 `Truncate.GLOB` deny 会抑制 upstream 最终动态 allow；
  absence 字段由 JSON `null` 表示，比较器必须规范化。
- `/skill` 在纯模式仍返回官方 built-in `customize-opencode`；内容 digest 固定为
  `6d22eed007626b08113c19a8837e2327e0af0bd3e75bfda9c3bfa07cf122e3eb`。
- `/config/providers` 只用于校验 provider/model 与 `model.api.npm` bundled
  allowlist；它不承担 auth type 证明。

## 4. 最终复审勘误

最终复审发现的四个非阻断表述问题已经修订：

1. provider auth type 明确由 launcher 本地 strict schema 证明；
2. denied `skill` 在 permission 检查后不会进入 `ripgrep.find`；
3. resume title 固定来自 `owner.created_node_run_id`；
4. `server.connected` 与 caller message ID 的 codec 步骤不再混写。

第二路独立复审新增并已写入 v5 的三项：

5. resume 在任何 persistent store/SQLite/server 接触前 CAS 预占 owner lease；
6. resume 与 new 共用完整 strict root-session comparator，显式拒绝
   title/path/share/revert/metadata 漂移；
7. managed skill 按 frozen contentVersion snapshot 整棵 tree，将 canonical tree
   digest 纳入 identity/provenance，aux file 只能从 seal bind。

两路最终复审均为 `APPROVED`。结论：v5 可以进入生产实现。
