# 发布 / 升级 / 回滚 runbook

> RFC-310 T111① 收口（2026-08-24）。此前仓内只有 `design/RFC-310-*/design.md` 的一段
> **cutover** runbook（数据迁移步骤），没有面向运维的发布回滚文档。
>
> **本文只写仓内真实存在的机制**，每条命令都能在 `packages/backend/src/cli/` 找到实现。
> 读到与源码不符的地方，以源码为准并回来改这份文档——一份过期的 runbook 比没有更危险。

产品形态是**单二进制自托管 daemon**：没有集群、没有滚动发布、没有外部编排器。因此
「发布」= 换一个可执行文件，「回滚」= 换回旧可执行文件 + 必要时恢复数据。

---

## 0. 先记住三件事

1. **数据在 `AGENT_WORKFLOW_HOME`（默认 `~/.agent-workflow`）**，不在二进制旁边。换二进制不动数据。
2. **升级会自动改数据库结构**（migration），而 **migration 不可逆**。跨版本回滚必须靠备份。
3. **`restore` 拒绝降级**：备份比当前二进制新时直接拒绝（`refused: the backup is NEWER than
this binary; cannot downgrade`）。所以**先换回旧二进制，再 restore 旧备份**，顺序反了会被挡。

---

## 1. 发布（维护者）

推一个 `v*` tag 即触发 `.github/workflows/release.yml`：先建 draft release，再按 matrix 为
macOS arm64 / Linux x86_64 / Linux arm64 / Windows x86_64 构建单二进制并上传。

```bash
git tag v1.2.3 && git push origin v1.2.3
```

⚠️ 自定义中文 release note **要等 workflow 完全跑完再** edit 进去，否则
`generate_release_notes` 会覆盖（`CLAUDE.md` §工作准则）。

---

## 2. 升级（部署方）

```bash
agent-workflow version          # 记下当前版本——restore 的版本闸门比的就是它
agent-workflow status           # 确认在跑；记下 pid
agent-workflow backup           # 显式备份，落 <home>/backups/，打印完整路径
agent-workflow stop             # 优雅停机（30s 上限）
#   —— 换掉可执行文件 ——
agent-workflow doctor           # DB 完整性 + 备份健康；有红先别起
agent-workflow start
```

**关于 migration**：daemon 启动时若发现 `_journal.json` 比库里已应用的更新，会**先自动做一次
原始 DB 拷贝**（`pre-migration-<from>-<to>`，见 `services/backupScheduler.ts`
`maybePreMigrationBackup`），再应用。也就是说即使你忘了第 3 步，仍有一份升级前快照。
想先看会发生什么：

```bash
agent-workflow migration-report   # 只读：列出待应用的 migration
agent-workflow migrate            # 只跑 migration，不起 daemon
```

**为什么第 5 步的 `stop` 不能省**：`restore` 与 `db compact` 都会检测 PID 文件，daemon 在跑
就拒绝（`restore refused: a daemon is running (pid …)`）。升级本身不检测，但带着活 daemon 换
二进制会让正在跑的任务面对一个已经不存在的可执行文件。

---

## 3. 回滚

### 3a. 只回滚二进制（没有跑过 migration）

`migration-report` 显示无待应用项、或 `doctor` 确认库版本未变时，直接换回旧二进制重启即可，
数据不动。这是最常见、也最安全的一种。

### 3b. 跨 migration 回滚（必须动数据）

**顺序不能反**：

```bash
agent-workflow stop
#   —— 先把可执行文件换回旧版本 ——
agent-workflow version                     # 确认已是旧版本
agent-workflow restore <tarball> --dry-run # 只读预演：打印将要发生什么，不改任何东西
agent-workflow restore <tarball> --yes     # 真正应用（**覆盖当前数据**）
agent-workflow doctor
agent-workflow start
```

- 不带 `--yes` / `--stage` 时，`restore` 只打印计划并提示 `re-run with --yes to APPLY`——
  它不会因为你少打一个参数就动数据。
- `--stage` 写一个待应用标记，**下次 daemon 启动时**再换入；staging 前会按与真正 apply
  **同样深度**校验 tarball（历史上 staging 一个无效包会 arm 出 boot loop）。
- `--no-safety-backup` / `--no-migrate` / `--skip-integrity-check` 是逃生口，正常回滚
  **不要用**：安全备份是这条路径上最后一道网。

### 3c. RFC-295 降级预检

跨越 RFC-295 那次结构变更回滚前，先跑只读预检：

```bash
agent-workflow downgrade-audit rfc-295   # 输出 OK / BLOCKED
```

---

## 4. 备份

- **自动**：daemon 内的 backup scheduler 周期性 `createBackup` 并 prune；`agent-workflow-*`
  与各 `pre-*` 家族**各自保留最新 N 份**（`services/backupScheduler.ts` `pruneBackups`）。
- **手动**：`agent-workflow backup`（daemon 在跑也可以，它自己开库、不碰 daemon 启动路径）。
- **落点**：`<AGENT_WORKFLOW_HOME>/backups/`。
- **健康度**：`agent-workflow doctor` 会报备份健康（info 级）与 DB 完整性（损坏则 doctor 失败）。

**版本与备份要配对记**：`agent-workflow version` 打印的值正是 restore 前置闸门比较的那个值。
归档备份时把它一起记下来，回滚时才知道该换回哪个二进制。

---

## 5. 不在本文范围

- **运维 dashboards / alerts**：本仓**没有**任何监控栈接线（零 Prometheus / Grafana / alert
  规则）。这类产物的形态完全取决于部署方自己的监控系统，凭空写一份等于交付一份没人会用的
  文档——RFC-310 T111② 据此登记为**不做**，需要时按实际监控栈另立 RFC。
- **集群 / 滚动发布 / 蓝绿**：产品是单进程自托管 daemon，不存在这些形态。
