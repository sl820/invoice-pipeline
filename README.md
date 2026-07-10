# invoice-pipeline

> 阿里公益平台发票自动化流水线 · Codex Skill

把零散、未规范命名的电子发票 PDF，自动变成按"交款人"公司名重命名、按抬头归档、**按抬头匹配**后批量上传到阿里公益平台。OCR 走阿里云百炼 `bl` 多模态识别（Qwen-VL）。

## 为什么做这个

公益平台报销的发票通常是几百张一批、手动从各种邮件/平台下载下来，文件名是 `110501260003695195.pdf` 这种机器号。一张一张改名、归档、按抬头找到对应申请再上传，是机械但易错的工作。

`invoice-pipeline` 把这条链拆成 5 步可独立重跑的子任务，每一步幂等、可断点续跑、有失败隔离：

```
scan  ->  ocr  ->  rename  ->  archive  ->  upload
 (1)     (2)     (3)        (4)        (5)
```

- **scan** 扫描待处理 PDF
- **ocr** 调百炼 `bl` 提取"交款人"（优先复用本地 mapping 缓存，零 API 成本）
- **rename** 改为 `{交款人}.pdf`，同公司多张自动加 `(2) (3)` 后缀
- **archive** 按抬头归档到子目录（可选）
- **upload** 平台搜索"开票抬头"= 交款人 → 找"待开具"申请 → 1-to-1 匹配 → 上传 PDF

## 设计原则

- **幂等**：每一步可以反复跑，目标已存在且内容相同时自动跳过
- **失败隔离**：单张失败不影响整批，失败项进 `out/failed/` 留待人工
- **1-to-1 严格匹配**：上传时只处理"恰好 1 条待开票申请"的情况，0 条 / 多条都进 failed 让用户决定
- **缓存优先**：识别结果落到 `mapping_*.json`，上传记录到 `uploaded-state.json`，下次直接复用
- **参数化**：`SourceDir` 可指定任意目录
- **5 步解耦**：可以只跑某一步

## 快速开始

### 处理 + 重命名（Step 1-4）

```powershell
# 1. 装 bl CLI（百炼）
npm i -g bailian-cli
bl auth login --api-key sk-xxxxx

# 2. 跑全流程
.\scripts\Invoke-Pipeline.ps1 -SourceDir "E:\阿里发票\阿里257张"
```

### 上传到公益平台（Step 5）

```powershell
# 1. 启动带 CDP 的 Chrome（独立 profile，不影响你日常 Chrome）
.\scripts\Start-Chrome-CDP.ps1

# 2. 弹出窗口里手动登录 https://open.alibabafoundation.com/index
#    登录后**关掉这个 Chrome 窗口**（cookie 落盘到 C:\codex\chrome-gongyi）

# 3. dry-run 试一遍（不上传，只走流程）
.\scripts\Invoke-Upload.ps1 -SourceDir "E:\阿里发票\阿里257张" -DryRun

# 4. 限 1 张真传测试
.\scripts\Invoke-Upload.ps1 -SourceDir "E:\阿里发票\阿里257张" -Limit 1

# 5. 全量真传
.\scripts\Invoke-Upload.ps1 -SourceDir "E:\阿里发票\阿里257张" -Yes
```

## 上传匹配规则

- 平台搜索"开票抬头"= PDF 交款人
- **只处理"待开具"**状态（"已开具"自动跳过）
- **0 条匹配** → skip：PDF 对应的发票可能平台还没申请
- **1 条匹配** → 自动上传
- **2+ 条匹配** → skip：同公司多张待开票（不同店铺/月份），需要人工确认

## 工程规范

项目按 [`modelstudioai/cli`](https://github.com/modelstudioai/cli) 的 `AGENTS.md` 约定组织：

- 5 步分层 + 错误处理边界 + 禁止单字母变量
- 所有可重跑步骤幂等
- 失败用日志隔离，**不静默吞错**
- 文档/代码/示例三件套齐全

## 仓库结构

```
invoice-pipeline/
+- SKILL.md                 # Codex agent 主入口
+- AGENTS.md                # 维护契约（AI / 开发者共用）
+- README.md
+- LICENSE
+- config/
|  +- config.yaml
+- prompts/
|  +- extract-payer.md
+- scripts/                 # PowerShell 入口
|  +- Scan-Source.ps1
|  +- Ocr-Bailian.ps1
|  +- Rename-ByPayer.ps1
|  +- Archive-ByPayer.ps1
|  +- Invoke-Pipeline.ps1
|  +- Start-Chrome-CDP.ps1
|  +- Invoke-Upload.ps1
+- upload/                  # Node + Playwright
   +- package.json
   +- Upload-Gongyi.js      # 主上传脚本
   +- uploaded-state.json   # 上传幂等记录（自动生成）
   +- node_modules/
```

## 状态

| Step | 状态 | 备注 |
|------|------|------|
| 1. scan | [x] 已实现 | 纯读 |
| 2. ocr  | [x] 已实现 | 复用 mapping / 调 bl |
| 3. rename | [x] 已实现 | 已用 6 张样本端到端验证（SHA256 一致） |
| 4. archive | [x] 已实现 | 默认跳过 |
| 5. upload | [x] 已实现 | Playwright + CDP；dry-run 用 3 张样本验证 ok=1 skipped=2 |

## License

Apache-2.0