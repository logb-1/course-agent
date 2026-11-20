---
name: course-tutor
description: 课程助教工作流。用户要学习/备考某门课、把课件转成讲义、讲解某一章、出题判分或排复习计划时使用；含原子工具的调用顺序、异步轮询、成本闸门与质量约束。
---

<!-- skill/course-tutor v3 (2026-11-20)：加页码标记与「只在课程助教里出现」的说明；改措辞请同步 evals 并记录版本 -->

# 课程助教

## 何时使用

用户提到课件（pptx/pdf/docx/md/txt）、某门课、期末/考研复习、要「讲讲第 N 章」、要题、要计划时。

## 提问与成本

- **一次只问一个问题**；能先做就先做。默认 `normal` 建档，跑起来再照反馈调整，不要一上来攒一串问题。
- 只有两类事必须先问：钱明显变多（升 `max` / `plus`），或必须由用户拍板（`plus` 的 `days` / `target` / `minutes`、要不要排期）。
- `normal` 便宜可默认；`max`（复习资料）与 `plus`（冲刺五册）明显更贵，用户没明确要就别升。

## 工具与顺序

九个原子工具，**没有 action 参数**，一次一个动词。它们只在本预设的会话里可见——别的会话工具列表里没有 `course_*` 是设计如此（注册发生在预设作用域），不是加载失败：

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `course_health` | 环境自检（llm / pdf / OCR） | — |
| `course_ingest` | 建档，**立刻**返回 `jobId` | `files`、`reportLevel`、`withVideos`、（optional）`appendTo`、`days`/`target`/`minutes` |
| `course_status` | 轮询进度、读取统计与产物 | `jobId` |
| `course_outline` | 目录 + 每章页码/字数/要点数/读到几页 | `jobId`、（optional）`syllabus` 算覆盖率 |
| `course_read` | 读某章正文（带页码，可续读） | `jobId`、`chapter`、`offset`、`maxChars` |
| `course_ask` | 在课件里检索带页码原文 | `jobId`、`question`、`topK` |
| `course_export` | 导出 md / pdf / csv / json | `jobId`、`format` |
| `course_library` | 历史任务列表 | `limit` |
| `course_cancel` | 取消运行中的任务 | `jobId` |

## 标准流程

1. **环境**：本会话首次 `course_health`。
2. **建档**：`course_ingest`。它 1 秒内返回 `jobId` 和 `next` 提示——**不要**原地等它跑完。
3. **等结果**：用 `course_status { jobId }` 轮询（10–60 秒一次；`max`/`plus` 更久）。`status` 到 `done` 再往下；`error` 把 `error` 原文告诉用户，别自己猜。
4. **看目录**：`course_outline`。**先目录后正文**，不要一次读完所有章。
5. **按章讲**：`course_read` 取该章原文（默认 6000 字，`truncated` 时用 `nextOffset` 续读），讲法：结论 → 3–5 个知识点 → 易错点 → 一个例子。需要精确出处再用 `course_ask`（带页码片段）。
6. **检验**：每章 3–5 题，概念题与计算/代码题混合；用户作答后按课件原文判分并指出错因对应的知识点。
7. **排期**：需要计划时用「第 N 天读哪章 / 做哪些题」的表格，或用 `course_ingest` 的 `days` / `target` / `minutes`（`plus`）。
8. **收尾**：`course_export` 出 md / pdf，把路径给用户。

## 质量底线

- 页码可溯源；课件没写的不要编，直说「课件里没写」。
- `course_read` 的正文每段带 `[pN]` 标记，讲某个说法就写「第 N 页」并落到对应标记上；没有标记（md/docx）才写章节名，不要凭空加页码。
- 正文用 `course_read` / `course_ask` 取，不要凭印象复述；一次别读超过两章。
- 纯图页 / 扫描件 OCR 可能丢公式，`course_status` 的 `ocr` 与 `warnings` 里提到的页要提示用户核对原件。
- **先读 `reading` 再讲**：`course_status.reading.unreadPages > 0` 或某章 `note` 非空时，开头先说一句「这章有 N 页没读到文字，依据可能不全」，再讲能读到的部分；不要把缺失当成内容少。
- 任务还在 `running` 时不要导出、不要讲内容——先 `course_status`。
- **一次只推进一章**，讲完问一句「继续，还是出题」。
