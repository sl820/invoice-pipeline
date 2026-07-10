# invoice-pipeline

阿里公益平台发票自动化流水线。源自 modelstudioai 仓库调研（`modelstudioai/skills` + `modelstudioai/cli` + `modelstudioai/openwork`）。

## 流水线

```
scan -> ocr -> rename -> archive -> upload
```

- **scan** — 扫描 `SourceDir/*.pdf`
- **ocr** — 调百炼 `bl` 多模态识别"交款人"（优先复用本地 `mapping_*.json` 缓存）
- **rename** — 改为 `{交款人}.pdf`（冲突时加 `(n)` 后缀）
- **archive** — 按抬头归档到子目录（可选）
- **upload** — Playwright/CDP 自动化上传到阿里公益平台（本版未实现）

## 快速开始

```powershell
cd C:\Users\hbusl\Documents\发票\invoice-pipeline

# 干跑：只 scan，看哪些文件需要处理
.\scripts\Invoke-Pipeline.ps1 -WhatIf

# 全流程（默认 SourceDir = E:\阿里发票\阿里257张）
.\scripts\Invoke-Pipeline.ps1

# 强制重新调 bl（忽略已有 mapping）
.\scripts\Invoke-Pipeline.ps1 -ForceReOcr

# 跑完 rename + 按 payer 归档到指定目录
.\scripts\Invoke-Pipeline.ps1 -ArchiveRoot "E:\阿里发票\archive-by-payer"
```

## 目录

```
invoice-pipeline/
├── SKILL.md          # agent 主入口
├── AGENTS.md         # 维护契约
├── scripts/          # 5 步 + 入口
├── config/           # 配置
├── prompts/          # bl 提示词
├── examples/         # 示例数据
└── out/              # 报告/失败日志
```

## 失败排查

```powershell
# 看失败清单
Get-ChildItem .\out\failed\ -File

# 重跑某张（先删 mapping 中对应条目）
```

详见 `AGENTS.md`。