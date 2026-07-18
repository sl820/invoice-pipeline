#!/usr/bin/env node
/*
 * Upload-Gongyi.js
 * 阿里公益平台发票上传（Step 5 of invoice-pipeline）
 *
 * 匹配规则（v2，含 amount 消歧）：
 *   1. 平台搜索"开票抬头"= payer
 *   2. 筛"待开具"状态
 *   3. 1 条        -> 自动上传
 *   4. 多条 + amount 不空 -> 按 amount 筛；筛后 1 条 -> 上传；筛后 0/N -> skip
 *   5. 多条 + amount 空   -> skip（让用户人工）
 *
 * payer / amount 来源：优先 mapping-{ts}.json，否则从 PDF 文件名 + 运行前 bl OCR
 *
 * 用法：
 *   node Upload-Gongyi.js --source-dir "E:\阿里发票\阿里257张" [--dry-run] [--limit 5] [--yes]
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const PLATFORM_URL = "https://open.alibabafoundation.com/open/workbench/employee/org/donation/invoice/manage";
const CDP_URL = "http://127.0.0.1:9222";
const STATE_FILE = path.join(__dirname, "uploaded-state.json");
const FAILED_DIR = path.join(__dirname, "..", "out", "failed");
const REPORT_DIR = path.join(__dirname, "..", "out", "reports");
const RETRY_MAX = 2;
const RETRY_BACKOFF_MS = [2000, 5000];
const TARGET_STATE = "待开具";

function parseArgs() {
  const args = { sourceDir: null, dryRun: false, limit: Infinity, yes: false, delayMs: 0, disambigIndex: 0 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source-dir") args.sourceDir = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--limit") args.limit = parseInt(argv[++i], 10);
    else if (a === "--yes") args.yes = true;
    else if (a === "--delay") args.delayMs = parseInt(argv[++i], 10);
    else if (a === "--disambig-index" || a === "--di") args.disambigIndex = parseInt(argv[++i], 10);
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node Upload-Gongyi.js --source-dir <path> [--dry-run] [--limit N] [--yes] [--delay 3000]");
      process.exit(0);
    }
  }
  if (!args.sourceDir) { console.error("ERROR: --source-dir required"); process.exit(2); }
  return args;
}

function inferPayer(basename) {
  const idx = basename.indexOf("_");
  if (idx > 0) {
    const prefix = basename.substring(0, idx);
    if (/^\d{10,}$/.test(prefix)) return basename.substring(idx + 1).replace(/\.pdf$/i, "");
  }
  return basename.replace(/\.pdf$/i, "");
}

function loadState() { if (!fs.existsSync(STATE_FILE)) return {}; try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; } }
function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), "utf8"); }
function fileHash(p) { const st = fs.statSync(p); return `${st.size}-${Math.floor(st.mtimeMs)}`; }
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function logFailure(basename, reason, detail) {
  ensureDir(FAILED_DIR);
  fs.writeFileSync(path.join(FAILED_DIR, `upload-${basename}.log`),
    `${new Date().toISOString()}\nreason: ${reason}\n${detail || ""}\n`, "utf8");
}

// 读 mapping-*.json 最新一份，构建 basename -> {payer, amount} 索引
function loadMapping(sourceDir) {
  let candidates = fs.readdirSync(sourceDir).filter(n => /^mapping-.*\.json$/.test(n));
  if (candidates.length === 0) {
    const sub = path.join(sourceDir, 'mapping-runs');
    if (fs.existsSync(sub)) {
      candidates = fs.readdirSync(sub).filter(n => /^mapping-.*\.json$/.test(n)).map(n => path.join('mapping-runs', n));
    }
  }
  if (candidates.length === 0) return null;
  const latest = candidates.sort().pop();
  const raw = fs.readFileSync(path.join(sourceDir, latest), 'utf8');
  try { return JSON.parse(raw); } catch { return null; }
}

function lookupInMapping(records, pdfPath) {
  if (!records) return null;
  const base = path.basename(pdfPath, ".pdf");
  // mapping 里的 pdf 字段是绝对路径，basename 可能不同（rename 后），
  // 兜底：取 pdf 的 basename 不含扩展名，再跟原 mapping 比
  // 简化：按文件大小+mtime 匹配
  const st = fs.statSync(pdfPath);
  for (const r of records) {
    if (!r.pdf) continue;
    try {
      const rPath = r.pdf;
      if (fs.existsSync(rPath)) {
        const rst = fs.statSync(rPath);
        if (rst.size === st.size && Math.abs(rst.mtimeMs - st.mtimeMs) < 1000) {
          return { payer: r.payer || "", amount: r.amount || "" };
        }
      }
    } catch {}
    // 兜底：如果 r.pdf 的 basename 是纯票号 (110501260003695195)，那跟我们的 {票号}_{公司} 匹配
    const rBase = path.basename(r.pdf || "", ".pdf");
    if (rBase === base.split("_")[0]) {
      return { payer: r.payer || "", amount: r.amount || "" };
    }
    // 兜底: PDF 已重命名为 {payer}.pdf，按 payer 反查
    if (r.payer && (base === r.payer || base === r.payer + "(2)" || base === r.payer + "(3)")) {
      return { payer: r.payer || "", amount: r.amount || "" };
    }
  }
  return null;
}

async function processOne(page, pdfPath, opts, payerHint, amountHint, usedKeys) {
  const basename = path.basename(pdfPath);
  // 1. 推断 payer
  const payer = payerHint || inferPayer(basename);
  if (!payer) throw new Error("payer-empty");

  // 2. 平台搜索
  const resetBtn = page.locator("button:has-text('重 置')");
  if (await resetBtn.count() > 0) { await resetBtn.click(); await page.waitForTimeout(500); }
  await page.locator("input#control-hooks_invoiceTitle").fill(payer);
  await page.locator("button:has-text('查 询')").click();
  await page.waitForTimeout(2500);

  // 3. 抓所有行 + 状态 + 金额
  const allRows = page.locator("table tbody tr.ant-table-row");
  const allCount = await allRows.count();
  if (allCount === 0) throw new Error(`match-not-found: 平台无抬头="${payer}"的记录`);

  const rowData = await allRows.evaluateAll((els) =>
    els.map((r, i) => {
      const cells = Array.from(r.querySelectorAll("td"));
      const get = (n) => cells[n] ? cells[n].innerText.trim() : "";
      return {
        rowIdx: i, seq: get(1), applicationId: get(2), payer: get(3),
        creditCode: get(4), months: get(5), invoiceType: get(6),
        amount: get(7), state: get(9), shop: get(10),
      };
    })
  );
  const allPending = rowData.filter(r => r.state === TARGET_STATE);
  const usedHere = allPending.filter(r => usedKeys && usedKeys.has(r.applicationId));
  const pending = allPending.filter(r => !usedKeys || !usedKeys.has(r.applicationId));

  if (pending.length === 0) {
    const stateList = rowData.map(r => `${r.state}(${r.amount}元 ${r.shop})`).join("; ");
    throw new Error(`no-pending: 平台找到 ${allCount} 条记录但无"${TARGET_STATE}"。现有: ${stateList}`);
  }

  // 4. 消歧：多条 + 有 amount -> 按 amount 筛
  let target;
  if (pending.length === 1) {
    target = pending[0];
  } else if (amountHint) {
    // 规范化金额比较（去前导零等）
    const norm = (s) => s.replace(/[¥￥,\s]/g, "").replace(/^0+/, "").trim();
    const want = norm(amountHint);
    const matched = pending.filter(r => norm(r.amount) === want);
    if (matched.length === 1) {
      console.log(`  [ambig] ${allPending.length} 条待开具（已用 ${usedHere.length} → ${pending.length} 候选），amount="${amountHint}" 唯一匹配 1 条`);
      target = matched[0];
    } else if (matched.length === 0) {
      const lines = pending.map(r => `  [${r.seq}] 金额=${r.amount} 店铺=${r.shop} 月份=${r.months}`).join("\n");
      throw new Error(`amount-no-match: ${pending.length} 条待开具但无一条 amount="${amountHint}" 对得上。\
候选:\n${lines}\n建议: 检查 OCR 金额是否正确，或 1 个 payer 多 row 时按月/店铺人工拆分`);
    } else {
      const lines = matched.map(r => `  [${r.seq}] 金额=${r.amount} 店铺=${r.shop}`).join("\n");
      const sortedBySeq = [...matched].sort((a, b) => parseInt(a.seq || 0, 10) - parseInt(b.seq || 0, 10));
      const idx = Math.min((opts.disambigIndex || 0), sortedBySeq.length - 1);
      const pick = sortedBySeq[idx];
      console.log(`  [ambig] amount="${amountHint}" 匹配 ${matched.length} 条，按 seq 升序取第 ${idx + 1}/${sortedBySeq.length} (seq=${pick.seq} ${pick.shop} ${pick.months})`);
      target = pick;
    }
  } else {
    const lines = pending.map(r => `  [${r.seq}] 金额=${r.amount} 店铺=${r.shop} 月份=${r.months}`).join("\n");
    const sortedBySeq = [...pending].sort((a, b) => parseInt(a.seq || 0, 10) - parseInt(b.seq || 0, 10));
    const idx = Math.min((opts.disambigIndex || 0), sortedBySeq.length - 1);
    const pick = sortedBySeq[idx];
    console.log(`  [ambig] "${payer}" 有 ${pending.length} 条待开具，无 amount；按 seq 升序取第 ${idx + 1}/${sortedBySeq.length} (seq=${pick.seq} ${pick.shop} ${pick.months} amount=${pick.amount})`);
    target = pick;
  }

  console.log(`  [match] seq=${target.seq} 申请ID=${target.applicationId} 金额=${target.amount} 店铺=${target.shop}`);

  // 5. 点立即开票
  await allRows.nth(target.rowIdx).locator("button:has(span:text-is('立即开票'))").click();
  await page.waitForTimeout(2000);

  const modal = page.locator(".ant-modal");
  if (await modal.count() === 0) throw new Error("modal-not-shown");
  const modalInfo = await modal.first().evaluate(m => m.innerText.replace(/\s+/g, " ").slice(0, 200));

  // 6. 上传
  await modal.locator("input[type=file]").setInputFiles(pdfPath);
  await page.waitForTimeout(2000);
  const uploadedItem = modal.locator(".ant-upload-list-item");
  if (await uploadedItem.count() === 0) throw new Error("upload-failed: .ant-upload-list-item 未出现");
  const uploadedName = (await uploadedItem.first().innerText()).trim();

  // 7. 决定提交
  if (!opts.yes) {
    console.log(`  [dry-run] 弹框已就绪，PDF=${basename}`);
    const cancelBtn = modal.locator(".ant-btn:has-text('取 消')");
    if (await cancelBtn.count() > 0) { await cancelBtn.click(); await page.waitForTimeout(1000); }
    return { dryRun: true, uploadedName, target };
  }
  // Click 主弹框 确 定
  await modal.locator(".ant-btn-primary:has-text('确 定')").click();
  // 平台会再弹一个二级确认弹框: "确定要提交票据？"
  await page.waitForTimeout(1500);
  // 抓最外层 ant-modal-wrap 或多个 .ant-modal 都点一下 确 定
  for (const m of await page.locator(".ant-modal").all()) {
    const btn = m.locator(".ant-btn-primary:has-text('确 定')");
    if (await btn.count() > 0) { try { await btn.first().click({ timeout: 5000 }); } catch {} }
  }
  try { await page.waitForSelector(".ant-modal", { state: "detached", timeout: 30000 }); }
  catch (e) { console.log("  [warn] modal detach wait timed out (may still have succeeded)"); }
  await page.waitForTimeout(2000);
  return { submitted: true, uploadedName, target };
}

async function main() {
  const args = parseArgs();
  const sourceDir = args.sourceDir;
  if (!fs.existsSync(sourceDir)) { console.error(`ERROR: source dir not found: ${sourceDir}`); process.exit(2); }

  const allPdfs = fs.readdirSync(sourceDir).filter(n => n.toLowerCase().endsWith(".pdf")).map(n => path.join(sourceDir, n));
  const state = loadState();
  const todo = allPdfs.filter(p => {
    const h = fileHash(p);
    return !state[path.basename(p)] || state[path.basename(p)].hash !== h;
  });

  // 加载 mapping 索引
  const mapping = loadMapping(sourceDir);
  const mappingHasAmount = mapping && mapping.length > 0 && mapping[0].amount !== undefined;
  console.log(`[scan] total=${allPdfs.length} todo=${todo.length} already_uploaded=${allPdfs.length - todo.length}`);
  console.log(`[mapping] ${mapping ? (mappingHasAmount ? "有 amount 字段" : "无 amount 字段") : "无 mapping"}`);
  console.log(`[mode] ${args.yes ? "--yes: 真点确 定" : "dry-run: 走完到 setInputFiles 后取消"}`);

  if (todo.length === 0) { console.log("[done] 没有待上传文件"); return; }

  console.log(`[cdp] connecting to ${CDP_URL} ...`);
  let browser;
  try { browser = await chromium.connectOverCDP(CDP_URL); }
  catch (e) { console.error(`ERROR: CDP 无法连接: ${e.message}`); console.error("请先运行 scripts/Start-Chrome-CDP.ps1"); process.exit(1); }

  const ctx = browser.contexts()[0];

  // 每次上传后用 fresh page 避免 page 引用失效
  async function freshPage() {
    let page = ctx.pages().find(p => {
      if (p.isClosed()) return false;
      const u = (() => { try { return p.url(); } catch { return ""; } })();
      return u.includes("alibabafoundation") || u.includes("open.workbench");
    });
    if (!page) {
      page = await ctx.newPage();
    }
    try { await page.goto(PLATFORM_URL, { waitUntil: "domcontentloaded", timeout: 30000 }); } catch (e) {
      console.log("  [warn] goto failed, open newPage");
      try { page = await ctx.newPage(); await page.goto(PLATFORM_URL, { waitUntil: "domcontentloaded", timeout: 30000 }); } catch (e2) {}
    }
    await page.waitForSelector("#control-hooks_invoiceTitle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
    return page;
  }

  let page = await freshPage();
  console.log(`[nav] -> ${PLATFORM_URL}`);

  let ok = 0, fail = 0, skipped = 0;
  // 跨 PDF 跟踪已被本次 run 用掉的 row.applicationId（同公司多张发票用）
  const usedKeys = new Set();
  const limit = Math.min(args.limit, todo.length);
  for (let i = 0; i < limit; i++) {
    if (args.delayMs > 0) { console.log(`  [delay] ${args.delayMs}ms ...`); await new Promise(r => setTimeout(r, args.delayMs)); }
    const pdf = todo[i];
    const basename = path.basename(pdf);
    const fromMapping = lookupInMapping(mapping, pdf);
    const payerHint = fromMapping?.payer || "";
    const amountHint = fromMapping?.amount || "";
    console.log(`[${i + 1}/${limit}] ${basename}  payer="${payerHint || inferPayer(basename)}" amount="${amountHint}"`);

    for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
      try {
        const result = await processOne(page, pdf, args, payerHint, amountHint, usedKeys);
        if (result.submitted) {
          state[basename] = { hash: fileHash(pdf), uploadedAt: new Date().toISOString(), uploadedName: result.uploadedName, target: result.target, size: fs.statSync(pdf).size };
          if (result.target && result.target.applicationId) usedKeys.add(result.target.applicationId);
          saveState(state);
          console.log(`  [ok] submitted`);
          ok++;
          try { page = await freshPage(); } catch (e) {}
        } else if (result.dryRun) {
          console.log(`  [ok] dry-run passed`);
          ok++;
          try { page = await freshPage(); } catch (e) {}
        }
        break;
      } catch (err) {
        if (attempt >= RETRY_MAX) {
          const firstLine = err.message.split("\n")[0];
          if (firstLine.startsWith("match-not-found") || firstLine.startsWith("no-pending") ||
              firstLine.startsWith("match-multiple") || firstLine.startsWith("amount-")) {
            console.log(`  [skip] ${firstLine.split(":")[0]}`);
            logFailure(basename, firstLine, err.message);
            skipped++;
          } else {
            console.error(`  [fail] ${firstLine}`);
            logFailure(basename, "error", err.message);
            fail++;
            try { page = await freshPage(); } catch (e) {}
          }
        } else {
          const backoff = RETRY_BACKOFF_MS[attempt - 1];
          console.error(`  [retry ${attempt}/${RETRY_MAX}] ${err.message.split("\n")[0]} (wait ${backoff}ms)`);
          await new Promise(r => setTimeout(r, backoff));
          try { page = await freshPage(); } catch (e) {}
        }
      }
    }
  }

  ensureDir(REPORT_DIR);
  const reportFile = path.join(REPORT_DIR, `upload-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`);
  fs.writeFileSync(reportFile, [
    `mode=${args.yes ? "submit" : "dry-run"}`,
    `source=${sourceDir}`,
    `mappingHasAmount=${mappingHasAmount}`,
    `total=${allPdfs.length}`,
    `todo=${todo.length}`,
    `ok=${ok}`,
    `skipped=${skipped}`,
    `failed=${fail}`,
  ].join("\n") + "\n", "utf8");

  console.log("");
  console.log(`[done] ok=${ok} skipped=${skipped} failed=${fail}`);
  console.log(`[report] -> ${reportFile}`);

  await browser.close().catch(() => {});
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });