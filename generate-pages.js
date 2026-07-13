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
      if (STATE_ENTRY.formula_model === 'wi_percentage_shared' || STATE_ENTRY.formula_model === 'nv_tiered_percentage') {
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
        author: { '@type': 'Organization', name: 'Gesmine-Invest Limited', url: DOMAIN + '/about/' },
        publisher: { '@type': 'Organization', name: 'Gesmine-Invest Limited', url: DOMAIN + '/about/' },
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
</main>

<footer>
  <p>Gesmine-Invest Limited, registered UK company number 14120136, Hardy House, 269 Poynders Gardens, London, SW4 8PQ.</p>
  <p><a href="/about/">About</a> · <a href="/privacy/">Privacy</a> · <a href="/changelog/">Changelog</a> · &copy; ${YEAR} USA Child Support Calculator. Estimates only — not legal advice.</p>
</footer>

${calculatorScript(state)}
</body>
</html>`;
}

function renderChangelogPage() {
  const rows = Object.values(states)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(s => `<tr><td><a href="/${s.slug}/">${s.name}</a></td><td>${s.guideline_version}</td><td>${s.effective_date}</td><td>${s.last_verified}</td><td><a href="${s.source.url}" rel="nofollow noopener">${s.source.agency_name}</a></td></tr>`)
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
</main>

<footer>
  <p>Gesmine-Invest Limited, registered UK company number 14120136, Hardy House, 269 Poynders Gardens, London, SW4 8PQ.</p>
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

fs.mkdirSync(path.join(__dirname, 'changelog'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'changelog', 'index.html'), renderChangelogPage(), 'utf8');
console.log('Generated: changelog/');
