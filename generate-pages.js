const fs = require('fs');
const path = require('path');

const states = require('./data/states.json');
const monetization = require('./data/monetization-config.json');
const DOMAIN = 'https://usachildsupportcalculator.com';
const YEAR = new Date().getFullYear();
const GESMINE_ORG = {
  '@type': 'Organization',
  name: 'Gesmine-Invest Limited',
  legalName: 'Gesmine-Invest Limited',
  url: DOMAIN + '/about/',
  identifier: { '@type': 'PropertyValue', propertyID: 'UK Company Number', value: '14120136' },
  address: { '@type': 'PostalAddress', streetAddress: 'Hardy House, 269 Poynders Gardens', addressLocality: 'London', postalCode: 'SW4 8PQ', addressCountry: 'GB' }
};

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

function formulaSection(state, rules) {
  if (state.formula_model === 'percentage_of_income') {
    const p = state.params;
    const rows = Object.entries(p.percentages)
      .map(([k, v]) => `<tr><td>${k} ${k === '1' ? 'child' : 'children'}</td><td>${(v * 100).toFixed(0)}%</td><td>${state.source.statute_ref || ''}</td></tr>`)
      .join('');
    const lowIncomeRow = p.low_income_threshold_monthly
      ? `<tr><td>Low-income threshold</td><td>$${p.low_income_threshold_monthly.toLocaleString()}/mo</td><td>${state.source.statute_ref || ''}</td></tr>`
      : '';
    const minimumRow = p.minimum_monthly
      ? `<tr><td>Minimum order</td><td>$${p.minimum_monthly.toLocaleString()}/mo</td><td>${state.source.statute_ref || ''}</td></tr>`
      : '';
    return `
  <section class="formula-section">
    <h2>How This Calculator Works — Formula &amp; Constants</h2>
    <p class="source-line">Source: ${state.source.agency_name} · Calcul déterministe — no AI, no arbitrary estimate.</p>
    <h3>Constants used</h3>
    <table>
      <tr><th>Constant</th><th>Value</th><th>Source</th></tr>
      ${rows}
      ${lowIncomeRow}
      ${minimumRow}
      <tr><td>Net income cap</td><td>$${p.net_income_cap_monthly.toLocaleString()}/mo</td><td>${state.source.statute_ref || ''}</td></tr>
    </table>
    <h3>Formula</h3>
    <div class="formula-code">
      net_resources = min(obligor_net_income, ${p.net_income_cap_monthly})<br>
      pct = (obligor_net_income &lt; ${p.low_income_threshold_monthly || 0}) ? low_income_percentages[children] : percentages[children]<br>
      monthly_support = net_resources &times; pct
    </div>
    <p class="formula-footnote">Deterministic calculation based on ${state.name}'s official guideline schedule. Verify against ${state.name}'s official calculator for a court-ready figure.</p>
  </section>`;
  }

  if (state.formula_model === 'michigan_formula') {
    const p = state.params;
    return `
  <section class="formula-section">
    <h2>How This Calculator Works — Formula &amp; Constants</h2>
    <p class="source-line">Source: ${state.source.agency_name} · Calcul déterministe — no AI, no arbitrary estimate.</p>
    <h3>Constants used</h3>
    <table>
      <tr><th>Constant</th><th>Value</th><th>Source</th></tr>
      <tr><td>Low Income Threshold</td><td>$${p.low_income_threshold_monthly.toLocaleString()}/mo</td><td>${state.source.statute_ref || ''}</td></tr>
      <tr><td>General Care Support Tables</td><td>5 tables (1-5+ children), 6 income brackets each</td><td>${state.source.statute_ref || ''}</td></tr>
    </table>
    <h3>Formula</h3>
    <div class="formula-code">
      family_income = parentA_net_income + parentB_net_income<br>
      base(parent) = (parent_income &le; ${p.low_income_threshold_monthly}) ? parent_income &times; 10% :<br>
      &nbsp;&nbsp;(BaseSupport[bracket] + MarginalPct[bracket] &times; (family_income - BracketThreshold)) &times; parent_share<br>
      Ao, Bo = each parent's annual overnights<br>
      offset = (Ao^2.5 &times; Bs - Bo^2.5 &times; As) / (Ao^2.5 + Bo^2.5)<br>
      offset &lt; 0 &rarr; Parent A pays |offset| &nbsp;·&nbsp; offset &gt; 0 &rarr; Parent B pays offset
    </div>
    <p class="formula-footnote">Deterministic calculation based on the Michigan Child Support Formula's General Care Equation and Parental Time Offset Equation (2025 MCSF §§3.02-3.03). Verify against Michigan's official calculator for a court-ready figure.</p>
  </section>`;
  }

  if (state.formula_model === 'wi_percentage_shared') {
    const p = state.params;
    const rows = Object.entries(p.percentages)
      .map(([k, v]) => `<tr><td>${k} ${k === '1' ? 'child' : 'children'}</td><td>${(v * 100).toFixed(0)}%</td><td>${state.source.statute_ref || ''}</td></tr>`)
      .join('');
    const tierRows = p.high_income_tiers.map((t, i) => {
      const label = i === 0 ? `First $${t.upTo.toLocaleString()}/mo` : (t.upTo === null ? `Above $${p.high_income_tiers[i-1].upTo.toLocaleString()}/mo` : `$${p.high_income_tiers[i-1].upTo.toLocaleString()}-$${t.upTo.toLocaleString()}/mo`);
      return `<tr><td>${label}, 2 children</td><td>${(t.pct['2'] * 100).toFixed(0)}%</td><td>${state.source.statute_ref || ''}</td></tr>`;
    }).join('');
    return `
  <section class="formula-section">
    <h2>How This Calculator Works — Formula &amp; Constants</h2>
    <p class="source-line">Source: ${state.source.agency_name} · Calcul déterministe — no AI, no arbitrary estimate.</p>
    <h3>Constants used (Percentage Standard, sole placement)</h3>
    <table>
      <tr><th>Constant</th><th>Value</th><th>Source</th></tr>
      ${rows}
    </table>
    <h3>High-income tiers (example: 2 children)</h3>
    <table>
      <tr><th>Income portion</th><th>Percentage</th><th>Source</th></tr>
      ${tierRows}
    </table>
    <h3>Formula</h3>
    <div class="formula-code">
      Sole placement (paying parent has &lt; 92 overnights/yr):<br>
      &nbsp;&nbsp;support = tieredPercent(payingParent_income, children)<br>
      Shared placement (paying parent has &ge; 92 overnights/yr, i.e. &ge;25% of the year):<br>
      &nbsp;&nbsp;line1(parent) = tieredPercent(parent_income, children)<br>
      &nbsp;&nbsp;line2(parent) = line1(parent) &times; 1.5<br>
      &nbsp;&nbsp;line3(parent) = line2(parent) &times; (share of time child spends with the OTHER parent)<br>
      &nbsp;&nbsp;support = |line3(A) - line3(B)|, paid by whichever parent's line3 is larger
    </div>
    <p class="formula-footnote">Deterministic calculation based on Wisconsin's Percentage of Income Standard (Wis. Admin. Code DCF 150). Verify against Wisconsin's official calculator for a court-ready figure.</p>
  </section>`;
  }

  if (state.formula_model === 'nv_tiered_percentage') {
    const p = state.params;
    const tierRows = p.income_tiers.map((t, i) => {
      const label = i === 0 ? `First $${t.upTo.toLocaleString()}/mo` : (t.upTo === null ? `Above $${p.income_tiers[i-1].upTo.toLocaleString()}/mo` : `$${p.income_tiers[i-1].upTo.toLocaleString()}-$${t.upTo.toLocaleString()}/mo`);
      return `<tr><td>${label}</td><td>1: ${(t.pct['1']*100).toFixed(1)}% · 2: ${(t.pct['2']*100).toFixed(1)}% · 3: ${(t.pct['3']*100).toFixed(1)}%</td><td>${state.source.statute_ref || ''}</td></tr>`;
    }).join('');
    return `
  <section class="formula-section">
    <h2>How This Calculator Works — Formula &amp; Constants</h2>
    <p class="source-line">Source: ${state.source.agency_name} · Calcul déterministe — no AI, no arbitrary estimate.</p>
    <h3>Tiered percentages by number of children (obligor's own income)</h3>
    <table>
      <tr><th>Income portion</th><th>Percentage (1 / 2 / 3 children)</th><th>Source</th></tr>
      ${tierRows}
    </table>
    <h3>Formula</h3>
    <div class="formula-code">
      support = tieredPercent(obligor_gross_income, children)<br>
      &nbsp;&nbsp;where each income tier is taxed at its own percentage and the results summed (no combined income, no schedule table)
    </div>
    <p class="formula-footnote">Deterministic calculation based on Nevada's Base Child Support Obligation (NAC 425.140). Verify against Nevada's official calculator for a court-ready figure.</p>
  </section>`;
  }

  if (state.formula_model === 'nd_obligor_schedule') {
    const nd = rules.nd_extended_parenting_time;
    return `
  <section class="formula-section">
    <h2>How This Calculator Works — Formula &amp; Constants</h2>
    <p class="source-line">Source: ${state.source.agency_name} · Calcul déterministe — no AI, no arbitrary estimate.</p>
    <h3>Constants used</h3>
    <table>
      <tr><th>Constant</th><th>Value</th><th>Source</th></tr>
      <tr><td>Extended Parenting Time threshold</td><td>${nd.extended_parenting_time_threshold_overnights} overnights/yr</td><td>${state.source.statute_ref || ''}</td></tr>
    </table>
    <h3>Formula</h3>
    <div class="formula-code">
      base_obligation = schedule_lookup(paying_parent_own_net_income, children) &nbsp;(no combined income, no proration -- the other parent's income is not used)<br>
      if paying_parent_overnights &gt; ${nd.extended_parenting_time_threshold_overnights}:<br>
      &nbsp;&nbsp;credit_factor = max(0, 365 - overnights &times; 0.32) / 365<br>
      &nbsp;&nbsp;obligation = base_obligation &times; credit_factor
    </div>
    <p class="formula-footnote">Deterministic calculation based on North Dakota's official Child Support Guidelines schedule (NDAC 75-02-04.1-10). Verify against North Dakota's official worksheet for a court-ready figure.</p>
  </section>`;
  }

  if (state.formula_model === 'algebraic_kfactor') {
    const p = state.params;
    const rows = Object.entries(p.child_multipliers)
      .map(([k, v]) => `<tr><td>Multiplier (${k} children)</td><td>&times;${v}</td><td>${state.source.statute_ref || ''}</td></tr>`)
      .join('');
    return `
  <section class="formula-section">
    <h2>How This Calculator Works — Formula &amp; Constants</h2>
    <p class="source-line">Source: ${state.source.agency_name} · Calcul déterministe — no AI, no arbitrary estimate.</p>
    <h3>Constants used</h3>
    <table>
      <tr><th>Constant</th><th>Value</th><th>Source</th></tr>
      <tr><td>K fraction, TN &le; $2,900</td><td>0.165 + TN/82,857</td><td>${state.source.statute_ref || ''}</td></tr>
      <tr><td>K fraction, $2,901-$5,000</td><td>0.131 + TN/42,149</td><td>${state.source.statute_ref || ''}</td></tr>
      <tr><td>K fraction, $5,001-$10,000</td><td>0.250 (flat)</td><td>${state.source.statute_ref || ''}</td></tr>
      <tr><td>K fraction, $10,001-$15,000</td><td>0.10 + 1,499/TN</td><td>${state.source.statute_ref || ''}</td></tr>
      <tr><td>K fraction, over $15,000</td><td>0.12 + 1,200/TN</td><td>${state.source.statute_ref || ''}</td></tr>
      ${rows}
    </table>
    <h3>Formula</h3>
    <div class="formula-code">
      TN = parentA_net_income + parentB_net_income<br>
      HN = higher_earner_net_income<br>
      K = (H% &le; 50% ? 1+H% : 2-H%) &times; k_fraction(TN)<br>
      CS_1_child = K &times; (HN - H% &times; TN)<br>
      monthly_support = CS_1_child &times; child_multiplier[children]
    </div>
    <p class="formula-footnote">Deterministic calculation based on Cal. Fam. Code § 4055, transcribed verbatim from the statute text. Verify against California's official Guideline Calculator for a court-ready figure.</p>
  </section>`;
  }

  if (state.formula_model === 'melson') {
    const p = state.params;
    return `
  <section class="formula-section">
    <h2>How This Calculator Works — Formula &amp; Constants</h2>
    <p class="source-line">Source: ${state.source.agency_name} · Calcul déterministe — no AI, no arbitrary estimate.</p>
    <h3>Constants used</h3>
    <table>
      <tr><th>Constant</th><th>Value</th><th>Source</th></tr>
      <tr><td>Self-Support Allowance</td><td>$${p.self_support_allowance_monthly.toLocaleString()}/mo</td><td>${state.source.statute_ref || ''}</td></tr>
      <tr><td>Primary allowance, per child</td><td>$${p.per_child_allowance}</td><td>${state.source.statute_ref || ''}</td></tr>
      <tr><td>Primary allowance, per household</td><td>$${p.per_household_allowance}</td><td>${state.source.statute_ref || ''}</td></tr>
      <tr><td>SOLA %, 1/2/3 children</td><td>${(p.sola_percentages['1']*100).toFixed(0)}% / ${(p.sola_percentages['2']*100).toFixed(0)}% / ${(p.sola_percentages['3']*100).toFixed(0)}%, +${(p.sola_percentage_per_additional_child*100).toFixed(0)}% each additional</td><td>${state.source.statute_ref || ''}</td></tr>
      <tr><td>High Income Offset threshold</td><td>10&times; Self-Support Allowance</td><td>${state.source.statute_ref || ''}</td></tr>
      <tr><td>Self-Support Protection</td><td>${(p.self_support_protection_pct*100).toFixed(0)}% of paying parent's Net Available Income</td><td>${state.source.statute_ref || ''}</td></tr>
    </table>
    <h3>Formula (the Melson Formula)</h3>
    <div class="formula-code">
      NAI(parent) = max(0, gross_income(parent) - Self-Support Allowance)<br>
      share(parent) = NAI(parent) / combined NAI<br>
      Primary Need = children &times; per-child allowance + per-household allowance + childcare + health insurance<br>
      Primary Obligation(parent) = share(parent) &times; Primary Need<br>
      NAI for SOLA(parent) = NAI(parent) - Primary Obligation(parent)<br>
      High Income Offset = 30% &times; combined excess above 10&times; Self-Support Allowance<br>
      SOLA = (combined NAI for SOLA - High Income Offset) &times; SOLA%<br>
      support = paying parent's (Primary Obligation + share of SOLA)
    </div>
    <p class="formula-footnote">Deterministic calculation based on ${state.name}'s Melson Formula. Verify against ${state.name}'s official calculator for a court-ready figure.</p>
  </section>`;
  }

  if (state.formula_model === 'hi_melson') {
    const p = state.params;
    return `
  <section class="formula-section">
    <h2>How This Calculator Works — Formula &amp; Constants</h2>
    <p class="source-line">Source: ${state.source.agency_name} · Calcul déterministe — no AI, no arbitrary estimate.</p>
    <h3>Constants used</h3>
    <table>
      <tr><th>Constant</th><th>Value</th><th>Source</th></tr>
      <tr><td>Self-Support Reserve</td><td>$${p.self_support_reserve_monthly.toLocaleString()}/mo</td><td>${state.source.statute_ref || ''}</td></tr>
      <tr><td>Base Primary Support, per child</td><td>$${p.base_primary_support_per_child}</td><td>${state.source.statute_ref || ''}</td></tr>
      <tr><td>SOLA income deduction</td><td>$${p.sola_income_deduction.toLocaleString()}/mo</td><td>${state.source.statute_ref || ''}</td></tr>
      <tr><td>SOLA %, per child (capped)</td><td>${(p.sola_percentage_per_child*100).toFixed(0)}% per child, max ${(p.sola_percentage_max*100).toFixed(0)}%</td><td>${state.source.statute_ref || ''}</td></tr>
      <tr><td>Minimum order</td><td>$${p.minimum_per_child}/child/mo</td><td>${state.source.statute_ref || ''}</td></tr>
    </table>
    <h3>Formula (Hawaii's Modified Melson Formula)</h3>
    <div class="formula-code">
      Net Income(parent) = max(0, gross_income(parent) - Self-Support Reserve)<br>
      share(parent) = Net Income(parent) / combined Net Income<br>
      Primary Need = children &times; Base Primary Support + childcare + health insurance<br>
      SOLA Income(parent) = max(0, gross_income(parent) - SOLA income deduction)<br>
      Remaining SOLA = max(0, combined SOLA Income - Primary Need)<br>
      SOLA Amount = Remaining SOLA &times; min(30%, 10% &times; children)<br>
      support = min(paying parent's Net Income, paying parent's share &times; (Primary Need + SOLA Amount))
    </div>
    <p class="formula-footnote">Deterministic calculation based on Hawaii's Modified Melson Formula. Verify against Hawaii's official CSG Worksheet for a court-ready figure.</p>
  </section>`;
  }

  if (state.formula_model === 'mt_melson') {
    const p = state.params;
    const primaryRows = Object.entries(p.primary_allowance_monthly)
      .map(([k, v]) => `<tr><td>${k} ${k === '1' ? 'child' : 'children'}</td><td>$${v.toLocaleString()}/mo</td><td>${state.source.statute_ref || ''}</td></tr>`).join('');
    const solaRows = Object.entries(p.sola_factors)
      .map(([k, v]) => `<tr><td>${k} ${k === '1' ? 'child' : 'children'}</td><td>${(v*100).toFixed(0)}%</td><td>${state.source.statute_ref || ''}</td></tr>`).join('');
    return `
  <section class="formula-section">
    <h2>How This Calculator Works — Formula &amp; Constants</h2>
    <p class="source-line">Source: ${state.source.agency_name} · Calcul déterministe — no AI, no arbitrary estimate.</p>
    <h3>Constants used</h3>
    <table>
      <tr><th>Constant</th><th>Value</th><th>Source</th></tr>
      <tr><td>Personal Allowance</td><td>$${p.personal_allowance_monthly.toLocaleString()}/mo</td><td>${state.source.statute_ref || ''}</td></tr>
      ${primaryRows}
      ${solaRows}
      <tr><td>Minimum contribution (above Personal Allowance)</td><td>${(p.minimum_contribution_pct*100).toFixed(0)}% of income after Personal Allowance</td><td>${state.source.statute_ref || ''}</td></tr>
    </table>
    <h3>Formula (Montana's Modified Melson Formula)</h3>
    <div class="formula-code">
      NAI(parent) = max(0, gross_income(parent) - Personal Allowance)<br>
      share(parent) = NAI(parent) / combined NAI<br>
      Primary Allowance = table[children] + childcare + health insurance<br>
      Primary Share(parent) = share(parent) &times; Primary Allowance<br>
      SOLA(parent) = max(0, NAI(parent) - Primary Share(parent)) &times; SOLA factor[children]<br>
      support = max(Primary Share(parent) + SOLA(parent), 12% &times; NAI(parent))
    </div>
    <p class="formula-footnote">Deterministic calculation based on Montana's Modified Melson Formula (ARM 37.62). Verify against Montana's official worksheet for a court-ready figure.</p>
  </section>`;
  }

  if (state.formula_model === 'ks_age_schedule') {
    const ks = rules.ks_age_schedule;
    const ptRows = ks.parenting_time_adjustment_table
      .map(t => `<tr><td>${t.minPct}-${t.maxPct}% nonresidential parenting time</td><td>${(t.reductionPct * 100).toFixed(0)}% reduction</td><td>${state.source.statute_ref || ''}</td></tr>`).join('');
    return `
  <section class="formula-section">
    <h2>How This Calculator Works — Formula &amp; Constants</h2>
    <p class="source-line">Source: ${state.source.agency_name} · Calcul déterministe — no AI, no arbitrary estimate.</p>
    <h3>Constants used</h3>
    <table>
      <tr><th>Constant</th><th>Value</th><th>Source</th></tr>
      <tr><td>Age 0-5 multiplier</td><td>${ks.age_multipliers['0-5']} &times; the 12-18 base amount</td><td>${state.source.statute_ref || ''}</td></tr>
      <tr><td>Age 6-11 multiplier</td><td>${ks.age_multipliers['6-11']} &times; the 12-18 base amount</td><td>${state.source.statute_ref || ''}</td></tr>
      <tr><td>Extended-formula exponent (above $18,000 combined income)</td><td>income ^ ${ks.extended_formula_exponent}</td><td>${state.source.statute_ref || ''}</td></tr>
      ${ptRows}
    </table>
    <h3>Formula</h3>
    <div class="formula-code">
      combined_income = parentA_income + parentB_income<br>
      base_12to18 = schedule_lookup(combined_income, total_children) &nbsp;(or coefficient[children] &times; combined_income^${ks.extended_formula_exponent} above $18,000)<br>
      per_child_0to5 = round(base_12to18 &times; ${ks.age_multipliers['0-5']}), per_child_6to11 = round(base_12to18 &times; ${ks.age_multipliers['6-11']})<br>
      base_obligation = sum of each child's per-child amount for their own age bracket<br>
      share_B = parentB_income / combined_income<br>
      obligation_B = base_obligation &times; share_B &times; (1 - parenting_time_reduction)
    </div>
    <p class="formula-footnote">Deterministic calculation based on Kansas's official age-differentiated child support schedule (Appendix II). Verify against Kansas's official worksheet for a court-ready figure.</p>
  </section>`;
  }

  if (state.formula_model === 'id_bracket_shares') {
    const id = rules.id_brackets;
    const bracketRows = id.schedules['2']
      .map((b, i) => `<tr><td>Bracket ${i + 1} (2 children)</td><td>${(b.pct * 100).toFixed(0)}% of ${b.width >= 100000 ? 'the next $' + b.width.toLocaleString() : '$' + b.width.toLocaleString()}</td><td>${state.source.statute_ref || ''}</td></tr>`).join('');
    return `
  <section class="formula-section">
    <h2>How This Calculator Works — Formula &amp; Constants</h2>
    <p class="source-line">Source: ${state.source.agency_name} · Calcul déterministe — no AI, no arbitrary estimate.</p>
    <h3>Constants used (2-children bracket schedule shown as an example -- 1, 3, 4, and 5-children schedules use different rates)</h3>
    <table>
      <tr><th>Bracket</th><th>Rate</th><th>Source</th></tr>
      ${bracketRows}
      <tr><td>Max combined annual income</td><td>$${id.max_annual_combined_income.toLocaleString()}/yr</td><td>${state.source.statute_ref || ''}</td></tr>
      <tr><td>Self-support review threshold</td><td>$${id.self_support_review_threshold_monthly.toLocaleString()}/mo (paying parent)</td><td>${state.source.statute_ref || ''}</td></tr>
      <tr><td>Presumptive minimum</td><td>$${id.minimum_per_child_monthly}/child/mo</td><td>${state.source.statute_ref || ''}</td></tr>
    </table>
    <h3>Formula</h3>
    <div class="formula-code">
      annual_combined_income = (parentA_income + parentB_income) &times; 12<br>
      basic_obligation = sum of each bracket's rate &times; the portion of annual_combined_income within that bracket (like a tax bracket), &divide; 12<br>
      share_B = parentB_income / combined_income<br>
      If either parent has 25% or less of the overnights: obligation_B = (basic_obligation + add-ons) &times; share_B<br>
      If both parents have more than 25%: pool = basic_obligation &times; 1.5; each parent's amount = pool &times; their income share &times; the OTHER parent's overnight share; the two amounts are offset (capped at the sole-custody amount)
    </div>
    <p class="formula-footnote">Deterministic calculation based on Idaho's official marginal-bracket child support schedule (Rule 120). Verify against Idaho's official worksheet for a court-ready figure.</p>
  </section>`;
  }

  if (state.formula_model === 'me_weekly_table_annual_income') {
    const me = rules.me_self_support_reserve;
    return `
  <section class="formula-section">
    <h2>How This Calculator Works — Formula &amp; Constants</h2>
    <p class="source-line">Source: ${state.source.agency_name} · Calcul déterministe — no AI, no arbitrary estimate.</p>
    <h3>Constants used</h3>
    <table>
      <tr><th>Constant</th><th>Value</th><th>Source</th></tr>
      <tr><td>Self-Support Reserve ceiling</td><td>$${me.self_support_reserve_ceiling_annual.toLocaleString()}/yr (paying parent's own income)</td><td>${state.source.statute_ref || ''}</td></tr>
      <tr><td>Combined income cap</td><td>$400,000/yr (presumptive minimum above this)</td><td>${state.source.statute_ref || ''}</td></tr>
    </table>
    <h3>Formula</h3>
    <div class="formula-code">
      combined_annual_income = parentA_annual_income + parentB_annual_income<br>
      weekly_basic_entitlement = schedule_lookup(combined_annual_income, children) &nbsp;(Maine's table axis is annual income, but its cell values are WEEKLY dollars)<br>
      monthly_basic_entitlement = weekly_basic_entitlement &times; 52 &divide; 12<br>
      share_B = parentB_annual_income / combined_annual_income<br>
      obligation_B = (monthly_basic_entitlement + monthly_add_ons) &times; share_B
    </div>
    <p class="formula-footnote">Deterministic calculation based on Maine's official Schedule of Basic Support Obligation (19-A M.R.S. § 2006). Verify against Maine's official worksheet for a court-ready figure.</p>
  </section>`;
  }

  if (state.formula_model === 'ma_table_a_shares') {
    const ma = rules.ma_table_a;
    return `
  <section class="formula-section">
    <h2>How This Calculator Works — Formula &amp; Constants</h2>
    <p class="source-line">Source: ${state.source.agency_name} · Calcul déterministe — no AI, no arbitrary estimate.</p>
    <h3>Constants used</h3>
    <table>
      <tr><th>Constant</th><th>Value</th><th>Source</th></tr>
      <tr><td>Number-of-children multiplier (Table B)</td><td>1.00 / 1.40 / 1.68 / 1.85 / 1.94 (1-5 children)</td><td>${state.source.statute_ref || ''}</td></tr>
      <tr><td>Self-Support Reserve</td><td>$${ma.self_support_reserve_weekly}/week (paying parent's own income)</td><td>${state.source.statute_ref || ''}</td></tr>
      <tr><td>Max combined available income</td><td>$${ma.max_weekly_combined_income.toLocaleString()}/week (~$450,000/yr)</td><td>${state.source.statute_ref || ''}</td></tr>
    </table>
    <h3>Formula (Table A, exact piecewise function)</h3>
    <div class="formula-code">
      base_1_child = Table A(combined_weekly_income) &nbsp;-- a piecewise-linear function, e.g. $346 + 18% of the amount over $1,600 for incomes $1,601-$2,400<br>
      combined_support = round(base_1_child &times; number_of_children_multiplier)<br>
      share_B = parentB_income / combined_income<br>
      obligation_B = (combined_support + add-ons) &times; share_B
    </div>
    <p class="formula-footnote">Deterministic calculation based on Massachusetts's official Child Support Guidelines Worksheet (CJD 304). Verify against the official worksheet for a court-ready figure.</p>
  </section>`;
  }

  // income_shares (schedule-table based)
  const p = state.params;
  const custody = rules.custody_adjustment;
  const isPercentageOfCombined = p.schedule_type === 'percentage';
  return `
  <section class="formula-section">
    <h2>How This Calculator Works — Formula &amp; Constants</h2>
    <p class="source-line">Source: ${state.source.agency_name} · Calcul déterministe — no AI, no arbitrary estimate.</p>
    <h3>Constants used</h3>
    <table>
      <tr><th>Constant</th><th>Value</th><th>Source</th></tr>
      ${isPercentageOfCombined ? Object.entries(p.percentages_of_combined).map(([k, v]) => `<tr><td>${k} ${k === '1' ? 'child' : 'children'}</td><td>${(v * 100).toFixed(0)}%</td><td>${state.source.statute_ref || ''}</td></tr>`).join('') : ''}
      ${isPercentageOfCombined ? `<tr><td>Combined income cap</td><td>$${p.combined_income_cap_monthly.toLocaleString()}/mo</td><td>${state.source.statute_ref || ''}</td></tr>` : ''}
      ${p.self_support_reserve_monthly ? `<tr><td>Self-support reserve</td><td>$${p.self_support_reserve_monthly.toLocaleString()}/mo</td><td>${state.source.statute_ref || ''}</td></tr>` : ''}
      ${custody && custody.type === 'overnights_threshold' ? `<tr><td>Overnights threshold</td><td>${custody.threshold} nights/yr</td><td>${state.source.statute_ref || ''}</td></tr>` : ''}
      ${custody && custody.type === 'graduated_overnight_credit' ? `<tr><td>Custody adjustment</td><td>Graduated overnight-credit table</td><td>${state.source.statute_ref || ''}</td></tr>` : ''}
      ${custody && custody.type === 'stepped_days_table' ? `<tr><td>Custody adjustment</td><td>Parenting Time Table (step function by day-range)</td><td>${state.source.statute_ref || ''}</td></tr>` : ''}
      ${state.formula_model === 'melson' && p.sola_percentage ? `<tr><td>Standard-of-living adjustment</td><td>${(p.sola_percentage * 100).toFixed(0)}%</td><td>${state.source.statute_ref || ''}</td></tr>` : ''}
    </table>
    <h3>Formula</h3>
    <div class="formula-code">
      combined_income = parentA_income + parentB_income<br>
      base_obligation = ${isPercentageOfCombined ? 'min(combined_income, cap) &times; percentages_of_combined[children]' : 'schedule_lookup(combined_income, children)'}<br>
      share_B = parentB_income / combined_income<br>
      total_obligation = base_obligation + childcare_cost + health_insurance_cost<br>
      obligation_B = total_obligation &times; share_B${custody ? '<br>obligation_B = obligation_B &times; (1 - custody_credit(overnights))' : ''}${state.formula_model === 'melson' ? '<br>obligation_B += obligation_B &times; sola_percentage' : ''}
    </div>
    <p class="formula-footnote">Deterministic calculation based on ${state.name}'s official guideline schedule table. Verify against ${state.name}'s official calculator for a court-ready figure.</p>
  </section>`;
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
  if (state.formula_model === 'algebraic_kfactor') {
    return `
      <label>Parent A net monthly income ($)
        <input type="number" id="parentANetIncome" min="0" step="1" value="4000">
      </label>
      <label>Parent B net monthly income ($)
        <input type="number" id="parentBNetIncome" min="0" step="1" value="3000">
      </label>
      <label>Number of children
        <select id="numChildren">
          <option value="1">1</option><option value="2">2</option><option value="3">3</option>
          <option value="4">4</option><option value="5">5</option><option value="6">6</option>
          <option value="7">7</option><option value="8">8</option><option value="9">9</option>
          <option value="10">10 or more</option>
        </select>
      </label>
      <label>Higher earner's custody timeshare (%)
        <input type="number" id="higherEarnerTimesharePct" min="0" max="100" step="1" value="50">
      </label>`;
  }
  if (state.formula_model === 'michigan_formula') {
    return `
      <label>Parent A net monthly income ($)
        <input type="number" id="parentANetIncome" min="0" step="1" value="4000">
      </label>
      <label>Parent B net monthly income ($)
        <input type="number" id="parentBNetIncome" min="0" step="1" value="3000">
      </label>
      <label>Number of children
        <select id="numChildren">
          <option value="1">1</option><option value="2">2</option><option value="3">3</option>
          <option value="4">4</option><option value="5">5 or more</option>
        </select>
      </label>
      <label>Annual overnights with Parent A
        <input type="number" id="overnightsWithA" min="0" max="365" step="1" value="182">
      </label>`;
  }
  if (state.formula_model === 'wi_percentage_shared') {
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
          <option value="4">4</option><option value="5">5 or more</option>
        </select>
      </label>
      <label>Annual overnights with Parent A
        <input type="number" id="overnightsWithA" min="0" max="365" step="1" value="182">
      </label>`;
  }
  if (state.formula_model === 'nv_tiered_percentage') {
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
      <label>Annual overnights with Parent A
        <input type="number" id="overnightsWithA" min="0" max="365" step="1" value="182">
      </label>`;
  }
  if (state.formula_model === 'nd_obligor_schedule') {
    return `
      <label>Parent A net monthly income ($)
        <input type="number" id="parentAGrossIncome" min="0" step="1" value="4000">
      </label>
      <label>Parent B net monthly income ($)
        <input type="number" id="parentBGrossIncome" min="0" step="1" value="3000">
      </label>
      <label>Number of children
        <select id="numChildren">
          <option value="1">1</option><option value="2">2</option><option value="3">3</option>
          <option value="4">4</option><option value="5">5</option><option value="6">6 or more</option>
        </select>
      </label>
      <label>Annual overnights with Parent A
        <input type="number" id="overnightsWithA" min="0" max="365" step="1" value="182">
      </label>`;
  }

  if (state.formula_model === 'ks_age_schedule') {
    return `
      <label>Parent A gross monthly income ($)
        <input type="number" id="parentAGrossIncome" min="0" step="1" value="4000">
      </label>
      <label>Parent B gross monthly income ($)
        <input type="number" id="parentBGrossIncome" min="0" step="1" value="3000">
      </label>
      <label>Number of children age 0-5
        <input type="number" id="children0to5" min="0" step="1" value="0">
      </label>
      <label>Number of children age 6-11
        <input type="number" id="children6to11" min="0" step="1" value="1">
      </label>
      <label>Number of children age 12-18
        <input type="number" id="children12to18" min="0" step="1" value="0">
      </label>
      <label>Annual overnights with Parent A
        <input type="number" id="overnightsWithA" min="0" max="365" step="1" value="182">
      </label>`;
  }

  // income_shares and melson share the same form shape
  const incomeLabel = state.params.income_basis === 'net' ? 'net' : 'gross';
  const period = state.params.income_period === 'weekly' ? 'weekly' : (state.params.income_period === 'annual' ? 'annual' : 'monthly');
  const childCountOptions = state.formula_model === 'income_shares' && state.params.schedule_table_ref === 'indiana_schedule.json'
    ? '<option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option><option value="5">5</option><option value="6">6</option><option value="7">7</option><option value="8">8 or more</option>'
    : '<option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="4">4</option><option value="5">5</option><option value="6">6 or more</option>';
  return `
      <label>Parent A ${incomeLabel} ${period} income ($)
        <input type="number" id="parentAGrossIncome" min="0" step="1" value="4000">
      </label>
      <label>Parent B ${incomeLabel} ${period} income ($)
        <input type="number" id="parentBGrossIncome" min="0" step="1" value="3000">
      </label>
      <label>Number of children
        <select id="numChildren">
          ${childCountOptions}
        </select>
      </label>
      <label>Overnights per year with Parent A
        <input type="number" id="overnightsWithA" min="0" max="365" step="1" value="182">
      </label>
      <label>${period === 'weekly' ? 'Weekly' : (period === 'annual' ? 'Annual' : 'Monthly')} childcare cost ($)
        <input type="number" id="childcareCost" min="0" step="1" value="0">
      </label>
      <label>${period === 'weekly' ? 'Weekly' : (period === 'annual' ? 'Annual' : 'Monthly')} health insurance premium for child(ren) ($)
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
      if (STATE_ENTRY.formula_model === 'algebraic_kfactor') {
        return {
          parentANetIncome: Number(document.getElementById('parentANetIncome').value) || 0,
          parentBNetIncome: Number(document.getElementById('parentBNetIncome').value) || 0,
          numChildren: Number(document.getElementById('numChildren').value) || 1,
          higherEarnerTimesharePct: (Number(document.getElementById('higherEarnerTimesharePct').value) || 0) / 100
        };
      }
      if (STATE_ENTRY.formula_model === 'michigan_formula') {
        return {
          parentANetIncome: Number(document.getElementById('parentANetIncome').value) || 0,
          parentBNetIncome: Number(document.getElementById('parentBNetIncome').value) || 0,
          numChildren: Number(document.getElementById('numChildren').value) || 1,
          overnightsWithA: Number(document.getElementById('overnightsWithA').value) || 0
        };
      }
      if (STATE_ENTRY.formula_model === 'ks_age_schedule') {
        return {
          parentAGrossIncome: Number(document.getElementById('parentAGrossIncome').value) || 0,
          parentBGrossIncome: Number(document.getElementById('parentBGrossIncome').value) || 0,
          children0to5: Number(document.getElementById('children0to5').value) || 0,
          children6to11: Number(document.getElementById('children6to11').value) || 0,
          children12to18: Number(document.getElementById('children12to18').value) || 0,
          overnightsWithA: Number(document.getElementById('overnightsWithA').value) || 0
        };
      }
      if (STATE_ENTRY.formula_model === 'wi_percentage_shared' || STATE_ENTRY.formula_model === 'nv_tiered_percentage' || STATE_ENTRY.formula_model === 'nd_obligor_schedule') {
        return {
          parentAGrossIncome: Number(document.getElementById('parentAGrossIncome').value) || 0,
          parentBGrossIncome: Number(document.getElementById('parentBGrossIncome').value) || 0,
          numChildren: Number(document.getElementById('numChildren').value) || 1,
          overnightsWithA: Number(document.getElementById('overnightsWithA').value) || 0
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
      var payerLabel = result.payingParent ? (result.payingParent === 'A' ? 'Parent A pays: ' : 'Parent B pays: ') : '';
      var periodLabel = (STATE_ENTRY.params && STATE_ENTRY.params.income_period === 'weekly') ? '/week' : '/month';
      document.getElementById('result-amount').textContent = payerLabel + '$' + result.monthlyAmount.toLocaleString() + periodLabel;
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
    document.getElementById('print-btn').addEventListener('click', function() { window.print(); });
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
        dateModified: state.last_verified,
        author: GESMINE_ORG,
        publisher: GESMINE_ORG,
        version: state.guideline_version
      },
      {
        '@type': 'FAQPage',
        mainEntity: [
          {
            '@type': 'Question',
            name: `How is child support calculated in ${state.name}?`,
            acceptedAnswer: { '@type': 'Answer', text: state.worksheet.steps.join(' ') }
          },
          ...(state.faq_extra || []).map(item => ({
            '@type': 'Question',
            name: item.q,
            acceptedAnswer: { '@type': 'Answer', text: item.a }
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

function relatedToolsSection(state, rules) {
  const links = [];
  if (rules.custody_adjustment) {
    links.push('<li><a href="/joint-custody-child-support-calculator/">Joint Custody Child Support Calculator</a> — how shared parenting time changes this calculation</li>');
  }
  const p = state.params || {};
  if (p.net_income_cap_monthly || p.combined_income_cap_monthly || p.income_cap_annual) {
    links.push('<li><a href="/high-income-child-support-calculator/">High Income Child Support Calculator</a> — how this state\'s income cap works</li>');
  }
  links.push('<li><a href="/military-child-support-calculator/">Military Child Support Calculator</a> — BAH/BAS and other military pay as income</li>');
  if (!links.length) return '';
  return `
  <section>
    <h2>Related Tools</h2>
    <ul>${links.join('')}</ul>
  </section>`;
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
  <p class="verified-badge">✓ Cross-checked against ${state.name}'s official calculator/worksheet — see our <a href="/about/">verification methodology</a></p>
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
    <p class="print-only-meta">${state.name} Child Support Calculator · ${state.guideline_version} guidelines, effective ${state.effective_date} · Source: ${state.source.agency_name}${state.source.statute_ref ? ` (${state.source.statute_ref})` : ''} · usachildsupportcalculator.com/${state.slug}/</p>
    <button type="button" id="print-btn" class="no-print">Print / Save as PDF</button>
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

  ${formulaSection(state, rules)}

  <section>
    <h2>FAQ</h2>
    <details><summary>How is child support calculated in ${state.name}?</summary><p>${state.worksheet.steps.join(' ')}</p></details>
    ${(state.faq_extra || []).map(item => `<details><summary>${item.q}</summary><p>${item.a}</p></details>`).join('')}
  </section>

  <section class="methodology">
    <h2>Methodology &amp; Source</h2>
    <p>Formula model: ${state.formula_model.replace(/_/g, ' ')}. Effective ${state.effective_date}, guideline version ${state.guideline_version}, last reviewed ${state.last_verified}.</p>
    <p>Official source: <a href="${state.source.url}" rel="nofollow noopener">${state.source.agency_name}</a>${state.source.statute_ref ? ` (${state.source.statute_ref})` : ''}.</p>
    <p class="deviation-note">${rules.deviation_note}</p>
    <p class="verified-by">Guideline figures transcribed from the primary source above and cross-checked against ${state.name}'s official calculator/worksheet for multiple test scenarios — see our <a href="/about/">verification methodology</a>.</p>
  </section>

  ${relatedToolsSection(state, rules)}
</main>

<footer>
  <p>USA Child Support Calculator is part of Gesmine-Invest Limited, registered UK company number 14120136, registered office address at Hardy House, 269 Poynders Gardens, London, London, United Kingdom, SW4 8PQ.</p>
  <p><a href="/about/">About</a> · <a href="/privacy/">Privacy</a> · <a href="/changelog/">Changelog</a> · &copy; ${YEAR} USA Child Support Calculator. Estimates only — not legal advice.</p>
</footer>

${calculatorScript(state)}
</body>
</html>`;
}

