#!/usr/bin/env node
// Ocr-ParseCache.js
// 从已缓存的 OCR 文本生成 mapping（无需重新调 bl）
// 用法: node Ocr-ParseCache.js --source-dir <dir> [--use-filename-payer]
const fs = require("fs");
const path = require("path");

function arg(n, d) { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; }
const SOURCE_DIR = arg("--source-dir", "");
if (!SOURCE_DIR) { console.error("Usage: node Ocr-ParseCache.js --source-dir <dir>"); process.exit(2); }
const PARSER = arg("--parser", path.resolve(__dirname, "..", "Ocr-Parse.js"));
const OUT_DIR = path.join(SOURCE_DIR, "mapping-runs");
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const { spawnSync } = require("child_process");

function listCached(dir) {
  const cache = path.join(dir, ".ocr-cache");
  if (!fs.existsSync(cache)) return [];
  return fs.readdirSync(cache)
    .filter(n => n.endsWith("-ocr.txt"))
    .map(n => n.replace(/-ocr\.txt$/, ""));
}

function selectPayer(ocrPayer, filenameCompany) {
  const co = (ocrPayer || "").trim();
  if (co.length < 2 || co.length > 40) return { payer: filenameCompany, source: "filename" };
  const NOISE = new Set(["交款人", "名称", "购买方", "抬头", "购买方信息", "交款人信息", "收据", "凭证", "统一社会信用代码", "纳税人识别号"]);
  if (NOISE.has(co) || /^(交款人|名称|购买方|抬头|[:：\s])+$/.test(co)) return { payer: filenameCompany, source: "filename" };
  const isNaturalPerson = /^[一-龥]{2,4}$/.test(co);
  const hasCoSuffix = /(有限公司|有限责任公司|股份有限公司|经营部|商行|商店|门市部|超市|便利店|百货|店|号|厂|工作室|个体工商户|集团|事务所|中心|合作社|经营处|经销处|经营店|销售部|商场|商城|市场|批发部|供应站|服务部)/.test(co);
  if (isNaturalPerson || hasCoSuffix) return { payer: co, source: "ocr" };
  return { payer: filenameCompany, source: "filename" };
}

const cached = listCached(SOURCE_DIR);
console.log("cached=" + cached.length);

const results = [];
for (const base of cached) {
  const ocrTxt = path.join(SOURCE_DIR, ".ocr-cache", base + "-ocr.txt");
  const r = spawnSync(process.execPath, [PARSER, ocrTxt], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    console.error("parser fail:", base, "stderr=" + (r.stderr || "").slice(0, 200), "stdout=" + (r.stdout || "").slice(0, 200));
    continue;
  }
  let parsed;
  try { parsed = JSON.parse(r.stdout); } catch (e) { console.error("json fail:", base); continue; }
  const uscore = base.indexOf("_");
  const company = uscore > 0 ? base.substring(uscore + 1) : "";
  const sel = selectPayer(parsed.payer, company);
  results.push({
    pdf: path.join(SOURCE_DIR, base + ".pdf"),
    payer: sel.payer,
    ocrPayer: parsed.payer || "",
    amount: parsed.amount || "",
    invoiceDate: parsed.invoiceDate || "",
    method: "payer=" + sel.source + "+bl-vision-describe",
    model: "cached",
    dpi: 200,
    elapsedMs: 0,
    error: "",
  });
}

const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outFile = path.join(OUT_DIR, "mapping-cached-" + ts + ".json");
fs.writeFileSync(outFile, JSON.stringify(results, null, 2), "utf8");
const ok = results.filter(r => r.payer && r.amount).length;
console.log("done ok=" + ok + " failed=" + (results.length - ok));
console.log("-> " + outFile);
