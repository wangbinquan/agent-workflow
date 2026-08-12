# RFC-293 实施计划：Intent 持续迭代工作台

> 2026-08-13 用户最终裁决：只实现功能与 UX。删除此前设计门引入的 sealed runtime、credential/auth adapter、
> containment、capture quarantine、历史清洗及所有 Intent-only 能力收缩。Intent 继续复用现有普通 system-agent
> runtime 路径。

## 0. 并发与交付纪律

- 共享 `main`，不建分支；每批开工、提交、推送前重新检查 `git status`。
- 只精确暂存 RFC-293 owned paths/hunks，不带 RFC-286 或其他并发 WIP。
- 生产改动与测试同批落地。
- 最终跑 `bun run gate:local`，推送后核验包含 exact SHA 的 terminal CI。

## 1. 批 A：合同、迁移与纯状态

- [x] A1 shared working-set delta/request/DTO、iteration/current-action、draft lifecycle/activity、composer source、
      journey reasons；strict schema tests。
- [x] A2 分配最新连续 migration：`intent_working_set_changes`、`intent_draft_resolutions`、turn mutation id/index；
      Drizzle schema 与 fresh/upgrade migration tests。
- [x] A3 `services/intent/workingSet.ts` 纯 delta：add existing/closure/new、remove root、duplicate/contradiction、
      unavailable removal、六类型、64+ roots、watermark 单调、immutable input。
- [x] A4 detail 投影 drafts/working-set/composer/retry source；旧字段兼容。

## 2. 批 B：Working context 排队与自动续跑

- [x] B1 submit/replace/cancel/retry service；same mutation replay与 exact source fence。
- [x] B2 idle activate：delta、context revision、user turn、agent reservation 单事务。
- [x] B3 running queue 与 interrupt；cancel 后只 drain 一个 successor。
- [x] B4 抽 Intent dispatcher；run settle/start failure/cancel 后 drain。
- [x] B5 boot recovery 与现有 hourly recovery drain lost wake。
- [x] B6 `/working-set` POST/DELETE/retry routes、detail/WS invalidation。
- [x] B7 backend normal/stale/replay/replace/cancel/failure/restart/concurrency tests。

## 3. 批 C：持续迭代与当前待办

- [x] C1 `/iterations`：refine-current、continue-checkpoint、regenerate；source fence与 mutation replay。
- [x] C2 draft settle 自动 supersede；regenerate 原子 discard；apply 拒绝 resolved draft。
- [x] C3 retry 只对 latest generation error；questions 不可 retry。
- [x] C4 `/current-action` 一次验证/提交 questions + mount decisions，只 reserve 一轮。
- [x] C5 journey/action projection tests：refine success/failure、post-commit、discard failure/retry、stale tab、combined action。

## 4. 批 D：Frontend Workbench

- [x] D1 full-width/full-height 页面骨架，桌面独立滚动，1080px tabs，删除右栏嵌套纵向滚动。
- [x] D2 顶部 Working Context Bar + 批量 Dialog；多类型 staged add/remove，queue/interrupt/replace/cancel/retry。
- [x] D3 timeline near-bottom pin 与“回到最新”；左右 pane geometry/state 独立。
- [x] D4 合并 Current Action：questions + mount suggestions 单 footer。
- [x] D5 来源感知 Composer：conversation/refine current/continue checkpoint。
- [x] D6 draft history/lifecycle；继续完善、废弃并重新生成、提交；checkpoint continue。
- [x] D7 中英文、loading/error/empty、keyboard/touch/reduced-motion；frontend tests。

## 5. 批 E：系统验收与上库

- [x] E1 stub runtime 支持 slow turn 与多 revision；后端 fake 覆盖 failure/retry/regenerate。
- [x] E2 E2E 覆盖长会话独立滚动、运行中 queue 自动续跑、提交前 refine、提交后 continue、discard/regenerate；
      后端覆盖 interrupt 与 exact retry。
- [x] E3 1800px wide desktop、1080px tabs、390×844 touch/mobile geometry 浏览器验收与源码回归锁。
- [x] E4 更新 RFC/STATE/index，确认没有新增 runtime capability rejection。
- [x] E5 `bun run gate:local` 全绿。
- [ ] E6 精确 commit、push `main`、核验 co-author trailer、remote ancestry 与 exact-SHA/superseding CI。

## 6. 完成判据

- 用户最初三项 UX 问题均有真实浏览器证据；
- 提交前多轮、提交后继续、废弃重跑三条主线均有后端与 E2E；
- 运行中工作上下文变更无需手工消息即可收敛；
- Intent runtime 能力与本 RFC 前一致，没有新增 sandbox/sealed/auth/capability 限制；
- 本地完整门禁和远端 CI 终态通过。