const SATELLITE_CONTENT = {
  'joint-custody': {
    intro: 'Joint custody — also called shared physical custody or shared parenting time — changes how child support is calculated in most states. Once the parent with fewer overnights crosses a state-specific threshold (commonly somewhere between 92 and 182 nights a year, depending on the state), most guideline formulas apply a parenting-time credit or switch to a shared-custody worksheet instead of the standard sole-custody calculation.',
    detail: 'There is no single "joint custody formula" that applies nationwide — each state defines its own overnight threshold and its own adjustment method (a flat percentage credit, a graduated table, or a full alternate worksheet). Rather than guess at a generic number, use your state\'s calculator below: every calculator on this site that has a custody adjustment already asks for annual overnights with each parent and applies that state\'s specific formula automatically — the same mechanism, sourced from the same statute, as our standard state pages.',
    faqs: [
      { q: 'What overnight count counts as "joint custody"?', a: 'There is no universal number — states set their own thresholds, and some don\'t use a fixed threshold at all (using a sliding scale instead). Enter your actual annual overnights into your state\'s calculator and it will apply whatever rule that state uses.' },
      { q: 'Does 50/50 custody mean no child support is owed?', a: 'No. Even at exactly equal overnights, the parent with the higher income (or higher income share) typically still owes some support, because most formulas prorate the total obligation by each parent\'s income share before applying any custody credit.' },
      { q: 'Which states have the most generous shared-custody credit?', a: 'This varies by state and by income level, not just by which state you\'re in — the fairest way to compare is to run your actual numbers through each state\'s calculator rather than rely on a general ranking.' }
    ]
  },
  'high-income': {
    intro: 'High-income child support cases don\'t just multiply the standard percentage by a bigger paycheck. Many states cap the income used in the guideline formula at a specific dollar figure — above that cap, courts have discretion to order more based on the child\'s actual proven needs, rather than a mechanical formula continuing upward.',
    detail: 'The table below lists every state on this site with an explicit, sourced income cap in its guideline formula. States not listed either use a schedule table that extends to a very high top bracket, or a formula (like Wisconsin\'s or Nevada\'s tiered percentage) that has no hard ceiling at all — see that state\'s own page for the exact mechanism, sourced from its statute.',
    faqs: [
      { q: 'What happens to income above the cap?', a: 'In capped states, the guideline formula stops increasing once income crosses the cap — courts may still order additional support above the guideline amount, but that requires a judicial finding based on the child\'s needs, not an automatic formula extension.' },
      { q: 'Is "high income" the same threshold in every state?', a: 'No — the cap (where one exists) is set independently by each state\'s statute or guideline body and is not indexed to a federal standard.' }
    ]
  },
  'military': {
    intro: 'Calculating child support for an active-duty service member follows the same state guideline formula as any other case — the complication is almost always about what counts as income, not a different formula. Basic Allowance for Housing (BAH) and Basic Allowance for Subsistence (BAS) are non-taxable, but nearly every state guideline treats them as income available for support because they represent real, spendable value even though they aren\'t wages in the traditional sense.',
    detail: 'To calculate support for a military family, use the same state calculator you\'d use for any case — just include BAH, BAS, and any other regular allowances or special/incentive pay (flight pay, hazardous duty pay, etc.) in the income field alongside base pay, unless you\'ve confirmed with your state\'s own guidance that a specific allowance is excluded. Overseas or duty-station moves can also affect which state\'s guidelines apply — that\'s a jurisdiction question for a military legal assistance office (JAG) or a family law attorney, not something a calculator can resolve.',
    faqs: [
      { q: 'Do I include BAH and BAS as income?', a: 'In nearly every state, yes — these allowances are excluded from federal income tax but are still counted as income for child support purposes because they reduce the service member\'s out-of-pocket housing and food costs.' },
      { q: 'Which state\'s guidelines apply if I\'m stationed elsewhere?', a: 'This is a legal jurisdiction question (often governed by the Servicemembers Civil Relief Act and each state\'s own child support jurisdiction rules), not a calculator question — consult a military legal assistance office (JAG) or a family law attorney before assuming which state\'s formula applies to your case.' }
    ]
  }
};

