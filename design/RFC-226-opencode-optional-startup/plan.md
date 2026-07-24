# RFC-226 OpenCode 可选运行时与 daemon 启动解耦 — plan

状态：Done（2026-07-24，用户已批准；设计门与实现门通过，本地交付未提交/推送）。

> **RFC-227 supersession（2026-07-24）**：本文“版本门后移”的已勾任务是历史交付记录。
> daemon 启动解耦继续有效；显式运行时的版本准入已由 RFC-227 删除并改为行为 codec +
> binary digest + containment provider。

## 任务

- [x] **T1 回归测试先红**：为 missing/poison `opencodePath` 增加真实 daemon 启动测试，证明当前
      hard gate 会退出或执行 poison binary；health 目标值锁为 `null`。
- [x] **T2 删除启动探测**：从 `cli/start.ts` 删除 OpenCode probe、版本 gate 与 boot probe
      timeout，production `createApp` 传 `opencodeVersion: null`；保留 git gate、Claude soft
      probe 与任务闭包所需 import。
- [x] **T3 health/status 合同**：contract registry 接受 nullable；真实 daemon/CLI 测试断言
      `null`，status 明示“启动时未检查”。
- [x] **T4 迁移 RFC-208 锁**：删掉被 supersede 的 OpenCode boot fail-closed 源码锁，新增
      “启动不执行 OpenCode”负向锁；保留 git 与其它 timeout 保障。
- [x] **T5 清理隐式前提**：更新 version registry、legacy spawn、runner、git probe 等注释，
      全仓清零当前态 `hard-required boot runtime` / `daemon refuses to start` 断言。
- [x] **T6 权威文档同步**：更新 `design/plan.md` P-1-04、`design/design.md` health 说明、
      README 中英文、troubleshooting、RFC supersession、`docs/dev-gotchas.md` 与 `STATE.md`。
- [x] **T7 use-time 安全回归**：运行 RFC-224 official build / verified plan / source reachability /
      runtime status/models/smoke 定向测试；增加旧版本/不合格 binary 的显式 runtime
      validation 失败断言，确认版本门只是从 boot 后移且 exact-hash/身份门未变化。
- [x] **T8 全量门禁**：typecheck、lint、format、backend/shared/frontend 全量测试、binary smoke。
- [x] **T9 实现门与交付**：按仓库规则执行 Codex 实现门，修完 findings 后更新 RFC/STATE；仅在用户
      要求时提交/推送。

## 依赖与拆分

- 依赖：RFC-143 RuntimeDriver、RFC-208 bounded external probes、RFC-224 OpenCode verified
  execution。
- 单 PR 原子交付；不拆 migration 或兼容阶段。
- 与进行中的 RFC-225 无生产文件重叠；共享 `STATE.md` / `design/plan.md` 只做追加式协调。

## 验收清单

- [x] 没有安装 OpenCode也能启动 daemon。
- [x] 启动不会执行配置的 OpenCode executable。
- [x] `/health.opencodeVersion === null`，CLI 文案无误导。
- [x] 低于要求或不合格的 OpenCode 在显式 status/Test/models/执行时仍 fail closed。
- [x] Claude Code 与管理面不受 OpenCode 故障影响。
- [x] 无过时源码锁或当前态注释。
- [x] 全部门禁与实现门通过。
