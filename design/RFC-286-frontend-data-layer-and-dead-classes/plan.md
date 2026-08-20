# RFC-286 — 任务分解（plan）

- T1 F1 死 class 六点 + Checkbox 换用 + join 分隔符 i18n（含 grep 锁与 RTL 断言）。
- T2 F2 bare fetch 三点收敛 + 第二 decoder 删除 + saveBlob 合一。
- T3 F3 shared schema 下沉（后端 parse 对拍先行；前端换 import；OidcProviderRow 核对）。
- T4 F4 WS 关联 queryKey 工厂化（契约锁随迁 + 零字面 key grep 锁）。
- T5 实现门（独立子代理）+ backlog 对账（本轮不修清单中 F1/F2 对应行剔除、
  其余 UI 项保留）+ STATE/索引收尾。

依赖：T1-T4 互独立可并行小步；每批 pin worktree gate 全绿。

## 验收清单

- [x] AC-1…AC-5（proposal §5）—— 2026-08-20 复验：AC-1 / AC-2 / AC-4 三条锁
      （`rfc286-f1-dead-class-extinction` + `rfc286-f2-download-convergence` +
      `task-sync-rules`）在当日 HEAD 重跑 **18/18 绿**；AC-3 的 parse 对拍锚
      （`rfc271-resource-package-hardening` 内 `PackagePreviewSchema.parse` /
      `PackageImportReceiptSchema.parse`）**12/12 绿**；AC-5 见下条。
- [x] 零视觉基线漂移 —— 本 RFC 八个提交（`f2c97b41` … `afa0d4f3`）**零** snapshot /
      `.png` 文件改动，无需按仓规刷新基线；含全部 RFC-286 提交的 `53c57080`
      （`afa0d4f3` 为其祖先）CI **40/40 全绿**，其中
      `Playwright visual regression (ubuntu)` = success。

> **收口（2026-08-20）**：`design/plan.md` 索引状态由 In Progress 置 **Done**。
> 此前滞留 In Progress 的唯一原因是状态行自留的「待门禁/CI 复验后置 Done」无人回填
> ——代码 2026-08-13 当天即已全部落主干，本次只是把复验证据补齐并回填状态，
> 未产生任何生产改动。

## 实施记录（2026-08-13）

- **T2/F2（commit f2c97b41）**：lib/download.ts 单点（saveBlobAs + 显式
  DOWNLOAD_DEADLINE_MS 大预算常量，V3 无 300s 硬顶回归）；worktree-download
  bare fetch → api.getBlob + AbortSignal，404 回退链改 catch ApiError 形态，
  portArtifactItemPath 相对路径新增（绝对 URL 变体留给 tasks.preview <img>）；
  WorktreeFilesPanel/reviews.detail 收敛；ImportZipPanel 三处 authedFetch →
  api.get/postMultipart，第二 decoder（readResponseError）删除、错误映射改
  ApiError→ZipUiError（后端 code 结构化透传）。rfc286-f2 五锁 + import-zip
  commit 错误用例按新语义改判。影响面 97+39 绿。
- **T1/F1（936592e4）**：error-text ×6（tasks.new 五点 + RepoSourceList）换
  ErrorBanner/NoticeBanner；MultiDoc 手搓 form-field/label/error 整块换
  Field(error)；ScriptEdit 的 form-error 系唯一嵌套定义生效语境入 allowlist；
  **checkbox-row 逐锚复核：已被先行改动修掉**（降级复核记录）；ErrorDetails
  join('、') → i18n namesSeparator（zh '、'/en ', '）。rfc286-f1 灭绝锁 +
  launch 两条源锁改组件用法锚；ErrorBanner 的 testid 透传为 RFC-203 既有
  （design 前置「无透传」注过期）。102/102 绿。
- **T3/F3（6e028b9c）**：shared/schemas/resourcePackage.ts（requirements 必填
  ——parse 层 .default([]) 定音落地；PackageSecretRef 撞 bundle/secrets 既有
  接口→按单源复用其类型、本模块只补校验形状）；后端 preview satisfies 锚
  零阻力落位（今日无漂移）；前端 client 改 import+re-export、Dialog 空态
  常量化、夹具补全形；settings OidcProviderRow → shared OidcProvider 别名。
  前端 47 + 后端 37 绿。
