import test from "node:test";
import assert from "node:assert/strict";
import {
  createCompanyAutofillHarness,
  loadCalculator,
  loadIntegratorDefaults,
  loadPriceConfig
} from "./helpers/extract-calculator.mjs";

const INDEX_FILE = new URL("../index.html", import.meta.url);
const calculator = loadCalculator(INDEX_FILE);
const integratorDefaults = loadIntegratorDefaults(INDEX_FILE);
const priceConfig = loadPriceConfig(INDEX_FILE);

function defaultsFor(scenario) {
  return Object.fromEntries(scenario.fields.map((field) => [field.k, field.def]));
}

function scenarioById(id) {
  const scenario = calculator.scenarios.find((item) => item.id === id);
  assert.ok(scenario, `Scenario ${id} exists`);
  return scenario;
}

function assertClose(actual, expected, label, epsilon = 0.01) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `${label}: expected ${expected}, got ${actual}`
  );
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("calculator constants match the documented baseline", () => {
  assert.equal(calculator.TAX, 1.4);
  assert.equal(calculator.HOURS_MONTH, 176);
  assert.equal(calculator.DAYS_MONTH, 22);
  assert.equal(calculator.DAY_HOURS, 8);
  assert.equal(calculator.COST_YEAR, 9600);
  assertClose(calculator.costHour(100000), 795.454545, "costHour(100000)");
  assertClose(calculator.costMinute(100000), 13.257576, "costMinute(100000)");
});

test("financial result uses only FOT minus first-year costs", () => {
  const result = plain(calculator.calculateEconomics(100000, 200000));
  assert.deepEqual(result, {
    fotMonth: 100000,
    fotYear: 1200000,
    firstYearCosts: 200000,
    netFirstYear: 1000000,
    paybackMonths: 2,
    costSharePercent: 16.666666666666664
  });

  const noFot = plain(calculator.calculateEconomics(0, 9600));
  assert.equal(noFot.netFirstYear, -9600);
  assert.equal(noFot.paybackMonths, 0);

  const source = calculator.source;
  assert.match(source, /calculateEconomics\(fot, COST_YEAR(?: \+ integ)?\)/);
  assert.match(source, /calculateEconomics\(econ, costs1\)/);
  assert.equal(source.includes("const grand = fot + rev + pot"), false);
  assert.equal(source.includes("onlyPot"), false);
  assert.equal(source.includes("totalFot + totalRev + totalPot"), false);
});

test("all default scenario formulas keep their reference values", () => {
  const expected = {
    1: { fot: 58333.333333, rev: 125000 },
    4: { fot: 28000, rev: 0 },
    5: { fot: 0, rev: 5000000 },
    9: { fot: 26250, rev: 0 },
    2: { fot: 42875, rev: 0 },
    10: { fot: 306250, rev: 0 },
    11: { fot: 379166.666667, rev: 0 },
    12: { fot: 38181.818182, rev: 0 },
    3: { fot: 145833.333333, rev: 0 },
    6: { fot: 15909.090909, rev: 0 },
    7: { fot: 168000, rev: 0 }
  };

  assert.equal(calculator.scenarios.length, Object.keys(expected).length);

  for (const [id, sums] of Object.entries(expected)) {
    const scenario = scenarioById(Number(id));
    const result = scenario.compute(defaultsFor(scenario));
    assertClose(result.fot, sums.fot, `scenario ${id} fot`);
    assertClose(result.rev || 0, sums.rev, `scenario ${id} rev`);
  }
});

test("computeScenario sums the base values and additional segments", () => {
  const scenario = scenarioById(5);
  const values = defaultsFor(scenario);
  const result = calculator.computeScenario(scenario, {
    values,
    segments: [
      { base: 200, check: 75000, conv: 0.2 }
    ]
  });

  assertClose(result.fot, 0, "segmented repeat sales fot");
  assertClose(result.rev, 8000000, "segmented repeat sales rev");
});

test("support agent validation caps AI-closed requests at total requests", () => {
  const scenario = scenarioById(2);
  const values = { spec: 1, sal: 70000, total: 10, ai: 12, time: 7 };

  assert.deepEqual(plain(scenario.validate(values)), { ai: "Не больше «обращений всего»" });
  assertClose(scenario.compute(values).fot, 14291.666667, "support capped fot");
});

test("company autofill keeps scenario fields changed by hand", () => {
  const targets = {
    '#card-9 .num-in[data-k="mgr"]': { value: "manual" },
    '#card-10 .num-in[data-k="emp"]': { value: "old" },
    '#card-11 .num-in[data-k="emp"]': { value: "old" },
    '#card-3 .num-in[data-k="emp"]': { value: "old" },
    '#card-7 .num-in[data-k="emp"]': { value: "old" }
  };
  const harness = createCompanyAutofillHarness(INDEX_FILE, {
    9: { values: { mgr: 15 }, dirty: { mgr: true } },
    10: { values: { emp: 0 }, dirty: {} },
    11: { values: { emp: 0 }, dirty: {} },
    3: { values: { emp: 0 }, dirty: {} },
    7: { values: { emp: 0 }, dirty: {} }
  }, targets);

  harness.applyCompany({ value: "42", dataset: { comp: "empCount" } });

  assert.equal(harness.state[9].values.mgr, 15);
  assert.equal(targets['#card-9 .num-in[data-k="mgr"]'].value, "manual");
  assert.equal(harness.state[10].values.emp, 42);
  assert.equal(targets['#card-10 .num-in[data-k="emp"]'].value, "42");
});

test("tariff prices live in a single dated config", () => {
  assert.match(priceConfig.actualOn, /^\d{4}-\d{2}-\d{2}$/);

  const cloudById = Object.fromEntries(priceConfig.cloud.map((tariff) => [tariff.id, tariff]));
  assert.equal(cloudById.basic.subYear, 9600);
  assert.equal(cloudById.pro.monthly, 9793);
  assert.equal(cloudById.ent10000.subYear, 3840000);
  assert.equal(cloudById.enterprise.selectable, true);

  const boxById = Object.fromEntries(priceConfig.box.map((tariff) => [tariff.id, tariff]));
  assert.equal(boxById.box_cp500.subYear, 210000);

  const source = calculator.source;
  assert.equal((source.match(/const PRICE_CONFIG =/g) || []).length, 1);
  assert.equal(source.includes("const TAR_M"), false);
  assert.equal(source.includes("const TAR_IDX"), false);
  assert.equal(source.includes("const TAR_NAME"), false);
  assert.equal(source.includes("const SUB_Y"), false);
});

test("serv integrator defaults are stable when present", { skip: !integratorDefaults }, () => {
  assert.deepEqual(plain(integratorDefaults), {
    1: 20000,
    4: 50000,
    5: 50000,
    9: 50000,
    2: 100000,
    10: 50000,
    11: 20000,
    12: 50000,
    3: 50000,
    6: 10000,
    7: 50000
  });

  const total = Object.values(integratorDefaults).reduce((sum, value) => sum + value, 0);
  assert.equal(total, 500000);
});