function renderSatellitePage(key, meta) {
  const content = SATELLITE_CONTENT[key];
  const sortedStates = Object.values(states).slice().sort((a, b) => a.name.localeCompare(b.name));
  const stateLinks = sortedStates.map(s => `<li><a href="/${s.slug}/">${s.name}</a></li>`).join('');

  let extraSection = '';
  if (key === 'high-income') {
    const capRows = sortedStates
      .map(s => {
        const p = s.params || {};
        let cap = null;
        if (p.net_income_cap_monthly) cap = `$${p.net_income_cap_monthly.toLocaleString()}/mo (net income)`;
        else if (p.combined_income_cap_monthly) cap = `$${p.combined_income_cap_monthly.toLocaleString()}/mo (combined income)`;
        else if (p.income_cap_annual) cap = `$${p.income_cap_annual.toLocaleString()}/yr (combined income)`;
        return cap ? `<tr><td><a href="/${s.slug}/">${s.name}</a></td><td>${cap}</td><td>${s.source.statute_ref || ''}</td></tr>` : null;
      })
      .filter(Boolean)
      .join('');
    extraSection = `
  <section>
    <h2>States with an explicit guideline income cap</h2>
    <table>
      <tr><th>State</th><th>Cap</th><th>Source</th></tr>
      ${capRows}
    </table>
  </section>`;
  }

  const faqJsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'FAQPage',
        mainEntity: content.faqs.map(item => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.a }
        }))
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${DOMAIN}/` },
          { '@type': 'ListItem', position: 2, name: meta.title, item: `${DOMAIN}/${meta.slug}/` }
        ]
      }
    ]
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${meta.title} ${YEAR} — Free by-State Guide</title>
<meta name="description" content="${meta.title}: how ${key.replace(/-/g, ' ')} affects your state's official child support guideline formula, with links to every state's sourced calculator.">
<link rel="canonical" href="${DOMAIN}/${meta.slug}/">
<link rel="stylesheet" href="/assets/styles.css">
<meta property="og:title" content="${meta.title}">
<meta property="og:description" content="How ${key.replace(/-/g, ' ')} affects child support calculations, with links to every state's official-guideline calculator.">
<meta property="og:url" content="${DOMAIN}/${meta.slug}/">
<meta property="og:type" content="website">
<script type="application/ld+json">${JSON.stringify(faqJsonLd)}</script>
</head>
<body>
<header>
  <a href="/">← All States</a>
  <h1>${meta.title}</h1>
  <p class="badge">Guide, not a separate formula — pick your state below for a sourced, state-specific calculation</p>
</header>

<div class="disclaimer-banner">
  Estimate only — not legal advice. Every calculation on this site uses that state's own published child support guidelines. For your official calculation, consult a family law attorney or your state's child support agency.
</div>

<main>
  <section>
    <h2>${meta.title}: how it works</h2>
    <p>${content.intro}</p>
    <p>${content.detail}</p>
  </section>

  ${extraSection}

  <section>
    <h2>Choose your state</h2>
    <ul class="state-link-list">${stateLinks}</ul>
  </section>

  <section>
    <h2>FAQ</h2>
    ${content.faqs.map(item => `<details><summary>${item.q}</summary><p>${item.a}</p></details>`).join('')}
  </section>
</main>

<footer>
  <p>USA Child Support Calculator is part of Gesmine-Invest Limited, registered UK company number 14120136, registered office address at Hardy House, 269 Poynders Gardens, London, London, United Kingdom, SW4 8PQ.</p>
  <p><a href="/about/">About</a> · <a href="/privacy/">Privacy</a> · <a href="/changelog/">Changelog</a> · &copy; ${YEAR} USA Child Support Calculator. Estimates only — not legal advice.</p>
</footer>
</body>
</html>`;
}

function renderArrearsPage() {
  const rates = require('./data/arrears-interest-rates.json');
  const availableStates = Object.keys(rates)
    .map(slug => states[Object.keys(states).find(k => states[k].slug === slug)])
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
  const options = availableStates.map(s => `<option value="${s.slug}">${s.name}</option>`).join('');
  const stateNotes = availableStates.map(s => {
    const r = rates[s.slug];
    return `<div class="arrears-state-note" data-state="${s.slug}" hidden>
      <p><strong>${s.name}:</strong> ${r.annual_rate_pct}%/year${r.compounds ? ' (compounds — this calculator computes simple interest only, see note below)' : ' simple interest'}.
      ${r.automatic_accrual ? '' : ' <strong>Not automatic</strong> — a court finding or request is required before interest accrues in this state.'}</p>
      <p class="deviation-note">${r.notes}</p>
      <p class="verified-by">Source: <a href="${r.source_url}" rel="nofollow noopener">${r.source_agency}</a> (${r.statute_ref}). Rate last verified ${r.verified_date}.</p>
    </div>`;
  }).join('');

  const rowsList = availableStates.map(s => {
    const r = rates[s.slug];
    return `<tr><td><a href="/${s.slug}/">${s.name}</a></td><td>${r.annual_rate_pct}%/yr</td><td>${r.automatic_accrual ? 'Automatic' : 'Requires court finding/request'}</td><td>${r.statute_ref}</td></tr>`;
  }).join('');

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', name: 'Does every state charge interest on unpaid child support?', acceptedAnswer: { '@type': 'Answer', text: 'No. Some states apply interest automatically once a payment is missed; others require the receiving parent or child support agency to specifically request it, and a court to grant it. Check your state\'s row in the table on this page.' } },
      { '@type': 'Question', name: 'Does interest on child support arrears compound?', acceptedAnswer: { '@type': 'Answer', text: 'It varies by state. A few states compound interest (added to principal periodically, then earning interest itself); this calculator computes simple interest only, so your real balance may be higher in a compounding state.' } }
    ]
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Child Support Arrears Calculator ${YEAR} — Interest on Unpaid Support</title>
<meta name="description" content="Estimate interest on unpaid (past-due) child support using your state's official statutory interest rate, sourced and cited per state.">
<link rel="canonical" href="${DOMAIN}/child-support-arrears-calculator/">
<link rel="stylesheet" href="/assets/styles.css">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body>
<header>
  <a href="/">← All States</a>
  <h1>Child Support Arrears Calculator</h1>
  <p class="badge">Estimate interest on past-due child support using your state's own statutory rate</p>
