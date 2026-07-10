const fs = require('fs');
const path = require('path');

const states = require('./data/states.json');
const monetization = require('./data/monetization-config.json');
const DOMAIN = 'https://usachildsupportcalculator.com';
const YEAR = new Date().getFullYear();

function assertComplete(state) {
  const required = ['source', 'last_verified', 'guideline_version'];
  for (const field of required) {
    if (!state[field] || (field === 'source' && !state.source.url)) {
      throw new Error(`BUILD BLOCKED: state "${state.name}" is missing required field "${field}" — no page without a cited, dated source.`);
    }
  }
}

function loadRules(slug) {
  const rulesPath = path.join(__dirname, 'data', 'rules', `${slug}.json`);
  if (!fs.existsSync(rulesPath)) {
    throw new Error(`BUILD BLOCKED: missing data/rules/${slug}.json for state "${slug}".`);
  }
  return JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
}

function loadSchedule(state) {
  if (!state.params.schedule_table_ref) return null;
  const schedPath = path.join(__dirname, 'data', 'schedules', state.params.schedule_table_ref);
  if (!fs.existsSync(schedPath)) {
    throw new Error(`BUILD BLOCKED: missing schedule table ${state.params.schedule_table_ref} for state "${state.name}".`);
  }
  return JSON.parse(fs.readFileSync(schedPath, 'utf8'));
}

function monetizationSlot(id) {
  const adsOn = monetization.ads.enabled && monetization.ads.slots.includes(id);
  const leadOn = monetization.leadgen.enabled && monetization.leadgen.placement.includes(id);
  if (!adsOn && !leadOn) return `<div id="mon-${id}" class="mon-slot" hidden></div>`;
  let inner = '';
  if (leadOn) {
    inner += `<a class="cta-leadgen" href="${monetization.leadgen.destination_url}">${monetization.leadgen.cta_text}</a>`;
  }
  return `<div id="mon-${id}" class="mon-slot">${inner}</div>`;
}

function calculatorFormFields(state) {
  if (state.formula_model === 'percentage_of_income') {
    return `
      <label>Your net monthly income ($)
        <input type="number" id="obligorNetMonthlyIncome" min="0" step="1" value="4000">
      </label>
      <label>Number of children
        <select id="numChildren">
          <option value="1">1</option><option value="2">2</option><option value="3">3</option>
          <option value="4">4</option><option value="5">5</option><option value="6">6 or more</option>
        </select>
      </label>`;
  }
  // income_shares and melson share the same form shape
  return `
      <label>Parent A gross monthly income ($)
        <input type="number" id="parentAGrossIncome" min="0" step="1" value="4000">
      </label>
      <label>Parent B gross monthly income ($)
        <input type="number" id="parentBGrossIncome" min="0" step="1" value="3000">
      </label>
      <label>Number of children
        <select id="numChildren">
          <option value="1">1</option><option value="2">2</option><option value="3">3</option>
          <option value="4">4</option><option value="5">5</option><option value="6">6 or more</option>
        </select>
      </label>
      <label>Overnights per year with Parent A
        <input type="number" id="overnightsWithA" min="0" max="365" step="1" value="182">
      </label>
      <label>Monthly childcare cost ($)
        <input type="number" id="childcareCost" min="0" step="1" value="0">
      </label>
      <label>Monthly health insurance premium for child(ren) ($)
        <input type="number" id="healthInsuranceCost" min="0" step="1" value="0">
      </label>`;
}

function calculatorScript(state) {
  const stateJson = JSON.stringify(state);
  const rulesJson = JSON.stringify(loadRules(state.slug));
  const scheduleJson = JSON.stringify(loadSchedule(state));
  return `
  <script src="/assets/calc-engine.js"></script>
  <script>
    const STATE_ENTRY = ${stateJson};
    const RULES = ${rulesJson};
    const SCHEDULE = ${scheduleJson};

    function readInputs() {
      if (STATE_ENTRY.formula_model === 'percentage_of_income') {
        return {
          obligorNetMonthlyIncome: Number(document.getElementById('obligorNetMonthlyIncome').value) || 0,
          numChildren: Number(document.getElementById('numChildren').value) || 1
        };
      }
      return {
        parentAGrossIncome: Number(document.getElementById('parentAGrossIncome').value) || 0,
        parentBGrossIncome: Number(document.getElementById('parentBGrossIncome').value) || 0,
        numChildren: Number(document.getElementById('numChildren').value) || 1,
        overnightsWithA: Number(document.getElementById('overnightsWithA').value) || 0,
        childcareCost: Number(document.getElementById('childcareCost').value) || 0,
        healthInsuranceCost: Number(document.getElementById('healthInsuranceCost').value) || 0
      };
    }

    function runCalculation() {
      const inputs = readInputs();
      const result = calculateChildSupport(STATE_ENTRY, RULES, SCHEDULE, inputs);
      document.getElementById('result-amount').textContent = '$' + result.monthlyAmount.toLocaleString() + '/month';
      document.getElementById('result-deviation').textContent = result.deviationNote || '';
      const warnEl = document.getElementById('result-warning');
      if (result.capWarning) {
        warnEl.textContent = result.capWarning;
        warnEl.hidden = false;
      } else {
        warnEl.hidden = true;
      }
      document.getElementById('results-block').hidden = false;
    }

    document.getElementById('calc-form').addEventListener('submit', function(e) {
      e.preventDefault();
      runCalculation();
    });
  </script>`;
}

