#!/usr/bin/env node
/*
 * Ocr-Parse.js
 * 从 bl vision describe 转写出的纯文本里抽取 payer + amount + invoiceDate
 * 用法: node Ocr-Parse.js <ocr-text-file>
 *
 * 关键点:
 *   - payer: 优先 "购买方/交款人/付款方" 后面跟着的公司全称
 *   - amount: 价税合计（含税小写）后面的数字
 *   - invoiceDate: YYYY-MM-DD / YYYY/MM/DD / 中文 "YYYY年MM月DD日"
 *   - 后处理: 括号字符归一化、公司后缀校验、地理前缀保留
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

// ---------- 后处理工具 ----------

// 括号字符归一化：所有括号统一成全角圆括号
function normalizeBrackets(s) {
  if (!s) return s;
  return s
    .replace(/[()]/g, "（")          // 半角圆括号 → 全角
    .replace(/[<>]/g, "（")          // 角括号 → 全角
    .replace(/【】/g, "（）")         // 方括号 → 全角圆括号
    .replace(/《/g, "（")            // 书名号左 → 全角圆括号
    .replace(/》/g, "）")            // 书名号右 → 全角圆括号
    .replace(/\s+/g, "")             // 公司名内不留空白
    .trim();
}

// 公司后缀校验：如果检测到后缀被截断，会发出警告（不自动补，因为不知道全称）
const COMPANY_SUFFIXES = [
  "有限公司", "有限责任公司", "股份有限公司",
  "经营部", "商行", "商店", "门市部",
  "厂", "工作室", "服务部", "事务所",
  "个体工商户", "个体户"
];

function hasCompanySuffix(s) {
  if (!s) return false;
  return COMPANY_SUFFIXES.some(suf => s.endsWith(suf));
}

// 已知地理前缀（避免模型补出多余的地理前缀）
const GEO_PREFIXES = [
  "北京市", "上海市", "天津市", "重庆市",
  "河北省", "山西省", "辽宁省", "吉林省", "黑龙江省",
  "江苏省", "浙江省", "安徽省", "福建省", "江西省", "山东省",
  "河南省", "湖北省", "湖南省", "广东省", "海南省",
  "四川省", "贵州省", "云南省", "陕西省", "甘肃省", "青海省",
  "台湾省",
  "内蒙古自治区", "广西壮族自治区", "西藏自治区", "宁夏回族自治区", "新疆维吾尔自治区",
  "香港特别行政区", "澳门特别行政区"
];

function stripExtraGeoPrefix(s) {
  if (!s) return s;
  for (const pre of GEO_PREFIXES) {
    if (s.startsWith(pre) && s.length > pre.length + 4) {
      // 去掉前缀，但只在它后面跟着 "XX市/县" 的时候（说明是冗余）
      const rest = s.slice(pre.length);
      if (/^[市县区]/.test(rest)) {
        return rest;
      }
    }
  }
  return s;
}

// ---------- payer 抽取 ----------

function extractPayer(t) {
  // 1. "购买方：" / "交款人：" / "付款方：" 后面的内容
  const patterns = [
    /购买方[：:]\s*([^\n\r]+)/,
    /交款人[：:]\s*([^\n\r]+)/,
    /付款方[：:]\s*([^\n\r]+)/,
    /购方[：:]\s*([^\n\r]+)/
  ];
  for (const pat of patterns) {
    const m = t.match(pat);
    if (m && m[1]) {
      const cleaned = cleanPayer(m[1]);
      if (cleaned) return cleaned;
    }
  }
  return "";
}

function cleanPayer(raw) {
  let s = raw || "";
  // 去掉可能的统一社会信用代码（在公司名后面）
  s = s.replace(/统一社会信用代码[：:][^\s]+/g, "");
  s = s.replace(/纳税人识别号[：:][^\s]+/g, "");
  // 去掉"名称："等残留标签
  s = s.replace(/(名称|全称|单位)[：:]\s*/g, "");
  // 归一化括号
  s = normalizeBrackets(s);
  // 去掉冗余的省级地理前缀
  s = stripExtraGeoPrefix(s);
  return s.trim();
}

// ---------- amount 抽取 ----------

function extractAmount(t) {
  // 1. "价税合计（大写）"后面跟着中文大写金额，不抽
  // 2. "价税合计（小写）" 或 "(小写)" 后面的 ¥X.XX
  let m = t.match(/价税合计[（(]小写[)）]\s*[¥￥]?\s*([0-9]+\.[0-9]{2})/);
  if (m) return m[1];

  m = t.match(/(?:小写)[）)]\s*[¥￥]?\s*([0-9]+\.[0-9]{2})/);
  if (m) return m[1];

  // 3. 兜底：所有 X.XX 数字取最大（合计一般比单项大）
  const all = [...t.matchAll(/([0-9]+\.[0-9]{2})/g)].map(m => parseFloat(m[1]));
  if (all.length > 0) {
    return Math.max(...all).toFixed(2);
  }
  return "";
}

// ---------- invoiceDate 抽取 ----------

function extractDate(t) {
  // YYYY-MM-DD
  let m = t.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) {
    return m[1] + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0");
  }
  // YYYY年MM月DD日
  m = t.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (m) {
    return m[1] + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0");
  }
  return "";
}

// ---------- 主流程 ----------

const payer = extractPayer(text);
const amount = extractAmount(text);
const invoiceDate = extractDate(text);

const result = {
  payer,
  amount,
  invoiceDate,
  payerHasSuffix: hasCompanySuffix(payer),
  payerNormalized: payer
};

console.log(JSON.stringify(result));