</header>

<div class="disclaimer-banner">
  Estimate only — not legal advice. Interest rules on child support arrears vary widely by state, including whether interest is automatic and whether it compounds. Consult your state's child support agency or a family law attorney for your official arrears balance.
</div>

<main>
  <form id="arrears-form">
    <label>State
      <select id="arrearsState">${options}</select>
    </label>
    <label>Unpaid principal amount ($)
      <input type="number" id="principal" min="0" step="1" value="5000">
    </label>
    <label>Days overdue
      <input type="number" id="daysOverdue" min="0" step="1" value="365">
    </label>
    <button type="submit">Calculate</button>
  </form>

  <div id="results-block" hidden>
    <p id="result-amount" class="result-amount"></p>
    <p class="privacy-note">Simple interest estimate only — see the state note below for compounding and automatic-accrual caveats.</p>
  </div>

  ${stateNotes}

  <section>
    <h2>Statutory interest rate by state</h2>
    <table>
      <tr><th>State</th><th>Rate</th><th>Accrual</th><th>Statute</th></tr>
      ${rowsList}
    </table>
    <p class="formula-footnote">Only states with a verified, cited primary source are listed. More states will be added as they're researched and verified — see our <a href="/about/">methodology</a>.</p>
  </section>

  <section>
    <h2>FAQ</h2>
    <details><summary>Does every state charge interest on unpaid child support?</summary><p>No. Some states apply interest automatically once a payment is missed; others require the receiving parent or child support agency to specifically request it, and a court to grant it. Check your state's row in the table above.</p></details>
    <details><summary>Does interest on child support arrears compound?</summary><p>It varies by state. A few states compound interest (added to principal periodically, then earning interest itself); this calculator computes simple interest only, so your real balance may be higher in a compounding state.</p></details>
  </section>
