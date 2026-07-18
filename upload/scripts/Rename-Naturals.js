#!/usr/bin/env node
// Rename-Naturals.js
// 处理 mapping 中 payer 是自然人/小店 的记录，且原 PDF（mapping 里的 pdf 路径）仍存在的部分
// 用法: node Rename-Naturals.js --source-dir <dir>
const fs = require("fs");
const path = require("path");

function arg(n, d) { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; }
const SOURCE_DIR = arg("--source-dir", "");
if (!SOURCE_DIR) { console.error("Usage: node Rename-Naturals.js --source-dir <dir>"); process.exit(2); }

// 找最新 mapping
const mappingDir = path.join(SOURCE_DIR, "mapping-runs");
const maps = fs.readdirSync(mappingDir).filter(n => n.startsWith("mapping-") && n.endsWith(".json"));
if (maps.length === 0) { console.error("no mapping found"); process.exit(2); }
maps.sort();
const mapFile = path.join(mappingDir, maps[maps.length - 1]);
console.log("using:", mapFile);

const data = JSON.parse(fs.readFileSync(mapFile, "utf8"));
let renamed = 0, skipped = 0, failed = 0, missing = 0;

function sanitize(s) {
  // Windows 非法字符
  return s.replace(/[<>:"|?*]/g, "_").trim();
}

for (const rec of data) {
  if (!rec.payer) { skipped++; continue; }
  if (!fs.existsSync(rec.pdf)) {
    missing++;
    continue;
  }
  const dir = path.dirname(rec.pdf);
  const baseName = path.basename(rec.pdf, ".pdf");
  // 如果当前不是纯票号格式，跳过（已被 rename 过了）
  if (!/^\d{10,}$/.test(baseName)) { skipped++; continue; }

  let target = path.join(dir, sanitize(rec.payer) + ".pdf");
  if (target === rec.pdf) { skipped++; continue; }
  // 处理重名
  let n = 2;
  while (fs.existsSync(target)) {
    target = path.join(dir, sanitize(rec.payer) + `(${n}).pdf`);
    n++;
    if (n > 99) break;
  }
  try {
    fs.renameSync(rec.pdf, target);
    console.log("[rename] " + path.basename(rec.pdf) + " -> " + path.basename(target));
    renamed++;
  } catch (e) {
    console.error("[fail] " + path.basename(rec.pdf) + ": " + e.message);
    failed++;
  }
}

console.log(`\nDone. renamed=${renamed} skipped=${skipped} missing=${missing} failed=${failed}`);
