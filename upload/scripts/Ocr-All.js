#!/usr/bin/env node
// Ocr-All.js - full-set OCR, bypass PS 5.1 Chinese-path pitfalls
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");


function findBl() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const npmBl = home + "\\AppData\\Roaming\\npm\\bl.cmd";
  try { const fsx = require("fs"); if (fsx.existsSync(npmBl)) return npmBl; } catch {}
  return "bl";
}
const BL = findBl();
function runBl(args, opts) {
  // Use cmd /c to invoke .cmd shims on Windows (Node 24 spawnSync EINVAL otherwise)
  return spawnSync("cmd", ["/c", BL].concat(args), opts || {});
}



const ROOT = path.resolve(__dirname, "..", "..");
const PDFTOPPM = "C:\\Users\\hbusl\\AppData\\Local\\Microsoft\\WinGet\\Packages\\oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe\\poppler-25.07.0\\Library\\bin\\pdftoppm.exe";
const PROMPT_FILE = path.join(ROOT, "prompts", "extract-payer.md");
const PARSER = path.join(ROOT, "upload", "Ocr-Parse.js");

function arg(n, d) { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; }

const SOURCE_DIR = arg("--source-dir", "E:\\阿里发票\\阿里257张");
const CONCURRENCY = parseInt(arg("--concurrency", "3"), 10);
const MODEL = arg("--model", "qwen3-vl-plus");
const DPI = parseInt(arg("--dpi", "200"), 10);
const LIMIT = parseInt(arg("--limit", "0"), 10);
const PROBE = process.argv.includes("--probe");
const ALLOW_BARE = process.argv.includes("--allow-bare-invoice");

const CACHE_DIR = path.join(SOURCE_DIR, ".ocr-cache");
const OUT_DIR = path.join(SOURCE_DIR, "mapping-runs");
const FAILED_DIR = path.join(ROOT, "out", "failed");

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function log() { const a = Array.from(arguments); console.log("[" + new Date().toISOString().slice(11, 19) + "]", ...a); }

function listPdfs(dir) {
  return fs.readdirSync(dir).filter(function (n) { return n.toLowerCase().endsWith(".pdf"); })
    .filter(function (n) {
      const b = path.basename(n, ".pdf");
      const i = b.indexOf("_");
      if (i > 0) {
        return /^\d{10,}$/.test(b.substring(0, i));
      }
      return ALLOW_BARE && /^\d{10,}$/.test(b);
    })
    .map(function (n) { return path.join(dir, n); });
}

// 智能选择 ground truth payer
// 优先级: 看着像公司/小店/自然人都接受 → 用 OCR；否则用文件名
function selectPayer(ocrPayer, filenameCompany) {
  const co = (ocrPayer || "").trim();
  // 必须有内容，长度 2-40
  if (co.length < 2 || co.length > 40) return { payer: filenameCompany, source: "filename" };
  // 不能是噪音标签
  const NOISE = new Set(["交款人", "名称", "购买方", "抬头", "购买方信息", "交款人信息", "收据", "凭证", "统一社会信用代码", "纳税人识别号"]);
  if (NOISE.has(co) || /^(交款人|名称|购买方|抬头|[:：\s])+$/.test(co)) return { payer: filenameCompany, source: "filename" };
  // 自然人姓名：2-4 个汉字（不含标点、数字）
  const isNaturalPerson = /^[\u4e00-\u9fa5]{2,4}$/.test(co);
  // 公司/小店/个体户
  const hasCoSuffix = /(有限公司|有限责任公司|股份有限公司|经营部|商行|商店|门市部|超市|便利店|百货|商行|店|号|厂|工作室|个体工商户|集团|事务所|中心|合作社|经营处|经销处|经营店|销售部|商场|商城|市场|批发部|供应站|服务部)/.test(co);
  // 不含明显无关内容（如带斜杠、空格式等）
  const looksValid = !/[\u0000-\u001f]/.test(co);
  if ((isNaturalPerson || hasCoSuffix) && looksValid) return { payer: co, source: "ocr" };
  return { payer: filenameCompany, source: "filename" };
}

