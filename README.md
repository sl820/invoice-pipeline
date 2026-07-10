# invoice-pipeline

> 阿里公益平台发票自动化流水线 · Codex Skill

把零散、未规范命名的电子发票 PDF，自动变成按"交款人"公司名重命名、按抬头归档、可批量上传到阿里公益平台的结构化目录。OCR 走阿里云百炼 `bl` 多模态识别（Qwen-VL）。

## 为什么做这个

公益平台报销的发票通常是几百张一批、手动从各种邮件/平台下载下来，文件名是 `110501260003695195.pdf` 这种机器号。一张一张改名、归档、上传，是机械但易错的工作。

`invoice-pipeline` 把这条链拆成 5 步可独立重跑的子任务，每一步幂等、可断点续跑、有失败隔离：

```
scan  ->  ocr  ->  rename  ->  archive  ->  upload
 (1)     (2)     (3)        (4)        (5)
```

- **scan** 扫描待处理 PDF
- **ocr** 调百炼 `bl` 提取"交款人"（优先复用本地 mapping 缓存，零 API 成本）
- **rename** 改为 `{交款人}.pdf`，同公司多张自动加 `(2) (3)` 后缀
- **archive** 按抬头归档到子目录（可选）
- **upload** 自动化上传到阿里公益平台（CDP / Playwright）

## 设计原则

- **幂等**：每一步可以反复跑，目标已存在且内容相同时自动跳过
- **失败隔离**：单张失败不影响整批，失败项进 `out/failed/` 留待人工
- **缓存优先**：识别结果落到 `mapping_*.json`，下次直接复用
- **参数化**：`SourceDir` 可指定任意目录，257 张也好、5 张也好
- **5 步解耦**：可以只跑 scan 做检查，可以只跑 rename 用已有 mapping

## 快速开始

```powershell
# 1. 装 bl CLI（百炼）
npm i -g bailian-cli
bl auth login --api-key sk-xxxxx

# 2. 跑全流程
.\scripts\Invoke-Pipeline.ps1 -SourceDir "E:\阿里发票\阿里257张"
```

更细的用法（干跑 / 强制重 OCR / 指定归档根目录）见 [`SKILL.md`](./SKILL.md)。

## 工程规范

项目按 [`modelstudioai/cli`](https://github.com/modelstudioai/cli) 的 `AGENTS.md` 约定组织：

- 5 步分层 + 错误处理边界 + 禁止单字母变量
- 所有可重跑步骤幂等
- 失败用日志隔离，**不静默吞错**
- 文档/代码/示例三件套齐全

## 仓库结构

```
invoice-pipeline/
+- SKILL.md          # Codex agent 主入口
+- AGENTS.md         # 维护契约（AI / 开发者共用）
+- README.md
+- config/
|  +- config.yaml
+- prompts/
|  +- extract-payer.md
+- scripts/
   +- Scan-Source.ps1
   +- Ocr-Bailian.ps1
   +- Rename-ByPayer.ps1
   +- Archive-ByPayer.ps1
   +- Invoke-Pipeline.ps1
```

## 状态

| Step | 状态 | 备注 |
|------|------|------|
| 1. scan | [x] 已实现 | 纯读 |
| 2. ocr  | [x] 已实现 | 复用 mapping / 调 bl |
| 3. rename | [x] 已实现 | 已用 6 张样本端到端验证（SHA256 一致） |
| 4. archive | [x] 已实现 | 默认跳过 |
| 5. upload | [ ] 占位 | 待 CDP / Playwright 实现 |

## License

Apache-2.0