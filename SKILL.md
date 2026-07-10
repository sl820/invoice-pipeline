---
name: invoice-pipeline
description: 阿里公益平台发票自动化流水线。扫描未规范命名的电子发票 PDF，用百炼 bl 多模态识别提取"交款人"字段，按公司名重命名后归档，再用 Playwright/CDP 自动上传到公益平台。
---

# invoice-pipeline

把 `E:\阿里发票\*\` 下没规范命名的电子发票 PDF，变成 `{交款人}.pdf`，按抬头归档，再自动上传到阿里公益平台报销。

本 skill 是端到端流水线，**默认全自动**（无人工复核点），但任何一步失败都进 `out/failed/` 并写失败日志，不丢单。

## 触发条件

满足任一即激活：

- 用户说"处理发票 / 重命名发票 / 上传发票 / 跑发票流水线 / 阿里发票"
- 用户指向 `E:\阿里发票\<某目录>\*.pdf`
- 用户跑 `scripts/Invoke-Pipeline.ps1` 或 `scripts/Invoke-Upload.ps1`

## 默认作用范围

- 入参目录：`E:\阿里发票\阿里257张\`
- 缓存：`E:\阿里发票\阿里257张\mapping_*.json`（如已存在则复用）
- 输出：`E:\阿里发票\阿里257张\<交款人>.pdf`（原位重命名）
- 失败：`C:\codex\pipelines\invoice-pipeline\out\failed\`
- 上传状态：`upload/uploaded-state.json`（幂等记录，已上传文件自动跳过）

如果要处理别的目录，传参覆盖：

```powershell
.\scripts\Invoke-Pipeline.ps1 -SourceDir "E:\阿里发票\阿里发票370" -ForceReOcr
.\scripts\Invoke-Upload.ps1 -SourceDir "E:\阿里发票\阿里257张"
```

## 主流程（5 步，可独立重跑）

```
scan  ->  ocr  ->  rename  ->  archive  ->  upload
 (1)     (2)     (3)        (4)        (5)
```

每步幂等、断点续跑、独立可调试。具体细节在 `AGENTS.md`。

### Step 1 scan

扫 `SourceDir/*.pdf`，过滤掉已经是 `{交款人}.pdf` 形式（`BaseName` 中不包含下划线前缀数字）的文件，输出待处理清单。

### Step 2 ocr

- 优先复用 `SourceDir/mapping_*.json`：若有，直接读 `payer` 字段，跳过 bl 调用。
- 否则：调 `bl multimodal understand` 把每个 PDF 的"交款人"字段抽出来，落 `SourceDir/mapping_<timestamp>.json`。
- 提示词见 `prompts/extract-payer.md`。

### Step 3 rename

按 `mapping` 把每个文件改成 `{payer}.pdf`。

冲突处理（同 payer 已有文件）：加 `(2)`, `(3)` 后缀，例 `杭州xx公司.pdf`、`杭州xx公司(2).pdf`。

跳过条件：目标文件已存在且内容哈希相同，则跳过。

### Step 4 archive

默认原地不动。如指定 `-ArchiveRoot`，则按 payer 建子目录搬过去：`<ArchiveRoot>\<payer>\<payer>.pdf`。

### Step 5 upload

通过 Playwright + CDP 接管已登录的 Chrome，把 `{payer}.pdf` 批量上传到 `https://open.alibabafoundation.com/index`。

**前置条件**：
1. 跑 `scripts/Start-Chrome-CDP.ps1` 启动带远程调试端口（9222）的独立 Chrome profile
2. 首次在新窗口里手动登录公益平台（cookie 落盘到 `C:\codex\chrome-gongyi`）
3. 填 `upload/Upload-Gongyi.js` 顶部的 `TODO_SELECTOR_*` 选择器（基于真实页面 DOM）

幂等：已上传文件记录在 `upload/uploaded-state.json`，重跑自动跳过。

详见 `upload/README.md`（待补充）。

## 文件落点

| 路径 | 用途 |
|------|------|
| `SourceDir\*.pdf` | 输入 + 重命名后输出 |
| `SourceDir\mapping_*.json` | OCR 缓存，幂等复用 |
| `upload\uploaded-state.json` | 上传状态记录，幂等复用 |
| `out\failed\*.log` | 失败日志，每行一条 |
| `out\reports\*.txt` | 每次运行摘要（处理数/成功/失败/跳过） |
| `C:\codex\chrome-gongyi` | Chrome 独立 profile（首次登录后 cookie 落盘） |

## 失败处理

每个文件独立 try/catch，单张失败不影响整批：

| 异常 | 落点 |
|------|------|
| 识别失败（bl 返回无 payer） | `out\failed\ocr-fail-<basename>.log` |
| 重命名冲突且哈希不同 | `out\failed\rename-conflict-<basename>.log` |
| 上传失败 | `out\failed\upload-<basename>.log` |
| bl 鉴权/网络错误 | 中断整批，提示检查 `bl auth login` |
| CDP 未就绪 / Chrome 未登录 | 启动时检查并中断 |

## 与 modelstudioai 仓库的对齐

本 skill 风格参照：

- `modelstudioai/cli/AGENTS.md` — 分层 + 错误处理边界 + 禁止单字母变量
- `modelstudioai/skills` — 1st-party skill 必有 `SKILL.md` + `metadata.version`
- `modelstudioai/openwork` — 多步任务 + 显式断点

OCR 引擎优先用 `bl`（百炼多模态 Qwen-VL）；如果未来用户已有 PaddleOCR 离线引擎，OCR 步骤可替换为 `scripts/Ocr-Paddle.ps1`，主流程不变。

## 元数据

```yaml
version: 0.2.0
target_ocr_engine: bailian bl multimodal (Qwen-VL)
target_upload_platform: 阿里公益平台 (https://open.alibabafoundation.com/index)
upload_tech: Playwright + CDP
scope: 电子发票 PDF
default_source_dir: E:\阿里发票\阿里257张\
```