async function blDescribe(img) {
  const prompt = fs.readFileSync(PROMPT_FILE, "utf8");
  const r = runBl( ["vision", "describe", "--image", img, "--prompt", prompt, "--model", MODEL, "--output", "json"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error("bl exit=" + r.status + " stderr=" + (r.stderr || "").slice(0, 300));
  return r.stdout;
}

function pdftoppm(p, png) {
  const r = spawnSync(PDFTOPPM, ["-r", String(DPI), "-png", "-singlefile", "-f", "1", "-l", "1", p, png], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("pdftoppm exit=" + r.status + " stderr=" + (r.stderr || "").slice(0, 300));
}

function nodeParse(o) {
  const r = spawnSync(process.execPath, [PARSER, o], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("parser exit=" + r.status + " stderr=" + (r.stderr || "").slice(0, 300));
  return JSON.parse(r.stdout);
}

async function processOne(pdf) {
  const base = path.basename(pdf, ".pdf");
  const uscore = base.indexOf("_");
  const company = uscore > 0 ? base.substring(uscore + 1) : "";
  const pngBase = path.join(CACHE_DIR, base + "-p1");
  const pngFile = pngBase + ".png";
  const ocrTxt = path.join(CACHE_DIR, base + "-ocr.txt");
  const t0 = Date.now();
  let err = "";
  let payer = "", ocrPayer = "", amount = "", invoiceDate = "", method = "bl-vision-describe";
  try {
    if (!fs.existsSync(pngFile)) pdftoppm(pdf, pngBase);
    if (!fs.existsSync(pngFile)) throw new Error("png not generated");
    if (!fs.existsSync(ocrTxt)) {
      const out = await blDescribe(pngFile);
      fs.writeFileSync(ocrTxt, out, "utf8");
    }
    const parsed = nodeParse(ocrTxt);
    ocrPayer = parsed.payer || "";
    amount = parsed.amount || "";
    invoiceDate = parsed.invoiceDate || "";
    if (!amount) throw new Error("amount-empty");
    const sel = selectPayer(ocrPayer, company);
    payer = sel.payer;
    method = "payer=" + sel.source + "+bl-vision-describe";
  } catch (e) { err = e.message; }
  return {
    pdf: pdf, payer: payer, ocrPayer: ocrPayer, amount: amount, invoiceDate: invoiceDate,
    method: method, model: MODEL, dpi: DPI,
    elapsedMs: Date.now() - t0, error: err
  };
}

async function runPool(items, c, w) {
  const results = new Array(items.length);
  let idx = 0, done = 0, fail = 0;
  async function tick() {
    while (idx < items.length) {
      const my = idx++;
      try { results[my] = await w(items[my]); done++; }
      catch (e) { results[my] = { pdf: items[my], payer: "", error: "fatal:" + e.message, elapsedMs: 0 }; done++; fail++; }
      if (done % 20 === 0) log("progress " + done + "/" + items.length + " failed=" + fail);
    }
  }
  const ws = Array.from({ length: c }, tick);
  await Promise.all(ws);
  return results;
}

async function main() {
  ensureDir(CACHE_DIR); ensureDir(OUT_DIR); ensureDir(FAILED_DIR);
  if (!fs.existsSync(SOURCE_DIR)) { console.error("source dir not found:", SOURCE_DIR); process.exit(2); }
  if (!fs.existsSync(PROMPT_FILE)) { console.error("prompt missing:", PROMPT_FILE); process.exit(2); }
  if (!fs.existsSync(PARSER)) { console.error("parser missing:", PARSER); process.exit(2); }
  if (!fs.existsSync(PDFTOPPM)) { console.error("pdftoppm missing:", PDFTOPPM); process.exit(2); }

  const r = runBl(["--version"], { encoding: "utf8" });
  if (r.status !== 0) { console.error("bl CLI not working, status=" + r.status + " stderr=" + (r.stderr||"").slice(0,200)); process.exit(2); }

  let pdfs = listPdfs(SOURCE_DIR);
  if (PROBE) pdfs = pdfs.slice(0, 10);
  else if (LIMIT > 0) pdfs = pdfs.slice(0, LIMIT);
  log("source=" + SOURCE_DIR);
  log("pdfs=" + pdfs.length + " concurrency=" + CONCURRENCY + " model=" + MODEL + " dpi=" + DPI);
  if (PROBE) log("PROBE MODE: first 10 only");

  const t0 = Date.now();
  const results = await runPool(pdfs, CONCURRENCY, processOne);

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outFile = path.join(OUT_DIR, "mapping-" + ts + ".json");
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2), "utf8");

  const ok = results.filter(function (r) { return r.payer && r.amount && !r.error; }).length;
  const fail = results.filter(function (r) { return r.error; }).length;
  log("done in " + ((Date.now() - t0) / 1000).toFixed(1) + "s ok=" + ok + " failed=" + fail);
  log("-> " + outFile);
}

main().catch(function (e) { console.error("FATAL:", e); process.exit(1); });