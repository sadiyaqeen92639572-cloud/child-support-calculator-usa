/* Shared child support calculator engine.
   3 pure functions, one per guideline formula model, plus a dispatcher.
   Loaded once as a static asset across all state pages (not inlined per page —
   this logic is shared and too large to duplicate 51x). */

function calcPercentageOfIncome(params, rules, inputs) {
  // inputs: { obligorNetMonthlyIncome, numChildren }
  const bracket = inputs.numChildren >= 6 ? '6+' : String(inputs.numChildren);
  const isLowIncome = params.low_income_threshold_monthly
    && inputs.obligorNetMonthlyIncome < params.low_income_threshold_monthly;
  const pct = (isLowIncome && params.low_income_percentages)
    ? params.low_income_percentages[bracket]
    : params.percentages[bracket];
  const capped = Math.min(inputs.obligorNetMonthlyIncome, params.net_income_cap_monthly);
  let amount = capped * pct;
  amount = applyRounding(amount, rules.rounding);
  const overCap = inputs.obligorNetMonthlyIncome > params.net_income_cap_monthly;
  return {
    monthlyAmount: amount,
    overIncomeCap: overCap,
    lowIncomeScheduleApplied: isLowIncome,
    deviationNote: rules.deviation_note,
    capWarning: overCap
      ? `Guideline caps net resources at $${params.net_income_cap_monthly.toLocaleString()}/mo — your result may need judicial review above this threshold.`
      : null
  };
}

function calcIncomeShares(params, rules, scheduleTable, inputs) {
  // inputs: { parentAGrossIncome, parentBGrossIncome, numChildren, overnightsWithA, childcareCost, healthInsuranceCost }
  const combined = inputs.parentAGrossIncome + inputs.parentBGrossIncome;
  const baseObligation = params.schedule_type === 'percentage'
    ? calcPercentageOfCombinedIncome(params, combined, inputs.numChildren)
    : lookupSchedule(scheduleTable, combined, inputs.numChildren);
  const shareA = inputs.parentAGrossIncome / combined;
  const shareB = 1 - shareA;
  const addOns = (inputs.childcareCost || 0) + (inputs.healthInsuranceCost || 0);
  const totalObligation = baseObligation + addOns;

  // The parent with the MAJORITY of overnights is the custodial parent who
  // receives support; the other parent pays their income-share of the total
  // obligation. overnightsWithA is nights/year the child spends with Parent A.
  const overnightsWithA = inputs.overnightsWithA || 0;
  const aIsCustodial = overnightsWithA > 182.5;
  const payingParent = aIsCustodial ? 'B' : 'A';
  const payingShare = payingParent === 'A' ? shareA : shareB;
  const payingParentOvernights = payingParent === 'A' ? overnightsWithA : (365 - overnightsWithA);
  const payingParentIncome = payingParent === 'A' ? inputs.parentAGrossIncome : inputs.parentBGrossIncome;

  let amount = totalObligation * payingShare;
  let adjustedForCustody = false;
  let custodyWarning = null;

  if (rules.custody_adjustment) {
    if (rules.custody_adjustment.type === 'overnights_threshold') {
      const threshold = rules.custody_adjustment.threshold;
      adjustedForCustody = payingParentOvernights > threshold;
      // Crossing this threshold switches to a different, state-specific worksheet
      // (e.g. Florida's 1.5x gross-up method) that this generic engine does not
      // compute — surface a warning instead of silently returning a wrong number.
      if (adjustedForCustody && rules.custody_adjustment.warning_message) {
        custodyWarning = rules.custody_adjustment.warning_message;
      }
    } else if (rules.custody_adjustment.type === 'graduated_overnight_credit') {
      const creditPct = interpolateCredit(rules.custody_adjustment.table, payingParentOvernights);
      // Credit is a dollar amount computed on the FULL base obligation (before
      // proration), then subtracted from the paying parent's share — confirmed
      // against Arizona's official worked examples (credit != a multiplicative
      // discount on the parent's own share).
      amount = Math.max(0, amount - (totalObligation * creditPct));
      adjustedForCustody = creditPct > 0;
    } else if (rules.custody_adjustment.type === 'stepped_days_table') {
      // e.g. Arizona's Parenting Time Table — a true step function by day-range,
      // NOT interpolated (a real 100-114 day range all uses the same .175 credit).
      const creditPct = stepLookup(rules.custody_adjustment.table, payingParentOvernights);
      amount = Math.max(0, amount - (totalObligation * creditPct));
      adjustedForCustody = creditPct > 0;
    }
  }

  amount = applyRounding(amount, rules.rounding);

  const reserve = params.self_support_reserve_monthly;
  const belowReserve = reserve && (payingParentIncome - amount) < reserve;

  return {
    monthlyAmount: amount,
    payingParent,
    combinedIncome: combined,
    baseObligation,
    adjustedForCustody,
    belowSelfSupportReserve: belowReserve,
    deviationNote: rules.deviation_note,
    capWarning: custodyWarning || (belowReserve
      ? `This result would leave the paying parent below the state's self-support reserve ($${reserve.toLocaleString()}/mo) — courts typically adjust in this situation.`
      : null)
  };
}