</main>

<footer>
  <p>USA Child Support Calculator is part of Gesmine-Invest Limited, registered UK company number 14120136, registered office address at Hardy House, 269 Poynders Gardens, London, London, United Kingdom, SW4 8PQ.</p>
  <p><a href="/about/">About</a> · <a href="/privacy/">Privacy</a> · <a href="/changelog/">Changelog</a> · &copy; ${YEAR} USA Child Support Calculator. Estimates only — not legal advice.</p>
</footer>

<script src="/assets/arrears-engine.js"></script>
<script>
  const RATES = ${JSON.stringify(rates)};
  function showStateNote() {
    const sel = document.getElementById('arrearsState').value;
    document.querySelectorAll('.arrears-state-note').forEach(el => { el.hidden = el.dataset.state !== sel; });
  }
  document.getElementById('arrearsState').addEventListener('change', showStateNote);
  document.getElementById('arrears-form').addEventListener('submit', function(e) {
    e.preventDefault();
    showStateNote();
    const sel = document.getElementById('arrearsState').value;
    const rate = RATES[sel];
    const principal = Number(document.getElementById('principal').value) || 0;
    const days = Number(document.getElementById('daysOverdue').value) || 0;
    const result = calcArrearsInterest(principal, rate.annual_rate_pct, days);
    document.getElementById('result-amount').textContent =
      'Estimated interest: $' + result.interest.toLocaleString() + ' — Total owed: $' + result.total.toLocaleString();
    document.getElementById('results-block').hidden = false;
  });
  showStateNote();
</script>
</body>
</html>`;
}

function renderModificationPage() {
  const thresholds = require('./data/modification-thresholds.json');
  const availableStates = Object.keys(thresholds)
    .map(slug => states[Object.keys(states).find(k => states[k].slug === slug)])
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
  const options = availableStates.map(s => `<option value="${s.slug}">${s.name}</option>`).join('');

  const rowsList = availableStates.map(s => {
    const t = thresholds[s.slug];
    let ruleText;
    if (t.threshold_type === 'case_by_case_no_fixed_threshold') {
      ruleText = 'No fixed statutory percentage — general "substantial change in circumstances" standard';
    } else {
      const parts = [];
      if (t.threshold_pct) parts.push(`${t.threshold_pct}% change`);
      if (t.threshold_amount_monthly) parts.push(`$${t.threshold_amount_monthly}/mo change`);
      ruleText = parts.join(' or ');
      if (t.min_time_since_last_order_years) ruleText += `, ${t.min_time_since_last_order_years}+ yr since last order`;
    }
    return `<tr><td><a href="/${s.slug}/">${s.name}</a></td><td>${ruleText}</td><td>${t.statute_ref}</td></tr>`;
  }).join('');

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', name: 'How much does income need to change to modify child support?', acceptedAnswer: { '@type': 'Answer', text: 'It depends entirely on your state. Many states set a specific percentage (commonly 10-20%) or dollar-amount change as a threshold; others use a general "substantial change in circumstances" standard with no fixed number. See the table on this page for your state\'s rule.' } },
      { '@type': 'Question', name: 'Where do I get my "new" guideline amount to compare?', acceptedAnswer: { '@type': 'Answer', text: 'Run your current income and custody numbers through your state\'s own child support calculator on this site, then enter that result here alongside your existing order amount.' } }
    ]
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Child Support Modification Calculator ${YEAR} — Does Your Change Qualify?</title>
<meta name="description" content="Compare your current child support order to a new guideline amount and check it against your state's statutory modification threshold, sourced and cited per state.">
<link rel="canonical" href="${DOMAIN}/child-support-modification-calculator/">
<link rel="stylesheet" href="/assets/styles.css">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body>
<header>
  <a href="/">← All States</a>
  <h1>Child Support Modification Calculator</h1>
  <p class="badge">Check whether a change in your numbers meets your state's modification threshold</p>
</header>

<div class="disclaimer-banner">
  Estimate only — not legal advice. Meeting a state's numeric threshold does not automatically modify your order — you still need to file a motion and, in most states, get a court's approval. Consult your state's child support agency or a family law attorney.
</div>

<main>
  <section>
    <p>First, get your current guideline amount from <a href="/">your state's calculator</a> using today's income and custody numbers. Then compare it to your existing order below.</p>
  </section>

  <form id="mod-form">
    <label>State
      <select id="modState">${options}</select>
    </label>
    <label>Current order amount ($/month)
      <input type="number" id="currentAmount" min="0" step="1" value="1000">
    </label>
    <label>New guideline amount, from your state's calculator ($/month)
      <input type="number" id="newAmount" min="0" step="1" value="1000">
    </label>
    <button type="submit">Compare</button>
  </form>

  <div id="results-block" hidden>
    <p id="result-amount" class="result-amount"></p>
    <p id="result-verdict" class="result-warning" hidden></p>
  </div>

  <section>
    <h2>Modification threshold by state</h2>
    <table>
      <tr><th>State</th><th>Threshold</th><th>Statute</th></tr>
      ${rowsList}
    </table>
    <p class="formula-footnote">Only states with a verified, cited primary source are listed. More states will be added as they're researched and verified — see our <a href="/about/">methodology</a>.</p>
  </section>

  <section>
    <h2>FAQ</h2>
    <details><summary>How much does income need to change to modify child support?</summary><p>It depends entirely on your state. Many states set a specific percentage (commonly 10-20%) or dollar-amount change as a threshold; others use a general "substantial change in circumstances" standard with no fixed number. See the table above for your state's rule.</p></details>
    <details><summary>Where do I get my "new" guideline amount to compare?</summary><p>Run your current income and custody numbers through your state's own child support calculator on this site, then enter that result here alongside your existing order amount.</p></details>
  </section>
</main>

<footer>
  <p>USA Child Support Calculator is part of Gesmine-Invest Limited, registered UK company number 14120136, registered office address at Hardy House, 269 Poynders Gardens, London, London, United Kingdom, SW4 8PQ.</p>
  <p><a href="/about/">About</a> · <a href="/privacy/">Privacy</a> · <a href="/changelog/">Changelog</a> · &copy; ${YEAR} USA Child Support Calculator. Estimates only — not legal advice.</p>
</footer>

<script>
  const THRESHOLDS = ${JSON.stringify(thresholds)};
  document.getElementById('mod-form').addEventListener('submit', function(e) {
    e.preventDefault();
    const sel = document.getElementById('modState').value;
    const t = THRESHOLDS[sel];
    const current = Number(document.getElementById('currentAmount').value) || 0;
    const next = Number(document.getElementById('newAmount').value) || 0;
    const diff = next - current;
    const pctDiff = current > 0 ? Math.abs(diff) / current * 100 : 0;
    document.getElementById('result-amount').textContent =
      'Difference: $' + Math.abs(diff).toLocaleString() + '/mo (' + pctDiff.toFixed(1) + '%), guideline amount is ' + (diff >= 0 ? 'higher' : 'lower') + ' than your current order.';
    const verdictEl = document.getElementById('result-verdict');
    if (t.threshold_type === 'case_by_case_no_fixed_threshold') {
      verdictEl.textContent = 'This state has no fixed numeric threshold — modification depends on a general "substantial change in circumstances" finding by the court.';
      verdictEl.hidden = false;
    } else {
      const meetsPct = !!t.threshold_pct && pctDiff >= t.threshold_pct;
      const meetsAmount = !!t.threshold_amount_monthly && Math.abs(diff) >= t.threshold_amount_monthly;
      let meets;
      if (t.threshold_pct && t.threshold_amount_monthly) {
        // Both a percentage and a dollar figure are set — how they combine varies by
        // state (OR, AND, or "whichever is greater/less" sets the effective bar), so
        // this can't default to a single formula without risking a wrong verdict.
        const pctDollar = t.threshold_pct / 100 * current;
        if (t.combine_logic === 'and') meets = meetsPct && meetsAmount;
        else if (t.combine_logic === 'whichever_less') meets = Math.abs(diff) >= Math.min(pctDollar, t.threshold_amount_monthly);
        else if (t.combine_logic === 'whichever_greater') meets = Math.abs(diff) >= Math.max(pctDollar, t.threshold_amount_monthly);
        else meets = meetsPct || meetsAmount;
      } else {
        meets = meetsPct || meetsAmount;
      }
      verdictEl.textContent = meets
        ? 'This difference appears to meet your state\\'s numeric modification threshold — this does not by itself modify your order; you still need to file and the court must approve.'
        : 'This difference does not appear to meet your state\\'s numeric modification threshold, based on the figures you entered.';
      verdictEl.hidden = false;
    }
  });
</script>
</body>
</html>`;
}

