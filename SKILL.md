---
name: invoice-pipeline
description: 阿里公益平台发票自动化流水线。扫描未规范命名的电子发票 PDF，用百炼 bl 多模态识别提取交款人 + 金额 + 开票日期，按公司名重命名后归档，再用 Playwright/CDP 自动按抬头匹配并上传到公益平台。
---

# invoice-pipeline

把 E:\阿里发票\*\ 下没规范命名的电子发票 PDF，变成 {交款人}.pdf，按抬头归档，再**自动按抬头匹配**后上传到阿里公益平台报销。

本 skill 是端到端流水线，**默认全自动**（无人工复核点），但任何一步失败都进 out/failed/ 并写失败日志，不丢单。

## 触发条件

满足任一即激活：

- 用户说" 处理发票 / 重命名发票 / 上传发票 / 跑发票流水线 / 阿里发票\
- 用户指向 E:\阿里发票\<某目录>\*.pdf
- 用户跑 scripts/Invoke-Pipeline.ps1 或 scripts/Invoke-Upload.ps1

## 主流程（5 步）

`
scan -> ocr -> rename -> archive -> upload
 (1) (2) (3) (4) (5)
`

### Step 1-4: 重命名（不变）

1. 扫 PDF
2. 复用 mapping-*.json 缓存或调 bl 抽交款人
3. 改名为 {交款人}.pdf，同公司加 (2)(3) 后缀
4. 可选按抬头归档

### Step 2: OCR 细节

- 依赖：pdftoppm（poppler）把 PDF 首页转 200 dpi PNG
- 模型：qwen3-vl-plus（百炼 l vision describe）
- 提示词：prompts/extract-payer.md —— 纯转写，不输出 JSON
- 解析：upload/Ocr-Parse.js 用正则从转写文本中抽 payer / mount / invoiceDate
- 缓存：SourceDir\mapping-<ts>.json 含三字段；缺 mount 时自动强制重 OCR（用于支持新版本 amount 消歧）

### Step 5: 上传（含 amount 消歧）

对每个 {交款人}.pdf：

1. **平台登录** + 打开 /open/workbench/employee/org/donation/invoice/manage（票据管理）
2. **填\开票抬头\**= 交款人 + 点查询
3. **筛选\待开具\**状态的行
4. **匹配规则**（v2，amount 消歧）：
 - 0 条\待开具\ → skip（记 failed：已开具 / 平台未申请）
 - **1 条\待开具\** → 自动上传
 - 2+ 条\待开具\ + amount 不空 → 按 amount 筛；筛后 1 条 → 上传；筛后 0/N → skip
 - 2+ 条\待开具\ + amount 空 → skip（让用户人工确认）
5. 点\立即开票\ → 弹框 → setInputFiles
6. 等 .ant-upload-list-item 出现
7. 点\确 定\ → 等弹框关闭（仅 --yes 时）
8. 记录到 uploaded-state.json（幂等）

**前置条件**：

1. 跑 scripts/Start-Chrome-CDP.ps1 启动带远程调试端口（9222）的独立 Chrome
2. 首次在新窗口里手动登录公益平台（cookie 落盘到 C:\codex\chrome-gongyi）

**平台关键 selector（已验证）**：

- 搜索表单：input#control-hooks_invoiceTitle（开票抬头）
- 查 询：utton:has-text('查 询')
- 重 置：utton:has-text('重 置')
- 立即开票： able tbody tr.ant-table-row button:has(span:text-is('立即开票'))
- 弹框文件输入：.ant-modal input[type=file]
- 上传完成：.ant-modal .ant-upload-list-item
- 确 定：.ant-modal .ant-btn-primary:has-text('确 定')
- 取 消：.ant-modal .ant-btn:has-text('取 消')

## 快速开始

`powershell
# Step 1-4: 重命名
.\scripts\Invoke-Pipeline.ps1 -SourceDir \E:\阿里发票\阿里257张\

# Step 5: 上传
.\scripts\Start-Chrome-CDP.ps1 # 启动 Chrome（首次手动登录）
.\scripts\Invoke-Upload.ps1 -SourceDir \E:\阿里发票\阿里257张\ -DryRun # 干跑
.\scripts\Invoke-Upload.ps1 -SourceDir \E:\阿里发票\阿里257张\ -Limit 1 # 测 1 张
.\scripts\Invoke-Upload.ps1 -SourceDir \E:\阿里发票\阿里257张\ -Yes # 真传全量
`

## 文件落点

| 路径 | 用途 |
|------|------|
| SourceDir\*.pdf | 输入 + 重命名后输出 |
| SourceDir\mapping-*.json | OCR 缓存（含 payer / amount / invoiceDate），幂等复用 |
| SourceDir\.ocr-cache\<basename>-p1.png | OCR 临时 PNG（pdftoppm 输出） |
| SourceDir\.ocr-cache\<basename>-ocr.txt | bl 转写原文（用于排查） |
| upload\Ocr-Parse.js | Node 正则解析器（payer / amount / invoiceDate） |
| upload\uploaded-state.json | 上传状态记录，幂等复用 |
| out\failed\ocr-fail-*.log | 单张 OCR 失败日志 |
| out\failed\upload-*.log | 上传失败日志（match-not-found / no-pending / match-multiple / amount-multiple / amount-no-match / error） |
| out\reports\upload-*.txt | 每次运行摘要（ok/skipped/failed） |
| C:\codex\chrome-gongyi | Chrome 独立 profile（首次登录后 cookie 落盘） |

## 失败处理（Step 5）

每个文件独立 try/catch，分流到不同状态：

| 情况 | 动作 | 落点 |
|------|------|------|
| match-not-found | skip | out\failed\upload-*.log |
| 
o-pending | skip | out\failed\upload-*.log |
| match-multiple（amount 空） | skip | out\failed\upload-*.log（含候选列表） |
| mount-multiple（筛后仍 ≥2） | skip | out\failed\upload-*.log |
| mount-no-match（筛后 0） | skip | out\failed\upload-*.log |
| upload-failed | retry 2 次后 fail | out\failed\upload-*.log |
| CDP 端口 9222 未就绪 | 中断 | exit code 1 |
| Chrome 未登录 | 中断 | exit code 1 |

## 与 modelstudioai 仓库的对齐

- modelstudioai/cli/AGENTS.md — 分层 + 错误处理边界 + 禁止单字母变量
- modelstudioai/skills — 1st-party skill 必有 SKILL.md + metadata.version
- modelstudioai/openwork — 多步任务 + 显式断点

## 元数据

`yaml
version: 0.4.0
target_ocr_engine: bailian bl vision describe (qwen3-vl-plus)
target_upload_platform: 阿里公益平台 (https://open.alibabafoundation.com/open/workbench/employee/org/donation/invoice/manage)
upload_tech: Playwright + CDP
match_strategy: 1-to-1 by invoice_title; 2+ rows disambiguated by amount
scope: 电子发票 PDF
default_source_dir: E:\阿里发票\阿里257张\
`
