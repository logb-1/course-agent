# course-agent 工具契约

> 本文件是**当前**契约：工具面在 2026-11-20 从「单工具 9 action」换成「9 个原子工具」，旧名
> `course_assistant` 已不存在。改工具面就按这份对齐；`node tools/agent-contract.mjs` 是它的可执行版本。

它约束的是「一组原子工具 + 一个 Host 服务」：工具怎么命名、长任务怎么交还控制权、上下文怎么分段给、
失败怎么说话。以后每次动工具面，都按这八条检查。

## 为什么改

旧工具 `course_assistant` 有 9 个 `action`，其中 `analyze` 会在工具内部阻塞轮询 150 秒。
对 agent 来说这是反模式：模型被一次调用卡住、看不到中间状态、失败时拿不到可行动的信息、
也无法在跑偏时取消。改造分两步，第一步只动「形状」，不动 pipeline。

## 8 条硬规则

1. **一个动词一个工具**。工具名 = 动词短语；没有 `action` 参数，没有别名工具。
2. **长任务先返回句柄**。任何可能超过 2 秒的动作，立即返回 `jobId`，不在工具里 sleep / 轮询。
3. **状态可查询**。`course_status` 是唯一进度来源：`status`、`progress`、`chapters`、`reading`、`warnings`、`ocr`、`error`。
4. **有界输出**。每个工具的输出有上限（字数、条目数），超限用 `truncated` + `nextOffset` / `next` 续读，不静默截断。
5. **显式给下一步**。结果带 `next: { tool, hint }`，告诉模型该调哪个工具，而不是让它猜。
6. **失败给原因可行动**。`{ ok: false, reason }` 用中文写人话（「任务不存在」「目录还没生成（当前 running）」），不裸抛状态码。
7. **先目录后正文**。`course_outline` → `course_read` / `course_ask`，正文按章读、可续读，一次不读全课程。
8. **服务单一实现（双轨收口）**。工具与网页面板都走同一个 `courseAssistant` 服务；`ctx.provide('courseAssistant', api)`，其他插件/工具只能通过服务访问，不各自 new pipeline。

## 工具表

| 工具 | 语义 | 参数 | 返回要点 |
| --- | --- | --- | --- |
| `course_health` | 环境自检 | — | `ok`、`llm`、`pdf`、`ocrEngines`、`limits` |
| `course_ingest` | 建档（异步） | `files`(≤12)、`appendTo`、`reportLevel`、`withVideos`、`days`/`target`/`minutes` | `jobId`、`status`、`next` |
| `course_status` | 进度 | `jobId` | `status`、`phase`、`progress`、`chapters`、`reading`、`warnings`、`ocr`、`reportPath`、`next` |
| `course_outline` | 目录 | `jobId`、`syllabus?` | 每章 `chapter`/`title`/`pages`/`chars`/`read`/`note`/`keyPoints`/`offline`/`coverage` + 汇总 `reading` |
| `course_read` | 读正文 | `jobId`、`chapter`、`offset`、`maxChars`(400–12000) | `text`、`pages`、`charsTotal`、`truncated`、`nextOffset`、`next` |
| `course_ask` | 检索 | `jobId`、`question`、`topK` | `answers[]{page,chapter,text}`、`hint` |
| `course_export` | 导出 | `jobId`、`format`(md/pdf/csv/json) | `path`、`chars`、`preview` |
| `course_library` | 历史 | `limit`(≤20) | `jobs[]{jobId,title,status,...}` |
| `course_cancel` | 取消 | `jobId` | `cancelled: true/false` |

## 作业状态机

```
queued → running → done
                 ↘ cancelled   （course_cancel / 插件卸载）
                 ↘ error       （pipeline 抛错）
                 ↘ interrupted （宿主重启后 reapZombies 判定心跳过期）
```

`done` / `error` / `cancelled` / `interrupted` 都是终态；只有 `running` 允许取消。
`running` 时不允许 `course_export`——报告还没写完。

