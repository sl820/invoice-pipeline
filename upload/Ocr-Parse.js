#!/usr/bin/env node
/*
 * Ocr-Parse.js
 * 从 bl vision describe 转写出的纯文本里抽取 payer + amount + invoiceDate
 * 用法: node Ocr-Parse.js <ocr-text-file>
 */

const fs = require("fs");
const path = require("path");

const file = process.argv[2];
if (!file) {
  console.error("Usage: node Ocr-Parse.js <ocr-text-file>");
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error("File not found:", file);
  process.exit(2);
}

const text = fs.readFileSync(file, "utf8");

// ---------- payer 抽取 ----------
function extractPayer(t) {
  // 1. 交款人（捐赠方/付款方）
  let m = t.match(/交款人[（(]?(?:捐赠方|付款方)?[）)]?[：:]\s*([^\n\r]+)/);
  if (m) return clean(m[1]);
  // 2. 付款方
  m = t.match(/付款方[（(]?[^）)]*[）)]?[：:]\s*([^\n\r]+)/);
  if (m) return clean(m[1]);
  // 3. 抬头
  m = t.match(/抬头[：:]\s*([^\n\r]+)/);
  if (m) return clean(m[1]);
  return "";
}

// ---------- amount 抽取 ----------
function extractAmount(t) {
  // 1. 金额合计（小写）后面跟的数字
  let m = t.match(/金额合计[（(]?小写[）)]?[：:\s]*[¥￥]?\s*([0-9]+\.[0-9]{2})/);
  if (m) return m[1];
  // 2. 价税合计 / 合计金额
  m = t.match(/(?:价税合计|合计金额|价税合计金额)[（(]?小写[）)]?[：:\s]*[¥￥]?\s*([0-9]+\.[0-9]{2})/);
  if (m) return m[1];
  // 3. 价税合计（不指定小写）
  m = t.match(/价税合计[：:\s]*[¥￥]?\s*([0-9]+\.[0-9]{2})/);
  if (m) return m[1];
  // 4. 兜底：所有 X.XX 数字取最大（合计一般比分项大）
  const all = [...t.matchAll(/([0-9]+\.[0-9]{2})/g)].map(m => m[1]).map(parseFloat);
  if (all.length > 0) {
    return Math.max(...all).toFixed(2);
  }
  return "";
}

// ---------- invoiceDate 抽取 ----------
function extractDate(t) {
  // YYYY-MM-DD
  let m = t.match(/(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  // YYYY/MM/DD
  m = t.match(/(\d{4}\/\d{2}\/\d{2})/);
  if (m) return m[1].replace(/\//g, "-");
  // YYYY年MM月DD日
  m = t.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (m) {
    const y = m[1], mo = m[2].padStart(2, "0"), d = m[3].padStart(2, "0");
    return `${y}-${mo}-${d}`;
  }
  return "";
}

function clean(s) {
  return s
    .replace(/\s+/g, " ")
    .replace(/[（(]?(?:捐赠方|付款方|买方|客户)[）)]?/g, "")
    .replace(/^\s*[:：]\s*/, "")
    .trim();
}

const result = {
  payer: extractPayer(text),
  amount: extractAmount(text),
  invoiceDate: extractDate(text),
};
console.log(JSON.stringify(result));