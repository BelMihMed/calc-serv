import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// Общее ядро для второго продукта (Коворк/Код, см. TZ-cowork.md §2.2) извлекается из index.html
// по парным маркерам; сборка Коворка ищет их по имени:
//   CSS  — /* @core:<имя> */ … /* @core:end */
//   HTML — <!-- @core:<имя> --> … <!-- @core:end -->
//   JS   — // @core:<имя> … // @core:end
// Имена уникальны, блоки не вкладываются. Тест страхует от случайного удаления, дублирования
// или разрыва маркера при правках канона — иначе сборка второго продукта развалится молча.

const INDEX_FILE = new URL("../index.html", import.meta.url);
const source = fs.readFileSync(INDEX_FILE, "utf8");

const CORE_BLOCKS = {
  "tokens":       { kind: "css",  must: [":root{", "--accent:", "--radius:", "--grad:"] },
  "base-css":     { kind: "css",  must: ["body{", ".wrap{", ".company{", ".navbar{", ".chk{", ".field ", ".field input{",
                                         ".info-btn{", ".modal-overlay{", ".btn-primary{", ".report-overlay{",
                                         ".drawer-overlay{", ":focus-visible{", "prefers-reduced-motion"] },
  "company-html": { kind: "html", must: ['id="company-name"', 'data-comp="empCount"', 'data-comp="empSal"',
                                         'data-comp="mgrCount"', 'data-comp="mgrSal"', 'data-comp="ropCount"', 'data-comp="ropSal"'] },
  "glossary":     { kind: "js",   must: ["const TAX", "const HOURS_MONTH", "const DAY_HOURS", "const DAYS_MONTH",
                                         "const WEEKS_MONTH", "const VAT", "const costHour", "function groupFmt",
                                         "function parseNum", "function onNumInput", "const fmtMoney"] },
  "economics":    { kind: "js",   must: ["function calculateEconomics", "function formatConfigDate"] },
  "method":       { kind: "js",   must: ["const REAL_INFO", "const METHOD_NOTE", "const realCoef"] },
  "company":      { kind: "js",   must: ["function applyCompany", ".comp-in", "dirty",
                                         "function saveCompanyProfile", "function applySharedCompany", "bgpt_company", ".prod-switch a.prod-opt[href]"] },
  "analytics":    { kind: "js",   must: ["const LOG_ENDPOINT", "function inIframe", "function sendLog", "function lsGet",
                                         "function lsSet", "const SESS", "function sessRecord", "function sendSession",
                                         "PRODUCT_VERSION"] },
  "report-shell": { kind: "js",   must: ["function makeQrSvg", "const REPORT_CSS", "const reportOverlay",
                                         "function closeReport", "function showReportHtml"] },
  "info-modal":   { kind: "js",   must: ["const infoModal", "function closeInfo", ".info-btn", "openInfo("] },
};

