# evals

行为评测。判分只用程序能证明的事实——页码、字数、字段、拒绝码——所以这些检查不需要模型，也不会因为模型换了就漂移。

```bash
# 真实课件（路径自备；每块课件跑一次建档）
node evals/run.mjs --deck "实验3=C:/Users/ThinkPad/Desktop/实验3-面向对象编程&函数式编程.pptx"
node evals/run.mjs --deck "栈帧=C:/Users/ThinkPad/Desktop/栈帧专题_方法真题变式答案.pdf"

# 不存在的路径会被跳过；CI 用合成夹具，不需要任何课件
node evals/run.mjs --fixture

# 记录当前行为（之后每次跑都和它比）
node evals/run.mjs --fixture --write-baseline

# 只跑一类
node evals/run.mjs --fixture --only gate
```

## 测什么

| 任务 | 判据 | 为什么值得钉住 |
| --- | --- | --- |
| `reading-honesty` | `unreadPages = pages - withText - unknown`，且 >0 时必须出现在 `warnings` | 三个 OCR 静默 bug 当年就是「没读到」和「这章短」长得一样 |
| `citation-range` | `course_read` 的页码落在该章页码范围里 | 引到不存在的页 = 编造来源；纯文本文档没有页码，判为「不适用」 |
| `read-bounds` | 返回字数 ≤ 请求上限，`chars` 与 `text` 一致，未静默丢后半章 | 上下文膨胀最常见的方式是「顺手多返回一点」 |
| `read-continuation` | 长章必须给 `nextOffset` | 没有续读，模型只能重复读同一段或囫囵吞下 |
| `ask-miss` | 问课件里没有的东西 → 0 条 + 解释 | BM25 永远会排第一；不给空结果，模型就会把无关段落讲成答案 |
| `ask-hit` | 真问题 → 每条片段都带 `chapter` + `page` | 可溯源的片段才能支撑「第 12 页说……」 |
| `confirm-gate` | `max/plus` 无 `confirm:true` → `needs_confirm` | 成本闸门写在描述里不算闸门 |
| `export/status/read/outline-gate` | 未知 job → `job_not_found` + `hint` | 模型要靠 code 分支，不能靠中文猜 |
| `cost-visibility` | `status.cost`（模型调用/缓存命中）与 `status.tools`（调用序列）存在 | 「慢」「贵」没有数字就只是感受 |

## 不测什么

**讲解写得好不好**。那需要真实模型和人的判断。做法是在 DSH 里用「课程助教」预设跑同一批课件，人工对照 `baseline.json` 里的读取统计与工具序列——确定性部分由这里保证，语言部分由人保证。把 LLM judge 也放进来之前，先别假装它能替代人。

## baseline

`baseline.json` 是上一次通过时的记录：每块课件的 `reading` 数字与每个任务的通过状态。日常跑会对比它，出现「原本通过的任务失败」或「未读页数变化」就报 drift 并以非零退出。

生成 baseline 的课件不在仓库里（学生课件不该公开），所以 CI 只跑 `--fixture`；真实课件的 baseline 在本地机器上维护。