function renderComparePage() {
  const sortedStates = Object.values(states).slice().sort((a, b) => a.name.localeCompare(b.name));
  const options = sortedStates.map(s => `<option value="${s.slug}">${s.name}</option>`).join('');

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', name: 'Can I directly compare what I\'d pay in two different states?', acceptedAnswer: { '@type': 'Answer', text: 'Only on common inputs — both parents\' income and number of children. Many states also factor in custody overnights, childcare costs, or health insurance premiums; this comparison assumes reasonable defaults (50/50 custody, no add-on costs) for those, which may change the real number. Use each state\'s full calculator for an accurate figure.' } }
    ]
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Compare Child Support Between States ${YEAR} — Side-by-Side Calculator</title>
<meta name="description" content="Compare estimated child support obligations between two US states side by side, using each state's own official guideline formula.">
<link rel="canonical" href="${DOMAIN}/compare/">
<link rel="stylesheet" href="/assets/styles.css">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body>
<header>
  <a href="/">← All States</a>
  <h1>Compare Child Support Between States</h1>
  <p class="badge">Side-by-side estimate using each state's own official guideline formula</p>
</header>

<div class="disclaimer-banner">
  Estimate only — not legal advice. This comparison uses only income and number of children as common inputs. Many states also weigh custody overnights, childcare costs, or health insurance premiums — this tool assumes reasonable defaults for those (noted per result) rather than the real specifics of your case. For an accurate number, use that state's own full calculator.
</div>

<main>
  <form id="compare-form">
    <label>State A
      <select id="stateA">${options}</select>
    </label>
    <label>State B
      <select id="stateB">${options}</select>
    </label>
    <label>Parent A income ($/month)
      <input type="number" id="parentAIncome" min="0" step="1" value="4000">
    </label>
    <label>Parent B income ($/month)
      <input type="number" id="parentBIncome" min="0" step="1" value="3000">
    </label>
    <label>Number of children
      <select id="numChildren">
        <option value="1">1</option><option value="2">2</option><option value="3">3</option>
        <option value="4">4</option><option value="5">5</option>
      </select>
    </label>
    <button type="submit">Compare</button>
  </form>

  <div id="results-block" class="compare-results" hidden>
    <div id="result-a"></div>
    <div id="result-b"></div>
  </div>

  <section>
    <h2>FAQ</h2>
    <details><summary>Can I directly compare what I'd pay in two different states?</summary><p>Only on common inputs — both parents' income and number of children. Many states also factor in custody overnights, childcare costs, or health insurance premiums; this comparison assumes reasonable defaults (50/50 custody, no add-on costs) for those, which may change the real number. Use each state's full calculator for an accurate figure.</p></details>
  </section>
</main>

<footer>
  <p>USA Child Support Calculator is part of Gesmine-Invest Limited, registered UK company number 14120136, registered office address at Hardy House, 269 Poynders Gardens, London, London, United Kingdom, SW4 8PQ.</p>
  <p><a href="/about/">About</a> · <a href="/privacy/">Privacy</a> · <a href="/changelog/">Changelog</a> · &copy; ${YEAR} USA Child Support Calculator. Estimates only — not legal advice.</p>
</footer>

<script src="/assets/calc-engine.js"></script>
<script>
  let ALL_STATES = null;
  const rulesCache = {};
  const scheduleCache = {};

  async function loadStates() {
    if (!ALL_STATES) {
      const res = await fetch('/data/states.json');
      ALL_STATES = await res.json();
    }
    return ALL_STATES;
  }
  async function loadRules(slug) {
    if (!rulesCache[slug]) {
      const res = await fetch('/data/rules/' + slug + '.json');
      rulesCache[slug] = await res.json();
    }
    return rulesCache[slug];
  }
  async function loadSchedule(ref) {
    if (!ref) return null;
    if (!scheduleCache[ref]) {
      const res = await fetch('/data/schedules/' + ref);
      scheduleCache[ref] = await res.json();
    }
    return scheduleCache[ref];
  }

  // Builds the model-specific input shape from the common fields this page
  // collects (both parents' income, number of children), applying documented
  // defaults for anything a given state's formula needs beyond that — same
  // per-model field mapping used by each state's own calculator page.
  function buildInputs(formulaModel, common) {
    const assumptions = [];
    switch (formulaModel) {
      case 'percentage_of_income':
        assumptions.push('this state\\'s formula uses only the paying parent\\'s own income — Parent B\\'s income is used here');
        return { inputs: { obligorNetMonthlyIncome: common.parentBIncome, numChildren: common.numChildren }, assumptions };
      case 'algebraic_kfactor':
        assumptions.push('assumes 50/50 custody timeshare');
        return { inputs: { parentANetIncome: common.parentAIncome, parentBNetIncome: common.parentBIncome, numChildren: common.numChildren, higherEarnerTimesharePct: 0.5 }, assumptions };
      case 'michigan_formula':
        assumptions.push('assumes 182 overnights/year with Parent A (50/50 custody)');
        return { inputs: { parentANetIncome: common.parentAIncome, parentBNetIncome: common.parentBIncome, numChildren: common.numChildren, overnightsWithA: 182 }, assumptions };
      case 'ks_age_schedule':
        assumptions.push('assumes all children are age 12-18 and 50/50 custody');
        return { inputs: { parentAGrossIncome: common.parentAIncome, parentBGrossIncome: common.parentBIncome, children0to5: 0, children6to11: 0, children12to18: common.numChildren, overnightsWithA: 182 }, assumptions };
      case 'wi_percentage_shared':
      case 'nv_tiered_percentage':
      case 'nd_obligor_schedule':
        assumptions.push('assumes 182 overnights/year with Parent A (50/50 custody)');
        return { inputs: { parentAGrossIncome: common.parentAIncome, parentBGrossIncome: common.parentBIncome, numChildren: common.numChildren, overnightsWithA: 182 }, assumptions };
      default:
        assumptions.push('assumes 182 overnights/year with Parent A (50/50 custody), $0 childcare cost, $0 health insurance premium');
        return { inputs: { parentAGrossIncome: common.parentAIncome, parentBGrossIncome: common.parentBIncome, numChildren: common.numChildren, overnightsWithA: 182, childcareCost: 0, healthInsuranceCost: 0 }, assumptions };
    }
  }

  async function computeForState(slug, common) {
    const allStates = await loadStates();
    const stateKey = Object.keys(allStates).find(k => allStates[k].slug === slug);
    const stateEntry = allStates[stateKey];
    const rules = await loadRules(slug);
    const scheduleRef = stateEntry.params && stateEntry.params.schedule_table_ref;
    const schedule = await loadSchedule(scheduleRef);
    const { inputs, assumptions } = buildInputs(stateEntry.formula_model, common);
    const result = calculateChildSupport(stateEntry, rules, schedule, inputs);
    return { stateEntry, result, assumptions };
  }

  function renderResult(elId, data) {
    const periodLabel = (data.stateEntry.params && data.stateEntry.params.income_period === 'weekly') ? '/week' : '/month';
    const payer = data.result.payingParent ? (data.result.payingParent === 'A' ? 'Parent A pays' : 'Parent B pays') : 'Amount';
    document.getElementById(elId).innerHTML =
      '<h2>' + data.stateEntry.name + '</h2>' +
      '<p class="result-amount">' + payer + ': $' + data.result.monthlyAmount.toLocaleString() + periodLabel + '</p>' +
      '<p class="result-deviation">Assumptions: ' + data.assumptions.join('; ') + '.</p>' +
      (data.result.capWarning ? '<p class="result-warning">' + data.result.capWarning + '</p>' : '') +
      '<p class="formula-footnote"><a href="/' + data.stateEntry.slug + '/">Full ' + data.stateEntry.name + ' calculator →</a></p>';
  }

  document.getElementById('compare-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    const common = {
      parentAIncome: Number(document.getElementById('parentAIncome').value) || 0,
      parentBIncome: Number(document.getElementById('parentBIncome').value) || 0,
      numChildren: Number(document.getElementById('numChildren').value) || 1
    };
    const slugA = document.getElementById('stateA').value;
    const slugB = document.getElementById('stateB').value;
    const [dataA, dataB] = await Promise.all([computeForState(slugA, common), computeForState(slugB, common)]);
    renderResult('result-a', dataA);
    renderResult('result-b', dataB);
    document.getElementById('results-block').hidden = false;
  });
