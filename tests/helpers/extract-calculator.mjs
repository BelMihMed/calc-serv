import fs from "node:fs";
import vm from "node:vm";

function findBalancedEnd(source, openIndex, openChar, closeChar) {
  let depth = 0;
  let quote = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (ch === "\\") {
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === "\"" || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === openChar) {
      depth += 1;
    } else if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  throw new Error(`Cannot find matching ${closeChar}`);
}

function extractDeclaration(source, marker, openChar, closeChar) {
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Cannot find ${marker}`);
  const openIndex = source.indexOf(openChar, start);
  if (openIndex < 0) throw new Error(`Cannot find ${openChar} after ${marker}`);
  const end = findBalancedEnd(source, openIndex, openChar, closeChar);
  let semicolon = end + 1;
  while (/\s/.test(source[semicolon] || "")) semicolon += 1;
  if (source[semicolon] === ";") semicolon += 1;
  return source.slice(start, semicolon);
}

function extractConstants(source) {
  const start = source.includes("const PRICE_CONFIG =")
    ? source.indexOf("const PRICE_CONFIG =")
    : source.indexOf("const TAX =");
  const end = source.indexOf("/* ---------- Конфигурация сценариев", start);
  if (start < 0 || end < 0) throw new Error("Cannot find calculator constants");
  return source.slice(start, end);
}

function extractFunction(source, name) {
  return extractDeclaration(source, `function ${name}`, "{", "}");
}

export function loadCalculator(indexFile) {
  const source = fs.readFileSync(indexFile, "utf8");
  const constants = extractConstants(source);
  const scenarios = extractDeclaration(source, "const scenarios = [", "[", "]");
  const computeScenario = extractFunction(source, "computeScenario");
  const script = `
${constants}
${scenarios}
${computeScenario}
globalThis.__calculator = {
  TAX,
  HOURS_MONTH,
  DAYS_MONTH,
  DAY_HOURS,
  COST_YEAR,
  costHour,
  costMinute,
  getRecommendedCloudTariff,
  getCloudRecommendationText,
  calculateCloudFirstYearCosts,
  getRequiredBoxTariffForUsers,
  getBoxTariff,
  getBoxTariffOptions,
  calculateBoxFirstYearCosts,
  calculateEconomics,
  scenarios,
  computeScenario,
  source: globalThis.__source
};
`;

  const context = vm.createContext({ __source: source });
  new vm.Script(script, { filename: "calculator-extract.js" }).runInContext(context);
  return context.__calculator;
}

export function loadIntegratorDefaults(indexFile) {
  const source = fs.readFileSync(indexFile, "utf8");
  if (!source.includes("const INTEGRATOR_DEFAULT =")) return null;

  const defaults = extractDeclaration(source, "const INTEGRATOR_DEFAULT = {", "{", "}");
  const script = `
${defaults}
globalThis.__integratorDefaults = INTEGRATOR_DEFAULT;
`;
  const context = vm.createContext({});
  new vm.Script(script, { filename: "integrator-extract.js" }).runInContext(context);
  return context.__integratorDefaults;
}

export function loadPriceConfig(indexFile) {
  const source = fs.readFileSync(indexFile, "utf8");
  const priceConfig = extractDeclaration(source, "const PRICE_CONFIG = {", "{", "}");
  const script = `
${priceConfig}
globalThis.__priceConfig = PRICE_CONFIG;
`;

  const context = vm.createContext({});
  new vm.Script(script, { filename: "price-config-extract.js" }).runInContext(context);
  return context.__priceConfig;
}

export function createCompanyAutofillHarness(indexFile, initialState, targets = {}) {
  const source = fs.readFileSync(indexFile, "utf8");
  const autofill = extractDeclaration(source, "const AUTOFILL = {", "{", "}");
  const applyCompany = extractFunction(source, "applyCompany");
  const script = `
const parseNum = value => Number(String(value).replace(/\\s/g, "").replace(",", ".")) || 0;
const groupFmt = value => String(value);
const state = globalThis.__initialState;
const document = {
  querySelector(selector) {
    return globalThis.__targets[selector] || null;
  }
};
${autofill}
${applyCompany}
globalThis.__autofillHarness = { applyCompany, state, targets: globalThis.__targets };
`;

  const context = vm.createContext({
    __initialState: initialState,
    __targets: targets
  });
  new vm.Script(script, { filename: "autofill-extract.js" }).runInContext(context);
  return context.__autofillHarness;
}
