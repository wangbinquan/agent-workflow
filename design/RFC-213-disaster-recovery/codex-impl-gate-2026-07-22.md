# Codex Adversarial Review

Target: branch diff against 904fa0fc
Verdict: needs-attention

NO-SHIP：发现 5 个 P0、3 个 P1。当前实现的事务边界不足以保证灾难恢复安全；真实故障可导致部分恢复后继续启动、WAL 数据丢失、恢复包串包、越界写主机路径或权限收窄失效。

Findings:
- [critical] [P0] staged apply 将 swap 后异常误判为 swap 前失败 (packages/backend/src/services/pendingRestore.ts:185-207)
  触发路径：启动发现 `.restore-pending`，`restoreBackup()` 已在 `restore.ts:390` 替换数据库，随后 config/skills 复制、open/migrate、worktree 重建或 recovery-event 写入（395-441）抛错。这里的统一 catch 仍按“数据库未被触碰”处理，隔离 marker 并返回 false；`start.ts:140-149` 随后继续启动。结果可能是 DB、文件树和迁移来自不同恢复世代，非终态任务尚未被 mismatch-protect 挂起，而且下次启动不会重试。现有 pending-restore 失败测试仅覆盖 swap 前的坏 tar，无法检出任一 swap 后步骤抛错的变异。
  Recommendation: 引入 fsync 后的恢复阶段日志，明确区分 pre-commit 与 post-commit 错误；仅 pre-commit 错误可隔离并继续启动，post-commit 必须 fail-closed、回滚或保留可重试 marker。对 swap 后每一步及相邻 SIGKILL 边界做故障注入测试。
- [critical] [P0] worktree 元数据可把恢复写到任意主机路径 (packages/backend/src/services/worktreeBackup.ts:178-215)
  触发路径：上传含有效 DB 和伪造 worktree JSON 的恢复包，并让 taskId 对应一个非终态任务。代码把 JSON 直接断言为 `WorktreeMeta`，只按 taskId 查任务，却直接信任 archive 提供的 `repoPath`、`worktreePath` 和 branch；因此 `git worktree add` 可在 daemon 用户可写的任意绝对路径创建内容。随后通用 tar 解包器也没有拒绝绝对成员、`..`、symlink、hardlink 或设备节点。影响是 Web 管理员提供的备份获得主机文件系统写入原语；正常异机恢复中的旧绝对路径也可能误写。测试只覆盖自产元数据和 happy path，没有路径逃逸或链接攻击样例。
  Recommendation: 不要采用 archive 中的绝对路径；从受控 worktree 根和已验证 task ULID 重新推导目标，校验 realpath containment，并将元数据与 DB 行逐字段绑定。解包前枚举 tar 成员，拒绝绝对路径、父级逃逸、链接和特殊文件，先解到临时目录再验证搬运。
- [critical] [P0] 全局 pending 目录无锁，tar 与 marker 可跨请求串包 (packages/backend/src/services/pendingRestore.ts:123-136)
  触发路径：两个 API/CLI stage 并发执行。双方都无条件删除并重建同一个 `.restore-pending`，再分别写固定名 `staged.tar.gz` 和 marker；一种合法交错会留下 B 的 tar 与 A 的 `noSafetyBackup`、`noMigrate` 或 `skipIntegrityCheck` 选项，而且双方都可能报告成功。CLI stage 被允许在 daemon 运行时执行，因此跨进程竞争是产品路径；DELETE 也能同时移除正在写入的世代。现有测试没有跨请求或跨进程竞争。
  Recommendation: 以 ULID 创建不可变 staging 世代，在 marker 中绑定 tar 的 generation 和内容哈希；用专用文件锁/O_EXCL 串行发布，fsync tar、marker 和父目录后再原子切换 current 指针。已有 pending 时默认返回 409，替换和删除均使用 generation CAS。
- [critical] [P0] swap 在提交点前删除 WAL，旧库存在丢失已提交事务的窗口 (packages/backend/src/services/restore.ts:245-251)
  触发路径：旧库仍有已提交但未 checkpoint 的 WAL frame，恢复过程先 unlink `-wal`/`-shm`，随后在 rename incoming DB 前被 kill、断电或遇到 rename 错误。此时旧主 DB 仍在原路径，但承载已提交事务的 WAL 已消失；使用 `--no-safety-backup` 时可直接不可恢复，默认安全包也未在这里建立其已 fsync 落盘的证据。现有测试只断言成功结束后 sidecar 消失，没有在各文件操作间注入失败。
  Recommendation: 不要在 durable commit point 前 unlink 旧世代。将旧 DB 与 sidecar 移入同文件系统的 rollback 世代，配合 fsync 阶段日志，使 boot 能确定完成或回滚；破坏旧世代前还须 fsync 安全包及其目录。对每个 unlink/rename/fsync 边界做 SIGKILL 和 I/O 故障测试。
- [critical] [P0] restore 子路由绕过 scoped PAT 的 backup:run (packages/backend/src/server.ts:189-191)
  createApp 对 `/api/restore` 仅注册精确路径的 `backup:run` middleware；与 backup 路由不同，没有覆盖 `/api/restore/*`。GET/DELETE pending 端点只检查关联用户的 admin role，而 scoped PAT 收窄的是 actor permissions、不会移除该 role。因此一个不含 `backup:run` 的 admin PAT 仍可读取失败恢复信息并删除待恢复状态。当前路由测试直接注入 admin actor 和空 permissions，反而固化了绕过，未经过 createApp 权限链。
  Recommendation: 为 `/api/restore/*` 同样注册 `requirePermission('backup:run')`，并统一复用 admin guard。增加 createApp 级测试，证明缺少该 scope 的 admin PAT 对 POST、GET、DELETE 均为 403，具备 scope 时才放行。
- [high] [P1] migration gate 只看时间戳且信任可缺失 manifest (packages/backend/src/services/restore.ts:331-338)
  恢复方向仅取可选 manifest 的 `lastCreatedAt`；manifest 缺失时按 null 继续，`lastHash` 完全未参与判定，也未从 incoming DB 的 `__drizzle_migrations` 验证真实身份。于是同时间戳但 SQL hash 分叉的库会被视为相同，删除或伪造 manifest 还能令更新 schema 的 DB 绕过 backward gate；`quick_check` 只能证明 SQLite 结构完整，不能证明应用 schema 兼容。测试只有时间戳比较，没有 hash 分叉、manifest/DB 不一致或缺失 manifest 的较新 DB。
  Recommendation: 从解出的 DB 读取有序 migration 身份，并要求它与 manifest 一致；使用 `(created_at, hash)` 验证其必须是当前迁移链的精确前缀或完全相等。现代备份的 manifest 缺失或畸形应 fail-closed，legacy 格式须显式版本化处理。
- [high] [P1] staged skip-integrity-check 在最终 openDb 前失效 (packages/backend/src/cli/start.ts:278-285)
  marker 中的 `skipIntegrityCheck` 只传给 restore 内部的 post-swap openDb；pending apply 返回并消费 marker 后，start 再次打开真实 daemon DB 时只读取 `AGENT_WORKFLOW_SKIP_INTEGRITY_CHECK`。因此 `restore --stage --skip-integrity-check` 可以先完成 swap，却在普通下一次启动的最终 openDb 被 quick_check 拒绝，既无法按命令语义上线，也已改变原库。现有测试只是 restore 源码锁，没有跑完整 staged boot，因此删除这段贯通不会红。
  Recommendation: 让 pending apply 返回并保留 boot-scoped override，最终 daemon openDb 成功后才清除恢复状态；增加不设置环境变量的完整 staged-start 集成测试，分别覆盖 skip 开关两态。
- [high] [P1] pre-migration backup 失败后仍继续迁移 (packages/backend/src/cli/start.ts:263-275)
  当检测到待迁移版本时，任何 pre-migration backup 异常都会被 catch 后仅记录日志，随后仍调用 openDb 执行迁移。磁盘满、权限错误、tar 失败或 I/O 故障正是最需要回滚副本的场景；此路径会在明确启用 `backupOnMigration` 时仍无安全网地修改唯一数据库。测试只覆盖 helper 的成功、无需备份和禁用分支，没有让备份抛错并断言 migration 未开始。
  Recommendation: 检测到 migration 且 `backupOnMigration=true` 时，备份失败应默认阻断启动；已有显式禁用配置可作为风险接受开关。增加 start 级故障注入，断言 raw snapshot/tar 任一步失败后 openDb/migration 不会被调用。

Next steps:
- 阻断发布，先修复全部 P0，并把 staged restore 改为具有 durable phase 与 generation 的事务。
- 补齐 swap 后逐步骤故障注入、SIGKILL、跨进程 stage/DELETE 竞争、安全 tar、migration hash 分叉和 createApp scoped-PAT 测试。
- 修复 P1 后重新执行 RFC-213 专项测试、backend 全量门禁，并再次进行同子系统 missed-issues pass。

Codex session ID: 019f8743-f5b8-7e33-89a5-321db52a34e7
Resume in Codex: codex resume 019f8743-f5b8-7e33-89a5-321db52a34e7