function calcPercentageOfCombinedIncome(params, combinedIncome, numChildren) {
  // NY CSSA-style: a flat statutory percentage of COMBINED parental income
  // (capped), rather than a schedule-table lookup. Still fits the income_shares
  // pipeline (combine -> base obligation -> prorate by share) with a different
  // base-obligation source.
  const bracket = numChildren >= 5 ? '5+' : String(numChildren);
  const capped = Math.min(combinedIncome, params.combined_income_cap_monthly);
  return capped * params.percentages_of_combined[bracket];
}

function calcAlgebraicKFactor(params, rules, inputs) {
  // California-style: CS = K x [HN - (H% x TN)]
  // HN = higher earner's net monthly disposable income
  // H% = higher earner's custody timeshare (0-1)
  // TN = total net monthly disposable income of both parents
  // K = allocation factor, itself a function of H% and TN (approximated via
  // params.k_base + params.k_income_divisor, per state's published K table)
  const netA = inputs.parentANetIncome;
  const netB = inputs.parentBNetIncome;
  const higherIsA = netA >= netB;
  const HN = higherIsA ? netA : netB;
  const TN = netA + netB;
  const Hpct = inputs.higherEarnerTimesharePct;

  const childBracket = inputs.numChildren >= 4 ? 4 : inputs.numChildren;
  const kConst = params.k_constants[String(childBracket)] || params.k_constants['1'];
  const incomeComponent = TN / params.k_income_divisor;
  const K = (Hpct <= 0.5 ? (1 + Hpct) : (2 - Hpct)) * Math.min(kConst + incomeComponent, params.k_max || 1);

  let amount = K * (HN - (Hpct * TN));
  amount = Math.max(amount, 0);
  amount = applyRounding(amount, rules.rounding);

  return {
    monthlyAmount: amount,
    payingParent: higherIsA ? 'A' : 'B',
    deviationNote: rules.deviation_note,
    capWarning: null
  };
}

function calcMelson(params, rules, scheduleTable, inputs) {
  const base = calcIncomeShares(params, rules, scheduleTable, inputs);
  if (params.sola_percentage) {
    const solaAdjustment = base.monthlyAmount * params.sola_percentage;
    base.monthlyAmount = applyRounding(base.monthlyAmount + solaAdjustment, rules.rounding);
    base.solaApplied = true;
  }
  return base;
}

function calculateChildSupport(stateEntry, rules, scheduleTable, inputs) {
  switch (stateEntry.formula_model) {
    case 'percentage_of_income':
      return calcPercentageOfIncome(stateEntry.params, rules, inputs);
    case 'income_shares':
      return calcIncomeShares(stateEntry.params, rules, scheduleTable, inputs);
    case 'melson':
      return calcMelson(stateEntry.params, rules, scheduleTable, inputs);
    case 'algebraic_kfactor':
      return calcAlgebraicKFactor(stateEntry.params, rules, inputs);
    default:
      throw new Error(`Unknown formula_model: ${stateEntry.formula_model}`);
  }
}

function interpolateCredit(table, overnights) {
  // table: [{overnights: N, creditPct: 0.0887}, ...] sorted ascending by overnights.
  // Linear interpolation between the two nearest anchor points (matches how states
  // with graduated tables, e.g. Colorado post-HB25-1159, interpolate between rows).
  if (overnights <= table[0].overnights) return table[0].creditPct;
  const last = table[table.length - 1];
  if (overnights >= last.overnights) return last.creditPct;
  for (let i = 0; i < table.length - 1; i++) {
    const a = table[i], b = table[i + 1];
    if (overnights >= a.overnights && overnights <= b.overnights) {
      const frac = (overnights - a.overnights) / (b.overnights - a.overnights);
      return a.creditPct + frac * (b.creditPct - a.creditPct);
    }
  }
  return 0;
}

function lookupSchedule(scheduleTable, combinedIncome, numChildren) {
  const capped = Math.min(combinedIncome, scheduleTable.maxIncome);
  const key = numChildren >= 6 ? '6' : String(numChildren);
  const rows = scheduleTable.rows;

  if (capped <= rows[0].upTo) return rows[0].obligation[key];
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i], b = rows[i + 1];
    if (capped > a.upTo && capped <= b.upTo) {
      // Linear interpolation between the two nearest real anchor rows —
      // official schedule tables are smooth/monotonic between adjacent
      // $50-increment rows, so this closely approximates the real table
      // even when anchors are spaced further apart than $50.
      const frac = (capped - a.upTo) / (b.upTo - a.upTo);
      return a.obligation[key] + frac * (b.obligation[key] - a.obligation[key]);
    }
  }
  return rows[rows.length - 1].obligation[key];
}

function stepLookup(table, value) {
  // table: [{upTo: N, value: X}, ...] sorted ascending — a true step function
  // (e.g. Arizona's Parenting Time Table), NOT interpolated between steps.
  for (const row of table) {
    if (value <= row.upTo) return row.value;
  }
  return table[table.length - 1].value;
}

function applyRounding(amount, mode) {
  if (mode === 'nearest_dollar') return Math.round(amount);
  if (mode === 'nearest_cent') return Math.round(amount * 100) / 100;
  return amount;
}
