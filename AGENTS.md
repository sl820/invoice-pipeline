# invoice-pipeline — AI 维护指南

本文件是 AI agent 维护本 skill 时的契约。改任何脚本前先读这里。

## 项目地图

skill 是端到端流水线，5 步可独立重跑：

| 步骤 | 脚本 | 输入 | 输出 |
|------|------|------|------|
| 1. scan | `scripts/Scan-Source.ps1` | `SourceDir` | `out\scan-<ts>.json`（待处理清单） |
| 2. ocr  | `scripts/Ocr-Bailian.ps1`   | `out\scan-*.json` 或 `SourceDir` | `SourceDir\mapping-<ts>.json` |
| 3. rename | `scripts\Rename-ByPayer.ps1` | `SourceDir\mapping-*.json` | 原位重命名 |
| 4. archive | `scripts\Archive-ByPayer.ps1` | `SourceDir\*.pdf` | `<ArchiveRoot>\<payer>\` |
| 5. upload  | `upload/Upload-Gongyi.js`  | `SourceDir\*.pdf` + `upload\uploaded-state.json` | 公益平台已上传 |

入口：
- `scripts/Invoke-Pipeline.ps1` 调 1→2→3→4，跳过 5
- `scripts/Invoke-Upload.ps1` 单独调 5

## 关键约定

### 1. OCR 缓存优先

`SourceDir\mapping_*.json` 一旦存在，**Step 2 默认复用**。要强制重跑传 `-ForceReOcr`。这是为了避免对同一批 PDF 重复烧百炼 API。

JSON 格式（`mapping_*.json`）：
```json
[
  {
    "pdf": "E:\\阿里发票\\阿里257张\\110501260003695195.pdf",
    "payer": "杭州薄山勇捷服装经营部",
    "method": "bl-multimodal-understand",
    "model": "qwen-vl-max",
    "elapsed_ms": 0,
    "error": ""
  }
]
```

**重要：所有 JSON 读写必须用 UTF-8**（`[System.IO.File]::ReadAllText(..., [System.Text.UTF8Encoding]::new($false))`），不要用 `Get-Content` / `Set-Content`，否则 PowerShell 默认按 GBK 解码 UTF-8 无 BOM 文件会出乱码。

### 2. 上传状态优先

`upload\uploaded-state.json` 记录每个已上传文件（按 `size-mtime` 哈希去重）。重跑自动跳过。

### 3. 幂等

每个 step 都可以独立反复跑，不产生副作用：

- `scan` — 纯读
- `ocr` — 已有 mapping 就跳过
- `rename` — 目标已存在且 SHA256 相同则跳过；不同则进 `out\failed\rename-conflict-*.log`
- `archive` — 目标已存在且 SHA256 相同则跳过
- `upload` — uploaded-state.json 中 hash 一致则跳过

### 4. 错误处理边界

**只对"自己能权威解释的错误"做语义化处理**。bl 服务端错误原样透传，不二次包装。

| 错误来源 | 归类 | 处理 |
|---------|------|------|
| 缺参、SourceDir 不存在 | 内部 | throw + 退出码 2 |
| mapping JSON 解析失败 | 内部 | 终止整批，要求修复 JSON |
| 单个 PDF 识别 bl 返回无 payer | 内部 | 进 `out\failed\ocr-fail-*.log`，继续下一张 |
| bl CLI 鉴权/网络错误 | 内部 | throw + 退出码 1（中断整批） |
| 重命名冲突（哈希不同） | 内部 | 进 `out\failed\rename-conflict-*.log`，继续 |
| CDP 端口 9222 未就绪 | 内部 | 提示跑 `Start-Chrome-CDP.ps1`，退出码 1 |
| Chrome 未登录公益平台 | 内部 | 退出码 1，提示手动登录 |
| bl 返回的 HTTP 业务错码 | 服务 | 原样记日志，不解读 |

### 5. 文件名规范化

`{payer}.pdf` 中如出现 Windows 非法字符 `\ / : * ? " < > |`，替换为 `_`。保留中文、英文、空格、括号、`&`。

### 6. 禁止单字母变量

跟 `modelstudioai/cli/AGENTS.md` 对齐。例外：仅在作用域 ≤3 行且语义完全明确时可用 `k`/`v`。

### 7. PowerShell 版本

目标 PowerShell 5.1+（Windows 默认）。不用 7+ 专属语法（`??`, `?.` 等）。

### 8. Node 版本

`upload/` 目录要求 Node >= 20。Playwright 1.61+ 兼容 Node 24。

## 扩展指南

### 加新 OCR 后端

1. 在 `scripts/` 下新建 `Ocr-<Engine>.ps1`，签名一致：`-SourceDir <path> -OutputJson <path>`
2. `Invoke-Pipeline.ps1` 加 `-OcrEngine {Bailian|Paddle}` 参数分支
3. 输出 JSON 格式必须兼容（见约定 1）

### Step 5 upload 选择器配置

`upload/Upload-Gongyi.js` 顶部有 5 个 `TODO_SELECTOR_*` 常量，需要在真实页面上确认后填入：

| 常量 | 含义 | 怎么找 |
|------|------|--------|
| `TODO_SELECTOR_LOGIN_INDICATOR` | 登录后才有的元素 | F12 登录前后对比 |
| `TODO_SELECTOR_UPLOAD_BUTTON` | 触发上传的入口按钮 | 右键 → Copy selector |
| `TODO_SELECTOR_FILE_INPUT` | `<input type="file">` | 通常隐藏 |
| `TODO_SELECTOR_SUBMIT_BUTTON` | 上传后"提交"按钮（如有） | 如果上传即提交，留 null |
| `TODO_SELECTOR_SUCCESS_INDICATOR` | 上传成功标志 | "上传成功" 文本 / 列表多了一行 |

填好后用 dry-run 跑一次：
```powershell
.\scripts\Invoke-Upload.ps1 -SourceDir "E:\ALI-INV\sample" -DryRun
```
然后 `-Limit 1` 试一张真实上传。

### 实现其它上传平台

`upload/` 下新建 `Upload-<Platform>.js`，实现同样的 CLI 签名（`--source-dir`, `--dry-run`, `--limit`），`Invoke-Upload.ps1` 加 `-Platform` 参数。

## 验证

```powershell
# 1. 干跑 scan
.\scripts\Scan-Source.ps1 -SourceDir "E:\阿里发票\阿里257张"

# 2. 强制 OCR（已有 mapping 也会重跑）
.\scripts\Ocr-Bailian.ps1 -SourceDir "E:\阿里发票\阿里257张" -ForceReOcr

# 3. 跑 rename（用现有 mapping）
.\scripts\Rename-ByPayer.ps1 -SourceDir "E:\阿里发票\阿里257张"

# 4. 全流程
.\scripts\Invoke-Pipeline.ps1 -SourceDir "E:\阿里发票\阿里257张"

# 5. 上传
.\scripts\Start-Chrome-CDP.ps1
.\scripts\Invoke-Upload.ps1 -SourceDir "E:\阿里发票\阿里257张" -DryRun
.\scripts\Invoke-Upload.ps1 -SourceDir "E:\阿里发票\阿里257张" -Limit 1
```

## 这份指南怎么演化

跟 `modelstudioai/cli/AGENTS.md` 一样，**随真实工作沉淀**。发现新场景/新坑 → 补到对应 step 的"扩展指南"下。