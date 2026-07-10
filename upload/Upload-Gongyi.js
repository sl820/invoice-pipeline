#!/usr/bin/env node
/*
 * Upload-Gongyi.js
 * 阿里公益平台发票上传（Step 5 of invoice-pipeline）
 *
 * 流程：对 SourceDir 下每个 {交款人}.pdf
 *   1. 推断 payer（从文件名 {票号}_{公司} 或 {公司}）
 *   2. 平台搜索: 填开票抬头={payer} + 查询
 *   3. 筛选 "待开具" 状态
 *   4. 匹配规则：
 *        0 条待开具   -> 跳过（已开具或不在平台）
 *        1 条待开具   -> 真匹配，自动上传
 *        N>=2 条待开具 -> 跳过，进 failed（让用户人工）
 *   5. 点"立即开票" → 弹框 → setInputFiles → 点确 定（--yes 时）
 *   6. 记录到 uploaded-state.json
 *
 * 用法：
 *   node Upload-Gongyi.js --source-dir "E:\阿里发票\阿里257张" [--dry-run] [--limit 5] [--yes]
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

// ---------- 配置 ----------
const PLATFORM_URL = "https://open.alibabafoundation.com/open/workbench/employee/org/donation/invoice/manage";
const CDP_URL = "http://127.0.0.1:9222";
const STATE_FILE = path.join(__dirname, "uploaded-state.json");
const FAILED_DIR = path.join(__dirname, "..", "out", "failed");
const REPORT_DIR = path.join(__dirname, "..", "out", "reports");

const RETRY_MAX = 2;
const RETRY_BACKOFF_MS = [2000, 5000];
const TARGET_STATE = "待开具"; // 只处理这个状态

// ---------- CLI 解析 ----------
function parseArgs() {
  const args = { sourceDir: null, dryRun: false, limit: Infinity, yes: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source-dir") args.sourceDir = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--limit") args.limit = parseInt(argv[++i], 10);
    else if (a === "--yes") args.yes = true;
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node Upload-Gongyi.js --source-dir <path> [--dry-run] [--limit N] [--yes]");
      process.exit(0);
    }
  }
  if (!args.sourceDir) { console.error("ERROR: --source-dir required"); process.exit(2); }
  return args;
}

// ---------- payer 推断 ----------
function inferPayer(basename) {
  const idx = basename.indexOf("_");
  if (idx > 0) {
    const prefix = basename.substring(0, idx);
    if (/^\d{10,}$/.test(prefix)) {
      return basename.substring(idx + 1).replace(/\.pdf$/i, "");
    }
  }
  return basename.replace(/\.pdf$/i, "");
}

// ---------- 状态 ----------
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return {}; }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}
function fileHash(p) {
  const stat = fs.statSync(p);
  return `${stat.size}-${Math.floor(stat.mtimeMs)}`;
}
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function logFailure(basename, reason, detail) {
  ensureDir(FAILED_DIR);
  const file = path.join(FAILED_DIR, `upload-${basename}.log`);
  const content = [
    new Date().toISOString(),
    `reason: ${reason}`,
    detail || "",
  ].join("\n");
  fs.writeFileSync(file, content + "\n", "utf8");
}

// ---------- 单条处理 ----------
async function processOne(page, pdfPath, opts) {
  const basename = path.basename(pdfPath);
  const payer = inferPayer(basename);
  if (!payer) throw new Error("payer-empty: 文件名无法推断抬头");

  // 1. 重置 + 搜索
  const resetBtn = page.locator("button:has-text('重 置')");
  if (await resetBtn.count() > 0) {
    await resetBtn.click();
    await page.waitForTimeout(500);
  }
  await page.locator("input#control-hooks_invoiceTitle").fill(payer);
  await page.locator("button:has-text('查 询')").click();
  await page.waitForTimeout(2500);

  // 2. 抓所有行 + 状态
  const allRows = page.locator("table tbody tr.ant-table-row");
  const allCount = await allRows.count();

  if (allCount === 0) {
    throw new Error(`match-not-found: 平台无抬头="${payer}"的记录`);
  }

  // 3. 只筛"待开具"
  const rowData = await allRows.evaluateAll((els) =>
    els.map((r, i) => {
      const cells = Array.from(r.querySelectorAll("td"));
      // 状态在第 10 列（从 0 计），第 8 列是金额
      const get = (n) => cells[n] ? cells[n].innerText.trim() : "";
      return {
        rowIdx: i,
        seq: get(1),
        applicationId: get(2),
        payer: get(3),
        creditCode: get(4),
        months: get(5),
        invoiceType: get(6),
        amount: get(7),
        state: get(9),
        shop: get(10),
      };
    })
  );

  const pending = rowData.filter((r) => r.state === TARGET_STATE);

  if (pending.length === 0) {
    const stateList = rowData.map((r) => `${r.state}(${r.amount}元 ${r.months} ${r.shop})`).join("; ");
    throw new Error(
      `no-pending: 平台找到 ${allCount} 条记录，但全部不是"${TARGET_STATE}"状态。` +
      `现有状态: ${stateList}`
    );
  }

  if (pending.length > 1) {
    const lines = pending.map((r) =>
      `  [${r.seq}] ${r.months} 金额=${r.amount} 店铺=${r.shop} 申请ID=${r.applicationId}`
    ).join("\n");
    throw new Error(
      `match-multiple: "${payer}"有 ${pending.length} 条"${TARGET_STATE}"申请，无法自动选择。\n` +
      `请人工确认哪一条对应本 PDF (${basename})，或修改 PDF 文件名包含店铺信息。\n候选:\n${lines}`
    );
  }

  const target = pending[0];
  console.log(`  [match] seq=${target.seq} 申请ID=${target.applicationId} 金额=${target.amount} 店铺=${target.shop}`);

  // 4. 点立即开票
  const acceptBtn = allRows.nth(target.rowIdx).locator("button:has(span:text-is('立即开票'))");
  await acceptBtn.click();
  await page.waitForTimeout(2000);

  // 5. 等弹框
  const modal = page.locator(".ant-modal");
  if (await modal.count() === 0) {
    throw new Error("modal-not-shown: 点击立即开票后弹框未出现");
  }

  const modalInfo = await modal.first().evaluate((m) =>
    m.innerText.replace(/\s+/g, " ").slice(0, 200)
  );

  // 6. 上传
  const fileInput = modal.locator("input[type=file]");
  await fileInput.setInputFiles(pdfPath);
  await page.waitForTimeout(2000);

  const uploadedItem = modal.locator(".ant-upload-list-item");
  if (await uploadedItem.count() === 0) {
    throw new Error("upload-failed: .ant-upload-list-item 未出现");
  }
  const uploadedName = (await uploadedItem.first().innerText()).trim();

  // 7. 决定是否点确 定
  if (!opts.yes) {
    console.log(`  [dry-run] 弹框已就绪，PDF=${basename}`);
    const cancelBtn = modal.locator(".ant-btn:has-text('取 消')");
    if (await cancelBtn.count() > 0) {
      await cancelBtn.click();
      await page.waitForTimeout(1000);
    }
    return { dryRun: true, uploadedName, target };
  }

  // 真提交
  const confirmBtn = modal.locator(".ant-btn-primary:has-text('确 定')");
  await confirmBtn.click();
  await page.waitForSelector(".ant-modal", { state: "detached", timeout: 15000 });
  await page.waitForTimeout(1500);
  return { submitted: true, uploadedName, target };
}

// ---------- 主流程 ----------
async function main() {
  const args = parseArgs();
  const sourceDir = args.sourceDir;
  if (!fs.existsSync(sourceDir)) {
    console.error(`ERROR: source dir not found: ${sourceDir}`);
    process.exit(2);
  }

  const allPdfs = fs
    .readdirSync(sourceDir)
    .filter((n) => n.toLowerCase().endsWith(".pdf"))
    .map((n) => path.join(sourceDir, n));

  const state = loadState();
  const todo = allPdfs.filter((p) => {
    const h = fileHash(p);
    return !state[path.basename(p)] || state[path.basename(p)].hash !== h;
  });

  console.log(`[scan] total=${allPdfs.length} todo=${todo.length} already_uploaded=${allPdfs.length - todo.length}`);
  console.log(`[mode] ${args.yes ? "--yes: 真点确 定提交" : "dry-run: 走完到 setInputFiles 后取消"}`);

  if (todo.length === 0) { console.log("[done] 没有待上传文件"); return; }

  console.log(`[cdp] connecting to ${CDP_URL} ...`);
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (e) {
    console.error(`ERROR: 无法连接 Chrome CDP: ${e.message}`);
    console.error("请先运行 scripts/Start-Chrome-CDP.ps1");
    process.exit(1);
  }

  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];

  console.log(`[nav] -> ${PLATFORM_URL}`);
  await page.goto(PLATFORM_URL, { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForTimeout(1500);

  let ok = 0, fail = 0, skipped = 0;
  const limit = Math.min(args.limit, todo.length);
  for (let i = 0; i < limit; i++) {
    const pdf = todo[i];
    const basename = path.basename(pdf);
    console.log(`[${i + 1}/${limit}] ${basename}  payer="${inferPayer(basename)}"`);

    let didProcess = false;
    for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
      try {
        const result = await processOne(page, pdf, args);
        if (result.submitted) {
          state[basename] = {
            hash: fileHash(pdf),
            uploadedAt: new Date().toISOString(),
            uploadedName: result.uploadedName,
            target: result.target,
            size: fs.statSync(pdf).size,
          };
          saveState(state);
          console.log(`  [ok] submitted`);
          ok++;
        } else if (result.dryRun) {
          console.log(`  [ok] dry-run passed`);
          ok++;
        }
        didProcess = true;
        break;
      } catch (err) {
        if (attempt >= RETRY_MAX) {
          const firstLine = err.message.split("\n")[0];
          if (firstLine.startsWith("match-not-found") ||
              firstLine.startsWith("no-pending") ||
              firstLine.startsWith("match-multiple")) {
            // 这三类是"无匹配"而不是错误，记 skipped
            console.log(`  [skip] ${firstLine.split(":")[0]}`);
            logFailure(basename, firstLine, err.message);
            skipped++;
          } else {
            console.error(`  [fail] ${firstLine}`);
            logFailure(basename, "error", err.message);
            fail++;
          }
        } else {
          const backoff = RETRY_BACKOFF_MS[attempt - 1];
          console.error(`  [retry ${attempt}/${RETRY_MAX}] ${err.message.split("\n")[0]} (wait ${backoff}ms)`);
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }
    if (!didProcess && !skipped && !fail) {
      // should not reach
    }
  }

  ensureDir(REPORT_DIR);
  const reportFile = path.join(REPORT_DIR, `upload-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`);
  const report = [
    `mode=${args.yes ? "submit" : "dry-run"}`,
    `source=${sourceDir}`,
    `total=${allPdfs.length}`,
    `todo=${todo.length}`,
    `ok=${ok}`,
    `skipped=${skipped}`,
    `failed=${fail}`,
  ].join("\n");
  fs.writeFileSync(reportFile, report + "\n", "utf8");

  console.log("");
  console.log(`[done] ok=${ok} skipped=${skipped} failed=${fail}`);
  console.log(`[report] -> ${reportFile}`);

  await browser.close().catch(() => {});
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });