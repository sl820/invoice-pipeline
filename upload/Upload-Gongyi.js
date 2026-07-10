#!/usr/bin/env node
/*
 * Upload-Gongyi.js
 * 阿里公益平台发票上传（Step 5 of invoice-pipeline）
 *
 * 使用前必读（IMPORTANT）：
 *  1. 必须先用 scripts/Start-Chrome-CDP.ps1 启动带 --remote-debugging-port=9222 的 Chrome
 *  2. Chrome 里必须已经登录 open.alibabafoundation.com（手动登录一次，cookie 落盘到 user-data-dir）
 *  3. 下方 TODO_SELECTOR_* 标记的选择器必须根据真实页面 DOM 填好，否则脚本会卡在 wait
 *  4. 用法：
 *       node Upload-Gongyi.js --source-dir "E:\阿里发票\阿里257张" [--dry-run] [--limit 5]
 *
 * 流程：
 *  1. 通过 CDP 接管 9222 端口的 Chrome
 *  2. 打开 open.alibabafoundation.com/index
 *  3. 检测登录态（未登录则中断）
 *  4. 遍历 --source-dir 下所有 *.pdf（已经是 {payer}.pdf 形式）
 *  5. 跳过 uploaded-state.json 里已记录的文件（幂等）
 *  6. 每个文件：点击"上传发票" → 选择文件 → 等待上传完成 → 记录成功
 *  7. 失败：写 out/failed/upload-<basename>.log，不删原文件
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

// ---------- 配置 ----------
const PLATFORM_URL = "https://open.alibabafoundation.com/index";
const CDP_URL = "http://127.0.0.1:9222";
const STATE_FILE = path.join(__dirname, "uploaded-state.json");
const FAILED_DIR = path.join(__dirname, "..", "out", "failed");
const REPORT_DIR = path.join(__dirname, "..", "out", "reports");

// TODO_SELECTOR_LOGIN_INDICATOR: 登录后页面才有的元素（用于判断登录态）
// 候选：avatar / 右上角用户名 / "我的" 等。找一个登录后才出现的稳定选择器
const TODO_SELECTOR_LOGIN_INDICATOR = 'TODO_SELECTOR_LOGIN_INDICATOR';

// TODO_SELECTOR_UPLOAD_BUTTON: 触发上传的入口按钮
// 例：page.getByRole('button', { name: '上传发票' }) 或 'text=申请开票'
const TODO_SELECTOR_UPLOAD_BUTTON = 'TODO_SELECTOR_UPLOAD_BUTTON';

// TODO_SELECTOR_FILE_INPUT: <input type="file"> 的 selector
// 通常隐藏，click upload 按钮后会触发。例 'input[type="file"]'
const TODO_SELECTOR_FILE_INPUT = 'TODO_SELECTOR_FILE_INPUT';

// TODO_SELECTOR_SUBMIT_BUTTON: 上传后是否需要点"提交/确认"按钮
// 如果上传即自动提交，置为 null
const TODO_SELECTOR_SUBMIT_BUTTON = 'TODO_SELECTOR_SUBMIT_BUTTON';

// TODO_SELECTOR_SUCCESS_INDICATOR: 上传成功的标志元素 / 文本
// 例：'text=上传成功' / 列表里多了一行
const TODO_SELECTOR_SUCCESS_INDICATOR = 'TODO_SELECTOR_SUCCESS_INDICATOR';

const RETRY_MAX = 3;
const RETRY_BACKOFF_MS = [2000, 5000, 15000]; // 指数退避

// ---------- CLI 解析 ----------
function parseArgs() {
  const args = {
    sourceDir: null,
    dryRun: false,
    limit: Infinity,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source-dir") args.sourceDir = argv[++i];
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--limit") args.limit = parseInt(argv[++i], 10);
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node Upload-Gongyi.js --source-dir <path> [--dry-run] [--limit N]");
      process.exit(0);
    }
  }
  if (!args.sourceDir) {
    console.error("ERROR: --source-dir required");
    process.exit(2);
  }
  return args;
}

// ---------- 已上传状态 ----------
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (e) {
    console.warn(`[warn] state file corrupt, starting fresh: ${e.message}`);
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function fileHash(p) {
  // 简单的 size+mtime hash，幂等去重足够
  const stat = fs.statSync(p);
  return `${stat.size}-${Math.floor(stat.mtimeMs)}`;
}

// ---------- 失败日志 ----------
function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function logFailure(basename, msg) {
  ensureDir(FAILED_DIR);
  const logFile = path.join(FAILED_DIR, `upload-${basename}.log`);
  fs.writeFileSync(logFile, `${new Date().toISOString()}\n${msg}\n`, "utf8");
}

// ---------- 单文件上传 ----------
async function uploadOne(page, pdfPath) {
  const basename = path.basename(pdfPath);

  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    try {
      // TODO: 实际点击"上传发票"入口
      //   if (TODO_SELECTOR_UPLOAD_BUTTON.startsWith('TODO_')) {
      //     throw new Error('selector not configured; see TODO_SELECTOR_UPLOAD_BUTTON');
      //   }
      //   await page.locator(TODO_SELECTOR_UPLOAD_BUTTON).click();
      //
      //   // 触发文件选择
      //   const fileInput = page.locator(TODO_SELECTOR_FILE_INPUT);
      //   await fileInput.setInputFiles(pdfPath);
      //
      //   // 等待上传完成
      //   if (TODO_SELECTOR_SUCCESS_INDICATOR) {
      //     await page.locator(TODO_SELECTOR_SUCCESS_INDICATOR).first()
      //       .waitFor({ timeout: 30000 });
      //   }
      //   if (TODO_SELECTOR_SUBMIT_BUTTON) {
      //     await page.locator(TODO_SELECTOR_SUBMIT_BUTTON).click();
      //   }

      // 占位：未配置 selector 时直接 throw
      throw new Error(
        "Upload-Gongyi.js 选择器未配置：请编辑文件顶部 TODO_SELECTOR_* 标记处，填入真实 selector"
      );
    } catch (err) {
      const backoff = RETRY_BACKOFF_MS[attempt - 1] || 30000;
      console.error(`  [retry ${attempt}/${RETRY_MAX}] ${basename}: ${err.message}`);
      if (attempt >= RETRY_MAX) throw err;
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

// ---------- 主流程 ----------
async function main() {
  const args = parseArgs();
  const sourceDir = args.sourceDir;

  if (!fs.existsSync(sourceDir)) {
    console.error(`ERROR: source dir not found: ${sourceDir}`);
    process.exit(2);
  }

  // 收集待处理 PDF
  const allPdfs = fs
    .readdirSync(sourceDir)
    .filter((n) => n.toLowerCase().endsWith(".pdf"))
    .map((n) => path.join(sourceDir, n));

  // 过滤已上传
  const state = loadState();
  const todo = allPdfs.filter((p) => {
    const h = fileHash(p);
    return !state[path.basename(p)] || state[path.basename(p)].hash !== h;
  });

  console.log(`[scan] total=${allPdfs.length} todo=${todo.length} already_uploaded=${allPdfs.length - todo.length}`);

  if (args.dryRun) {
    console.log("[dry-run] 列出待上传文件：");
    todo.slice(0, 20).forEach((p) => console.log(`  - ${path.basename(p)}`));
    if (todo.length > 20) console.log(`  ... (${todo.length - 20} more)`);
    return;
  }

  // 连接 CDP
  console.log(`[cdp] connecting to ${CDP_URL} ...`);
  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (e) {
    console.error(`ERROR: 无法连接 Chrome CDP: ${e.message}`);
    console.error("请先运行 scripts/Start-Chrome-CDP.ps1 启动带调试端口的 Chrome");
    process.exit(1);
  }

  // 取已开页面（不新建，找当前活动 tab）
  const contexts = browser.contexts();
  if (contexts.length === 0) {
    console.error("ERROR: CDP 已连，但无 browser context。请先在 Chrome 里打开一个页面。");
    process.exit(1);
  }
  const context = contexts[0];
  let page = context.pages().find((p) => !p.url().startsWith("chrome://")) || context.pages()[0];

  // 导航到平台首页
  console.log(`[nav] -> ${PLATFORM_URL}`);
  await page.goto(PLATFORM_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

  // 登录态检测
  if (TODO_SELECTOR_LOGIN_INDICATOR && !TODO_SELECTOR_LOGIN_INDICATOR.startsWith("TODO_")) {
    try {
      await page.locator(TODO_SELECTOR_LOGIN_INDICATOR).first().waitFor({ timeout: 5000 });
      console.log("[auth] logged in OK");
    } catch (e) {
      console.error("ERROR: 登录态未检测到。请在 Chrome 里手动登录公益平台后重跑。");
      process.exit(1);
    }
  } else {
    console.warn("[auth] 跳过登录态检测（TODO_SELECTOR_LOGIN_INDICATOR 未配置）");
  }

  // 循环上传
  let ok = 0, fail = 0, skip = 0;
  const limit = Math.min(args.limit, todo.length);
  for (let i = 0; i < limit; i++) {
    const pdf = todo[i];
    const basename = path.basename(pdf);
    console.log(`[${i + 1}/${limit}] ${basename}`);
    try {
      await uploadOne(page, pdf);
      state[basename] = {
        hash: fileHash(pdf),
        uploadedAt: new Date().toISOString(),
        size: fs.statSync(pdf).size,
      };
      saveState(state);
      ok++;
    } catch (e) {
      logFailure(basename, e.message + "\n" + (e.stack || ""));
      fail++;
    }
  }

  // 报告
  ensureDir(REPORT_DIR);
  const reportFile = path.join(REPORT_DIR, `upload-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`);
  const report = [
    `source=${sourceDir}`,
    `total=${allPdfs.length}`,
    `todo=${todo.length}`,
    `uploaded=${ok}`,
    `failed=${fail}`,
    `skipped=${skip}`,
  ].join("\n");
  fs.writeFileSync(reportFile, report + "\n", "utf8");

  console.log("");
  console.log(`[done] uploaded=${ok} failed=${fail}`);
  console.log(`[report] -> ${reportFile}`);
  console.log(`[state]  -> ${STATE_FILE}`);

  // 不关闭 browser，让用户继续用
  await browser.close().catch(() => {});
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});