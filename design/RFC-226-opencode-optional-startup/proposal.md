# RFC-226 OpenCode 可选运行时与 daemon 启动解耦 — proposal

状态：Done（2026-07-24；用户以「开始」批准。设计门 1 个 P1 已关闭；实现门
APPROVED / 0 open。显式 OpenCode status 要求 `ran && compatible`，版本门后移而非删除）。

## 1. 背景与现状证据

平台已经是多运行时系统：运行时是数据库中的可编辑、可禁用资源，agent 可以显式选择
`opencode` 或 `claude-code`，全局默认运行时也可以切换。RFC-224 又把 OpenCode 的生产执行入口
收口为“真正使用时”验证官方 v1.18.3 exact-hash snapshot、执行策略与完整身份。

但 `packages/backend/src/cli/start.ts` 仍保留早期 P-1-04 的启动硬门：

1. 每次 daemon 启动都执行配置所指向的 OpenCode `--version`；
2. 二进制不存在、不可执行、超时、版本不可解析或低于最低版本时，daemon 释放锁并退出；
3. `/health.opencodeVersion` 因而虽然在类型上允许 `null`，生产启动成功时却被强制为字符串；
4. RFC-208 还用源码测试把“限时但 fail closed”锁成了旧合同。

这会让没有安装 OpenCode、只使用其它运行时的部署完全无法进入设置页、运行时诊断页或执行非
OpenCode 任务。启动探测还会无条件执行 PATH shim / 用户配置 executable，扩大启动期外部依赖。

## 2. 目标

1. OpenCode 不存在、不可执行、版本不兼容或探测会卡住时，daemon 仍可正常启动并提供管理面。
2. daemon 启动过程不执行任何 OpenCode binary，也不依赖 OpenCode 版本探测的副作用。
3. 只有真正选择 OpenCode 的执行、smoke、models 或显式 runtime status/probe 路径才验证其
   binary、版本/官方构建与 RFC-224 身份合同；不满足版本要求时，该次运行时检验必须失败。
4. OpenCode 使用路径继续 fail closed；不得因取消启动探测而降级 exact-hash、显式 model、
   sandbox 或 session identity 检查。
5. 保持 `/health` wire 向后兼容，并明确表达“启动时未探测 OpenCode”。

## 3. 非目标

- 不降低或放宽 RFC-224 对生产 OpenCode v1.18.3 official build 的要求。
- 不改变默认运行时、runtime seed、enable/disable、agent 运行时选择或任务冻结语义。
- 不在 OpenCode 失败时静默回退到 Claude Code；失败只归属实际选择 OpenCode 的操作。
- 不取消用户显式发起的 Runtime status、Test、models、smoke 或 `doctor` 诊断。
- 不改变 git 启动硬门。git 是仓库、worktree、snapshot 与 merge-back 的平台级依赖，不是可选
  agent runtime。
- 不新增 migration，不改变 runtime 表或历史 task/node-run 数据。

## 4. 产品合同

### 4.1 启动

- `agent-workflow start` 不解析 OpenCode command、不执行 `opencode --version`，也不因
  `opencodePath` 缺失/陈旧/不可信而退出；
- 启动日志不再出现 `opencode probe ok` 或 OpenCode 版本错误；
- git、数据库完整性、daemon lock 等平台级启动门保持原语义。

### 4.2 健康与显式诊断

- `/health` 保留 `opencodeVersion` 字段以避免 wire break，生产值为 `null`，含义是
  “daemon 启动未探测 OpenCode”，不是“已探测且失败”；
- `agent-workflow status` 对 `null` 显示“启动时未检查”，不把它渲染成 daemon 故障；
- `/api/runtimes/status`、Runtime Test、models 与 smoke 继续按需执行现有受控诊断；binary
  不满足版本/official-build 要求时，该 runtime 的检验结果为失败，但 runtime row 仍可保留供用户
  修正、禁用或删除；
- `agent-workflow doctor` 是用户显式要求的环境诊断，继续检查 OpenCode 并如实报告结果，但该结果
  不参与 daemon 启动。

### 4.3 使用时失败边界

- business node、memory distill、merge/commit-push 等 system agent 与 runtime smoke 继续从
  RuntimeDriver 进入 RFC-224 verified plan；
- 缺失、低于版本要求、错误版本、非官方 bytes、sandbox/model/config/session 身份问题继续让
  运行时检验或实际执行失败，并返回现有稳定失败信息/失败码；
- 失败只影响该次 OpenCode 操作，不把 daemon 关闭，也不影响 Claude Code 任务或管理 API；
- 不允许“探测失败后仍执行 raw binary”的旁路。

## 5. 验收标准

- **AC-1**：`opencodePath` 指向不存在文件时，daemon 可启动，`/health` 返回 200 且
  `opencodeVersion: null`。
- **AC-2**：`opencodePath` 指向会写 marker、hang 或报告旧版本的 executable 时，daemon 启动
  不执行它；marker 不存在且启动时长不受该 executable 影响。
- **AC-3**：源码中不存在 OpenCode boot probe、对应 `process.exit(1)` 或依赖
  `recordOpencodeBinaryVersion` 启动副作用的生产合同。
- **AC-4**：显式 runtime status/Test/models 与真实 OpenCode execution 仍经过 RFC-224 official
  snapshot / verified plan；缺失、低于版本要求、错误版本或非官方 binary 的运行时检验继续
  fail closed，但 daemon 保持运行。
- **AC-5**：Claude Code-only 配置可启动并运行到其既有 runtime gate；OpenCode 故障不阻断服务。
- **AC-6**：`/health` contract、daemon/status 测试、RFC-208 旧源码锁与相关注释全部更新，不残留
  “OpenCode 是 hard-required boot runtime”的当前态断言。
- **AC-7**：typecheck、lint、format、backend 定向/全量测试与 binary smoke 全绿。

## 6. 兼容与发布

- `/health.opencodeVersion` 从“成功启动时必为 string”收敛为既有声明已允许的
  `string | null`；字段不删除、不改名。
- 这是启动策略变化，不需要数据库迁移或数据回填。
- 回滚只会恢复旧启动硬门，不影响已经创建的 runtime、agent 或 task 数据。
- RFC-208 的历史文档保留当时事故背景，但增加 RFC-226 supersession 说明；当前代码/测试/通用
  gotcha 不再把 OpenCode 描述为启动必需运行时。