</script>
</body>
</html>`;
}

function renderGuidePage(guide) {
  const jsonLd = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        headline: guide.title,
        author: GESMINE_ORG,
        publisher: GESMINE_ORG,
        description: guide.meta_description
      },
      {
        '@type': 'FAQPage',
        mainEntity: guide.faqs.map(item => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.a.replace(/<[^>]+>/g, '') }
        }))
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${DOMAIN}/` },
          { '@type': 'ListItem', position: 2, name: 'Guides', item: `${DOMAIN}/guides/` },
          { '@type': 'ListItem', position: 3, name: guide.title, item: `${DOMAIN}/guides/${guide.slug}/` }
        ]
      }
    ]
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${guide.title} — USA Child Support Calculator</title>
<meta name="description" content="${guide.meta_description}">
<link rel="canonical" href="${DOMAIN}/guides/${guide.slug}/">
<link rel="stylesheet" href="/assets/styles.css">
<meta property="og:title" content="${guide.title}">
<meta property="og:description" content="${guide.meta_description}">
<meta property="og:url" content="${DOMAIN}/guides/${guide.slug}/">
<meta property="og:type" content="article">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
</head>
<body>
<header>
  <a href="/guides/">← All Guides</a>
  <h1>${guide.title}</h1>
</header>

<main>
  <section>
    <p>${guide.intro}</p>
  </section>

  ${guide.sections.map(s => `<section><h2>${s.h2}</h2><p>${s.body}</p></section>`).join('')}

  <section>
    <h2>FAQ</h2>
    ${guide.faqs.map(item => `<details><summary>${item.q}</summary><p>${item.a}</p></details>`).join('')}
  </section>

  <section>
    <h2>Related</h2>
    <ul>${guide.related.map(r => `<li><a href="${r.href}">${r.label}</a></li>`).join('')}</ul>
  </section>
</main>

<footer>
  <p>USA Child Support Calculator is part of Gesmine-Invest Limited, registered UK company number 14120136, registered office address at Hardy House, 269 Poynders Gardens, London, London, United Kingdom, SW4 8PQ.</p>
  <p><a href="/about/">About</a> · <a href="/privacy/">Privacy</a> · <a href="/changelog/">Changelog</a> · &copy; ${YEAR} USA Child Support Calculator. Estimates only — not legal advice.</p>
</footer>
</body>
</html>`;
}

function renderGuidesHubPage(guides) {
  const rows = guides.map(g => `<li><a href="/guides/${g.slug}/">${g.title}</a></li>`).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Child Support Guides — USA Child Support Calculator</title>
<meta name="description" content="Plain-English guides on how child support works: custody, modification, taxes, enforcement, self-employment income, and more.">
<link rel="canonical" href="${DOMAIN}/guides/">
<link rel="stylesheet" href="/assets/styles.css">
</head>
<body>
<header>
  <a href="/">← Home</a>
  <h1>Child Support Guides</h1>
  <p class="badge">Plain-English explainers, separate from the state-by-state calculators</p>
</header>

<main>
  <section>
    <ul class="state-link-list">${rows}</ul>
  </section>
</main>

<footer>
  <p>USA Child Support Calculator is part of Gesmine-Invest Limited, registered UK company number 14120136, registered office address at Hardy House, 269 Poynders Gardens, London, London, United Kingdom, SW4 8PQ.</p>
  <p><a href="/about/">About</a> · <a href="/privacy/">Privacy</a> · <a href="/changelog/">Changelog</a> · &copy; ${YEAR} USA Child Support Calculator. Estimates only — not legal advice.</p>
</footer>
</body>
</html>`;
}

function renderChangelogPage(satellites, guides) {
  const rows = Object.values(states)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(s => `<tr><td><a href="/${s.slug}/">${s.name}</a></td><td>${s.guideline_version}</td><td>${s.effective_date}</td><td>${s.last_verified}</td><td><a href="${s.source.url}" rel="nofollow noopener">${s.source.agency_name}</a></td></tr>`)
    .join('\n      ');

  const toolRows = [
    ...Object.entries(satellites).map(([key, meta]) => `<tr><td><a href="/${meta.slug}/">${meta.title}</a></td><td>Satellite tool</td></tr>`),
    `<tr><td><a href="/child-support-arrears-calculator/">Child Support Arrears Calculator</a></td><td>Tool — 41 states</td></tr>`,
    `<tr><td><a href="/child-support-modification-calculator/">Child Support Modification Calculator</a></td><td>Tool — 51 states</td></tr>`,
    `<tr><td><a href="/compare/">Compare States</a></td><td>Tool</td></tr>`
  ].join('\n      ');

  const guideRows = guides
    .map(g => `<tr><td><a href="/guides/${g.slug}/">${g.title}</a></td></tr>`)
    .join('\n      ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Changelog — USA Child Support Calculator</title>
<meta name="description" content="Guideline version and last-verification date for every state on this site — updated whenever a state revises its child support formula.">
<link rel="canonical" href="${DOMAIN}/changelog/">
<link rel="stylesheet" href="/assets/styles.css">
</head>
<body>
<header>
  <a href="/">← Home</a>
  <h1>Changelog</h1>
  <p class="badge">Guideline version and last-verification date for every state on this site</p>
</header>

<main>
  <section>
    <p>Each state's guideline formula is re-verified against its official source on the cadence noted in our <a href="/about/">methodology</a>. This table is generated directly from the same data that drives each state's calculator — it is not a separate, hand-maintained log.</p>
    <table>
      <tr><th>State</th><th>Guideline version</th><th>Effective date</th><th>Last verified</th><th>Official source</th></tr>
      ${rows}
    </table>
  </section>

  <section>
    <h2>Tools</h2>
    <table>
      <tr><th>Tool</th><th>Coverage</th></tr>
      ${toolRows}
    </table>
  </section>

  <section>
    <h2>Guides</h2>
    <table>
      <tr><th>Guide</th></tr>
      ${guideRows}
    </table>
  </section>
</main>

<footer>
  <p>USA Child Support Calculator is part of Gesmine-Invest Limited, registered UK company number 14120136, registered office address at Hardy House, 269 Poynders Gardens, London, London, United Kingdom, SW4 8PQ.</p>
  <p><a href="/about/">About</a> · <a href="/privacy/">Privacy</a> · <a href="/changelog/">Changelog</a> · &copy; ${YEAR} USA Child Support Calculator. Estimates only — not legal advice.</p>
</footer>
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

const satellites = require('./data/satellites.json');
const guidesForChangelog = require('./data/guides.json');
fs.mkdirSync(path.join(__dirname, 'changelog'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'changelog', 'index.html'), renderChangelogPage(satellites, guidesForChangelog), 'utf8');
console.log('Generated: changelog/');

Object.entries(satellites).forEach(([key, meta]) => {
  if (!SATELLITE_CONTENT[key]) {
    throw new Error(`BUILD BLOCKED: data/satellites.json defines "${key}" but no SATELLITE_CONTENT entry exists in generate-pages.js.`);
  }
  const html = renderSatellitePage(key, meta);
  const dir = path.join(__dirname, meta.slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf8');
  console.log(`Generated: ${meta.slug}/ (satellite: ${key})`);
});

fs.mkdirSync(path.join(__dirname, 'child-support-arrears-calculator'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'child-support-arrears-calculator', 'index.html'), renderArrearsPage(), 'utf8');
console.log('Generated: child-support-arrears-calculator/');

fs.mkdirSync(path.join(__dirname, 'child-support-modification-calculator'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'child-support-modification-calculator', 'index.html'), renderModificationPage(), 'utf8');
console.log('Generated: child-support-modification-calculator/');

fs.mkdirSync(path.join(__dirname, 'compare'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'compare', 'index.html'), renderComparePage(), 'utf8');
console.log('Generated: compare/');

const guides = require('./data/guides.json');
fs.mkdirSync(path.join(__dirname, 'guides'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'guides', 'index.html'), renderGuidesHubPage(guides), 'utf8');
console.log('Generated: guides/');
guides.forEach(guide => {
  const dir = path.join(__dirname, 'guides', guide.slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), renderGuidePage(guide), 'utf8');
  console.log(`Generated: guides/${guide.slug}/`);
});