- **T4/F4（eab5742a）**：lib/query-keys.ts 三族工厂；useTaskSync 规则表
  16+ 字面全换符号 + tasks.detail 五处 WS 关联 inline（D16 定界）；契约锁
  改符号断言 + 零字面 grep 锁。23/23 绿。
- **T5 实现门（双路独立子代理，基线 83088a83）+ 全量处置**：
  - 路 1 P1-1 / 路 2 P2-1（同一条：F4 只迁部分）——**按 RFC 自身 AC-4 补迁**，
    不做面收窄：三张 WS 规则表（useTaskSync/useTasksSync/useClarifyWs）零字面
    （grep 锁从单文件扩到三文件）；工厂补 root()/alerts()；消费端全量收编
    （tasks.detail 残留 setQueryData/questions/directives、tasks.preview、
    tasks.new、TaskQuestionList、QuestionAuthorForm、StuckTaskBanner、
    RepairChoiceDialog、TaskDiagnosePanel、WorkgroupRoom、taskNav、SessionTab、
    reviews 双路由、clarify 双路由、CentralizedAnswerDialog——此前对它的字面锁
    豁免取消，clarify-node-click-nav RFC-161 锁改符号锚）。前缀子 key（members/
    snapshot/structural-diff/repair-options/session/list-filter）改
    `[...factory(), …]` 显式挂前缀。非 WS 面（versions/version-body/peers/
    homepage/task-operations 等）按 D16 留字面。detailPrefix 死符号删除
    （路 1 P3-3）。
  - 路 2 P2-2（下载 1h 硬顶劣于旧无限时）——withDeadline 增 Infinity 不限时
    支线（跳过 AbortSignal.timeout），DOWNLOAD_DEADLINE_MS=Infinity；取消权
    归调用方 signal（fetchWorktreeFileBlob 补 signal 形参，路 1 P3-4）；f2 锁
    补 Infinity 行为用例。
  - 路 1 P2-1（AC-2 bare-fetch 归零锁未落）——f2 测试补 src 全扫描锁
    （api/client.ts 唯一豁免；成员声明位 `fetch(` 排除）。
  - 路 1 P2-2（第四份 a[download] 拷贝漏账）——resource-package-download 的
    triggerBlobDownload 收编为 saveBlobAs re-export；download.ts 顶注改「四处」。
  - 路 1 P3-1 / 路 2 P3-6（F1 锁只抓静态 className）——加任意引号字符串形态
    扫描（注释剥除；MemoryDialogShell 历史注释免误伤）。
  - 路 1 P3-2 / 路 2 P3-1（AC-3 运行时 parse 对拍缺失）——rfc271-hardening 里
    对真实 buildPackagePreview 产出加 `PackagePreviewSchema.parse` 锚 + commit
    受据加 `PackageImportReceiptSchema.parse` 锚。
  - 路 2 P3-2（SecretRef 注释反向）——shared 注释勘误：宽 string 只是接口形状，
    wire 恒六类 enum（parse 层严格校验）。
  - 路 2 P3-3（worktree-download「<img>」注释失实）——勘误为「带鉴权头的原生
    fetch 需绝对地址」。
  - 路 2 P3-4（V2 离线本地化未兑现）——ImportZipPanel errorFromUnknown 接
    resolveApiError，exact/override 命中显示站点级译文（network-unreachable /
    http-<status> 家族），domain 级不吃（防结构化 message 压平）；恒占位
    fallback 分支随之消灭；import-zip 两用例按 V2 语义改判。
  - 路 1 P3-5（zipCommitFailedFallback 恒占位）——被上一条顺带消灭（exact 命中
    路径不再走 fallback 拼接）。
  - Windows 假阳（83088a83 CI）——F1 锁 relative() 反斜杠归一化（465758c6）。
  - 路 1「攻不破面」/路 2「攻不破面」全部留档为回归依据；路 2 确认 F3 混版
    无 P1（对话框运行时防御保留）。
  - 误勘更正：checkbox-row 灭绝系 5e95ac58（intent commit-flow 修复）先行完成，
    本 RFC 只做复核；ErrorBanner testid 透传为 RFC-203 既有能力。