const MARK = {
  css:  { start: (n) => `/* @core:${n} */`, end: "/* @core:end */" },
  html: { start: (n) => `<!-- @core:${n} -->`, end: "<!-- @core:end -->" },
  js:   { start: (n) => `// @core:${n}`, end: "// @core:end" },
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const lineRe = (marker) => new RegExp("^[ \\t]*" + escapeRe(marker) + "[ \\t]*$", "gm");

function extractBlock(name) {
  const { kind } = CORE_BLOCKS[name];
  const start = MARK[kind].start(name);
  const starts = [...source.matchAll(lineRe(start))];
  assert.equal(starts.length, 1, `маркер ${start} должен встречаться ровно один раз (найдено ${starts.length})`);
  const from = starts[0].index + starts[0][0].length;
  const endRe = lineRe(MARK[kind].end);
  endRe.lastIndex = from;
  const end = endRe.exec(source);
  assert.ok(end, `у блока ${name} нет закрывающего маркера ${MARK[kind].end}`);
  const body = source.slice(from, end.index);
  assert.equal(body.includes("@core:"), false, `блок ${name} не должен содержать других @core-маркеров (вложенность запрещена)`);
  assert.ok(body.trim().length > 0, `блок ${name} не пустой`);
  return body;
}

test("core markers: every block exists exactly once, closed, non-nested", () => {
  const names = (source.match(/@core:[\w-]+/g) || []).map((m) => m.slice("@core:".length));
  const starts = names.filter((n) => n !== "end");
  assert.deepEqual([...starts].sort(), Object.keys(CORE_BLOCKS).sort(), "набор маркеров ядра совпадает с ожидаемым");
  assert.equal(names.filter((n) => n === "end").length, starts.length, "у каждого блока ровно один @core:end");
  for (const name of Object.keys(CORE_BLOCKS)) extractBlock(name);
});

test("core markers: each block carries its declared contents", () => {
  for (const [name, spec] of Object.entries(CORE_BLOCKS)) {
    const body = extractBlock(name);
    for (const needle of spec.must) {
      assert.ok(body.includes(needle), `блок ${name} должен содержать ${JSON.stringify(needle)}`);
    }
  }
});

test("core markers: JS blocks are syntactically self-contained", () => {
  for (const [name, spec] of Object.entries(CORE_BLOCKS)) {
    if (spec.kind !== "js") continue;
    const body = extractBlock(name);
    assert.doesNotThrow(() => new vm.Script(body, { filename: `core-${name}.js` }), `блок ${name} парсится как цельный JS`);
  }
});

test("core markers: product-specific code stays outside the core", () => {
  const tokens = extractBlock("tokens").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(tokens, /^\s*:root\{[^}]*\}\s*$/, "tokens — это ровно один блок :root");

  const base = extractBlock("base-css");
  for (const productRule of [".card{", ".summary{", ".group-crm", ".sum-grid", ".b24-row", ".mgr-set", "@int:css", '[data-go="sec-']) {
    assert.equal(base.includes(productRule), false, `base-css не содержит продуктовое правило ${productRule}`);
  }

  const companyHtml = extractBlock("company-html");
  assert.equal(companyHtml.includes("b24-row"), false, "строка «Ваш Битрикс24» (формат и тариф) — продуктовая, не в ядре");

  const method = extractBlock("method");
  assert.equal(method.includes("const REAL ="), false, "конфиг REAL — продуктовый, в ядре только REAL_INFO/METHOD_NOTE/realCoef");
  assert.match(source, /const realOf = sc => realCoef\(REAL, sc\.id\);/);

  const analytics = extractBlock("analytics");
  assert.equal(analytics.includes("const PRODUCT_VERSION"), false, "PRODUCT_VERSION задаётся продуктом снаружи блока");
  assert.equal(analytics.includes("integratorCost"), false, "ядро аналитики не знает про serv-специфику");
  assert.equal(source.includes('? "calc-serv" : "calc",'), false, "version во всех событиях берётся из PRODUCT_VERSION");

  const report = extractBlock("report-shell");
  assert.equal(report.includes("function buildReportHtml"), false, "buildReportHtml — продуктовый");
  assert.match(source, /"<style>" \+ REPORT_CSS \+ "<\/style>/, "отчёт подключает общие стили из REPORT_CSS");
});

test("core glossary: constants match the shared baseline (1.4 / 176 / 8 / 22 / 52÷12 / 0.22)", () => {
  const context = vm.createContext({});
  new vm.Script(extractBlock("glossary"), { filename: "core-glossary.js" }).runInContext(context);
  const g = (name) => new vm.Script(name).runInContext(context);
  assert.equal(g("TAX"), 1.4);
  assert.equal(g("HOURS_MONTH"), 176);
  assert.equal(g("DAY_HOURS"), 8);
  assert.equal(g("DAYS_MONTH"), 22);
  assert.equal(g("WEEKS_MONTH"), 52 / 12);
  assert.equal(g("VAT"), 0.22);
  assert.ok(Math.abs(g("costHour(100000)") - 795.454545) < 0.001);
  assert.equal(g('groupFmt("1234567.5")'), "1 234 567.5");
  assert.equal(g('parseNum("1 234,5")'), 1234.5);
  assert.equal(g("parseNum('-3')"), 3, "минус отбрасывается, отрицательных значений нет");
  assert.equal(g("fmtInt(1234)").replace(/ /g, " "), "1 234");
});
