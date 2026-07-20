import test from "node:test";
import assert from "node:assert/strict";
import { loadCalculator } from "./helpers/extract-calculator.mjs";

// Сквозные («fill variant») тесты: имитируют заполнение калькулятора целиком —
// выбор нескольких сценариев (с дефолтами или ручными значениями) + компания + тариф —
// и прогоняют ту же цепочку, что строит отчёт:
//   Σ computeScenario -> totalFot -> затраты 1-го года (облако|коробка) -> calculateEconomics.
// Каждый вариант подобран так, чтобы сработало ключевое правило И совпали итоговые суммы.

const INDEX_FILE = new URL("../index.html", import.meta.url);
const calculator = loadCalculator(INDEX_FILE);

function scenarioById(id) {
  const sc = calculator.scenarios.find((s) => s.id === id);
  assert.ok(sc, `scenario ${id} exists`);
  return sc;
}

function defaultsFor(sc) {
  return Object.fromEntries(sc.fields.map((f) => [f.k, f.def]));
}

function assertClose(actual, expected, label, eps = 0.01) {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${label}: expected ${expected}, got ${actual}`
  );
}

// selections: [{ id, values? }] — values перекрывают дефолты выбранного сценария.
function runVariant({ selections, tariffId, employees, isBox = false, extraInt = 0 }) {
  let totalFot = 0;
  let totalRev = 0;
  let totalPot = 0;
  for (const sel of selections) {
    const sc = scenarioById(sel.id);
    const values = { ...defaultsFor(sc), ...(sel.values || {}) };
    const r = sc.compute(values);
    totalFot += r.fot;
    if (sc.revLabel === "Потенциал базы") totalPot += r.rev || 0;
    else totalRev += r.rev || 0;
  }
  const costs = isBox
    ? calculator.calculateBoxFirstYearCosts(employees, tariffId, extraInt)
    : calculator.calculateCloudFirstYearCosts(tariffId, employees, extraInt);
  const econ = calculator.calculateEconomics(totalFot, costs.firstYearCosts);
  return { totalFot, totalRev, totalPot, costs, econ };
}

test("variant A — small company, cloud: recommendation floors at Professional", () => {
  // Правило: даже для 40 пользователей рекомендуем тариф не ниже «Профессионального».
  const v = runVariant({
    selections: [{ id: 1 }, { id: 4 }, { id: 3 }],
    tariffId: "basic",
    employees: 40
  });
  assert.equal(v.costs.target.id, "pro");
  assert.equal(v.costs.tariffYear, 96600); // доплата basic -> pro за год
  assert.equal(v.costs.subscriptionYear, 57600);
  assert.equal(v.costs.firstYearCosts, 154200);
  assertClose(v.totalFot, 232166.666667, "totalFot");
  assertClose(v.econ.netFirstYear, 2631800, "net first year");
  // Правило: в окупаемость входит только ФОТ — прирост выручки (125000) игнорируется.
  assert.equal(v.econ.netFirstYear, v.totalFot * 12 - v.costs.firstYearCosts);
  assert.ok(v.totalRev > 0);
  assert.ok(v.econ.paybackMonths < 1); // окупается менее чем за месяц
});

test("variant B — 150 users, agents, cloud: recommends Enterprise (250)", () => {
  // Правило: >100 пользователей -> ступень Энтерпрайза; текст отмечает ИИ-агентов.
  const v = runVariant({
    selections: [{ id: 9 }, { id: 10 }, { id: 11 }],
    tariffId: "pro",
    employees: 150
  });
  assert.equal(v.costs.target.id, "ent250");
  assert.equal(v.costs.tariffYear, 168000); // доплата pro -> ent250
  assert.equal(v.costs.firstYearCosts, 298560);
  assertClose(v.totalFot, 711666.666667, "totalFot");
  assertClose(v.econ.netFirstYear, 8241440, "net first year");

  const text = calculator.getCloudRecommendationText(v.costs.target, "150", true);
  assert.match(text, /Энтерпрайз \(250\)/);
  assert.match(text, /ИИ-агентами/);
});

test("variant C — 700 users on Enterprise: scales to Enterprise (1000)", () => {
  // Правило: >500 пользователей -> ent1000; доплата = разница тарифов от текущего Энтерпрайза.
  const v = runVariant({
    selections: [{ id: 10 }, { id: 11 }, { id: 2 }],
    tariffId: "enterprise",
    employees: 700
  });
  assert.equal(v.costs.target.id, "ent1000");
  assert.equal(v.costs.tariffYear, 554400); // (69993 - 23793) * 12
  assert.equal(v.costs.subscriptionYear, 384000);
  assert.equal(v.costs.firstYearCosts, 938400);
  assertClose(v.totalFot, 728291.666667, "totalFot");
  assertClose(v.econ.netFirstYear, 7801100, "net first year");
});

test("variant D — box edition, 120 users: license upgrade surcharge only", () => {
  // Правило: коробка сравнивает текущую редакцию с требуемой; доплата = разница лицензий.
  const v = runVariant({
    selections: [{ id: 3 }, { id: 6 }, { id: 7 }],
    tariffId: "box_cp50",
    employees: 120,
    isBox: true
  });
  assert.equal(v.costs.target.id, "box_cp250"); // 120 польз. требует редакцию до 250
  assert.equal(v.costs.upgradeRequired, true);
  assert.equal(v.costs.licenseSurcharge, 190000); // 349000 - 159000
  assert.equal(v.costs.subscriptionYear, 120000);
  assert.equal(v.costs.firstYearCosts, 310000); // 190000 + 120000
  assertClose(v.totalFot, 329742.424242, "totalFot");
});

test("variant E — only база-potential selected: net is negative, payback ignores potential", () => {
  // Правило: потенциал/выручка не входят в окупаемость; при нулевом ФОТ чистая экономия = -затраты.
  const v = runVariant({
    selections: [{ id: 5 }],
    tariffId: "none",
    employees: 30
  });
  assert.equal(v.totalFot, 0);
  assert.equal(v.totalPot, 5000000); // потенциал базы есть...
  assert.equal(v.costs.target.id, "pro"); // нет Битрикс24 -> полный «Профессиональный»
  assert.equal(v.costs.firstYearCosts, 175116); // 117516 + 57600
  assert.equal(v.econ.netFirstYear, -175116); // ...но в чистую экономию он НЕ попадает
  assert.equal(v.econ.paybackMonths, 0);
});

test("variant F — manual field value flows through, no upgrade when current == recommended", () => {
  // Правило: ручное значение поля (calls: 100 вместо дефолтных 20) масштабирует ФОТ;
  // при 100 польз. на «Профессиональном» доплаты за тариф нет.
  const v = runVariant({
    selections: [{ id: 1, values: { calls: 100 } }],
    tariffId: "pro",
    employees: 100
  });
  assert.equal(v.costs.target.id, "pro");
  assert.equal(v.costs.tariffYear, 0); // текущий = рекомендованный -> без доплаты
  assert.equal(v.costs.firstYearCosts, 57600); // только подписка
  assertClose(v.totalFot, 291666.666667, "totalFot"); // 58333.33 * (100/20)
  assertClose(v.econ.netFirstYear, 3442400, "net first year");
});