## `next` 约定

| 当前状态 | next.tool | 提示 |
| --- | --- | --- |
| `running` | `course_status` | 10–60 秒轮询，别重复建档 |
| `error` / `cancelled` / `interrupted` | `course_ingest` | 看 error 原文，重建档 |
| `done` 且无目录 | `course_status` | 等目录落盘 |
| `done` 有目录 | `course_outline` | 先看目录再按章读 |

## 可解释性：读取统计（P1b）

「这章很短」和「这章根本没读到」在报告里长得一样，历史上三个 OCR 静默 bug 就是这么埋掉的。
现在每个作业都带逐章读取统计，口径固定在一处（`core/reading.js`）：

| 字段 | 含义 |
| --- | --- |
| `read.pages` | 本章归属的页数（0 = 该文件没有页概念，如 md/docx） |
| `read.withText` | 其中带可读文字的页数（页文本 ≥ 20 字） |
| `read.ocred` | 其中文字来自 OCR 的页数 |
| `read.unknown` | 页码对不上、无法归因的页数（既不算读到，也不算没读到） |
| `reading.pages` / `withText` / `ocred` | 作业级汇总 |
| `reading.unknownPages` | 作业级无法归因的页数 |
| `reading.unreadPages` / `unreadChapters` | 确实没读到文字的页数（= pages − withText − unknown）/ 未读全的章数 |
| `note` | 仅在该章确实缺页时出现的短句 |

派生行为（都是为了让缺失**说出来**，而不是看起来正常）：

- `course_status.warnings` 首位会多一条 `有 X/Y 页没有可读文字…`，只在 `unreadPages > 0` 时出现。
- `course_outline` 每章带 `read` 与 `note`，agent 讲这章前应先说明依据不全。
- 页码归属靠 `chapter.doc`（`buildOutline` 写入）；多文件页码重复时**不硬猜**，宁可留 `unknown`——
  `unknown` 不参与未读计算，否则等于用猜测制造一个缺口。
- 统计在 `rerunChapter` 里同样重算，重跑不会把这一章变回「无统计」。

## 上下文纪律

- `course_ingest` 不再回灌报告正文（旧工具回 1500 字预览 + 全章要点，是大头 token）。
- 正文只经 `course_read` 按需取，默认 6000 字，上限 12000；`course_ask` 只回 ≤4 条命中片段。
- `course_outline` 的 `keyPoints` 每章截到 6 条、`warnings` 截到 3 条，总数用 `*Total` 字段给。
- `course_export` 的 `preview` 只截正文前 1200 字。
- 读取统计只有计数（4 个整数），不随页数增长；它不是正文通道。

## 破坏性变更

- 旧 `course_assistant` 工具已删除（9 个 action 全部作废）。旧名字下没有兼容壳——留着壳只会让模型
  继续走阻塞路径。
- 面板 HTTP 路由不变（`/course-assistant/*`），网页端不受影响。
- 预设 persona 与 `skills/course-tutor/SKILL.md` 已同步改为新工具名与轮询说明。
- 作业快照新增 `job.reading` 与每章 `stats`；旧 job 文件缺这两个字段时视图按「无统计」处理，不报错。

## 验收

```powershell
node tools/agent-contract.mjs          # 24 条契约断言（含"立刻返回 jobId"与 reading 字段）
node tools/regress.mjs --unit --strict # 66 项单测（含 5 条读取统计），回归 pipeline
```

手动核对一次真实课件（本仓库常用样本 `实验3-面向对象编程&函数式编程.pptx`，56 页）：
`status.reading` 应为 `{pages:56, withText:56, ocred:0, unknownPages:0, unreadPages:0, unreadChapters:0}`。

## 下一步（P2）

- P2：记忆与错题本——目标分、已读章节、错题落 `dsh-storage-domain`，经 `ctx.variables` 注入当前课程。