function jsonLd(state) {
  const graph = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'WebApplication',
        name: `${state.name} Child Support Calculator`,
        applicationCategory: 'FinanceApplication',
        operatingSystem: 'Any',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        dateModified: state.last_verified
      },
      {
        '@type': 'FAQPage',
        mainEntity: [
          {
            '@type': 'Question',
            name: `How is child support calculated in ${state.name}?`,
            acceptedAnswer: { '@type': 'Answer', text: state.worksheet.steps.join(' ') }
          },
          ...(state.faq_extra || []).map(q => ({
            '@type': 'Question',
            name: q,
            acceptedAnswer: { '@type': 'Answer', text: `See the guidelines section above for how this applies under ${state.name}'s child support formula.` }
          }))
        ]
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${DOMAIN}/` },
          { '@type': 'ListItem', position: 2, name: `${state.name} Child Support Calculator`, item: `${DOMAIN}/${state.slug}/` }
        ]
      }
    ]
  };
  return JSON.stringify(graph);
}

function renderStatePage(state) {
  assertComplete(state);
  const rules = loadRules(state.slug);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${state.name} Child Support Calculator ${YEAR} — Free Estimate</title>
<meta name="description" content="Estimate ${state.name} child support using the state's official ${state.formula_model.replace(/_/g, ' ')} guideline formula. Free calculator + full worksheet walkthrough, updated ${state.last_verified}.">
<link rel="canonical" href="${DOMAIN}/${state.slug}/">
<link rel="stylesheet" href="/assets/styles.css">
<meta property="og:title" content="${state.name} Child Support Calculator">
<meta property="og:description" content="Free ${state.name} child support estimate based on official state guidelines.">
<meta property="og:url" content="${DOMAIN}/${state.slug}/">
<meta property="og:type" content="website">
<script type="application/ld+json">${jsonLd(state)}</script>
</head>
<body>
<header>
  <a href="/">← All States</a>
  <h1>${state.name} Child Support Calculator</h1>
  <p class="badge">Updated for ${state.name}'s ${state.guideline_version} guidelines · Last reviewed ${state.last_verified}</p>
</header>

<div class="disclaimer-banner">
  Estimate only — not legal advice. This calculator provides a good-faith estimate based on ${state.name}'s published child support guidelines as of ${state.last_verified}. Results may differ from a court order. For your official calculation, consult ${state.source.agency_name} or a family law attorney licensed in ${state.name}.
</div>

<main>
  <form id="calc-form">
    ${calculatorFormFields(state)}
    <button type="submit">Calculate</button>
  </form>

  <div id="results-block" hidden>
    <p id="result-amount" class="result-amount"></p>
    <p id="result-warning" class="result-warning" hidden></p>
    <p id="result-deviation" class="result-deviation"></p>
    ${monetizationSlot('results-sidebar')}
    ${monetizationSlot('results-block')}
  </div>

  <p class="privacy-note">Calculation is client-side, income figures are never transmitted or stored.</p>

  <section>
    <h2>How ${state.name} Child Support Is Calculated</h2>
    <ol>${state.worksheet.steps.map(s => `<li>${s}</li>`).join('')}</ol>
    ${monetizationSlot('below-worksheet')}
  </section>

  <section>
    <h2>${state.name} Child Support Worksheet Walkthrough</h2>
    <p>${state.worksheet.example ? state.worksheet.example.scenario : ''}</p>
    ${state.worksheet.example ? `<ol>${state.worksheet.example.calculation.map(s => `<li>${s}</li>`).join('')}</ol>` : ''}
  </section>

  <section>
    <h2>FAQ</h2>
    <details><summary>How is child support calculated in ${state.name}?</summary><p>${state.worksheet.steps.join(' ')}</p></details>
    ${(state.faq_extra || []).map(q => `<details><summary>${q}</summary><p>See the guidelines section above.</p></details>`).join('')}
  </section>

  <section class="methodology">
    <h2>Methodology &amp; Source</h2>
    <p>Formula model: ${state.formula_model.replace(/_/g, ' ')}. Effective ${state.effective_date}, guideline version ${state.guideline_version}, last reviewed ${state.last_verified}.</p>
    <p>Official source: <a href="${state.source.url}" rel="nofollow noopener">${state.source.agency_name}</a>${state.source.statute_ref ? ` (${state.source.statute_ref})` : ''}.</p>
    <p class="deviation-note">${rules.deviation_note}</p>
    <p class="verified-by">Guideline figures transcribed from the primary source above and cross-checked against ${state.name}'s official calculator/worksheet for multiple test scenarios — see our <a href="/about/">verification methodology</a>.</p>
  </section>
</main>

<footer>
  <p>Gesmine-Invest Limited, registered UK company number 14120136, Hardy House, 269 Poynders Gardens, London, SW4 8PQ.</p>
  <p><a href="/about/">About</a> · <a href="/privacy/">Privacy</a> · &copy; ${YEAR} USA Child Support Calculator. Estimates only — not legal advice.</p>
</footer>

${calculatorScript(state)}
</body>
</html>`;
}

Object.values(states).forEach(state => {
  const html = renderStatePage(state);
  const dir = path.join(__dirname, state.slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
  console.log(`Generated: ${state.slug}/ (${state.formula_model})`);
});
