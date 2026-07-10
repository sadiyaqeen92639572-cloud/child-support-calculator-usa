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
  const baseObligation = lookupSchedule(scheduleTable, combined, inputs.numChildren);
  const shareA = inputs.parentAGrossIncome / combined;
  const shareB = 1 - shareA;
  const addOns = (inputs.childcareCost || 0) + (inputs.healthInsuranceCost || 0);
  const totalObligation = baseObligation + addOns;

  let obligationOfB = totalObligation * shareB;
  let adjustedForCustody = false;

  if (rules.custody_adjustment) {
    if (rules.custody_adjustment.type === 'overnights_threshold') {
      const threshold = rules.custody_adjustment.threshold;
      adjustedForCustody = inputs.overnightsWithA > threshold;
      // Simple states: crossing the threshold switches to an alternate worksheet;
      // the reduction itself is state-specific and not modeled generically here.
    } else if (rules.custody_adjustment.type === 'graduated_overnight_credit') {
      const creditPct = interpolateCredit(rules.custody_adjustment.table, inputs.overnightsWithA);
      obligationOfB = obligationOfB * (1 - creditPct);
      adjustedForCustody = creditPct > 0;
    }
  }

  obligationOfB = applyRounding(obligationOfB, rules.rounding);

  const reserve = params.self_support_reserve_monthly;
  const belowReserve = reserve && (inputs.parentBGrossIncome - obligationOfB) < reserve;

  return {
    monthlyAmount: obligationOfB,
    combinedIncome: combined,
    baseObligation,
    adjustedForCustody,
    belowSelfSupportReserve: belowReserve,
    deviationNote: rules.deviation_note,
    capWarning: belowReserve
      ? `This result would leave the paying parent below the state's self-support reserve ($${reserve.toLocaleString()}/mo) — courts typically adjust in this situation.`
      : null
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
  const row = scheduleTable.rows.find(r => capped <= r.upTo) || scheduleTable.rows[scheduleTable.rows.length - 1];
  const key = numChildren >= 6 ? '6' : String(numChildren);
  return row.obligation[key];
}

function applyRounding(amount, mode) {
  if (mode === 'nearest_dollar') return Math.round(amount);
  if (mode === 'nearest_cent') return Math.round(amount * 100) / 100;
  return amount;
}
