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

  if (rules.min_of_individual_or_prorated) {
    // Ohio's mechanism (JFS 07768 Sole/Shared worksheet, Lines 18a-18d): compute
    // the obligation TWO ways — (a) look up the schedule using the paying
    // parent's OWN income alone, and (b) look up the schedule at combined
    // income and multiply by that parent's income share — then take the LOWER
    // of the two, floored at the statutory minimum order. This (not a
    // threshold branch) is what produces the schedule's self-support-reserve
    // flattening. A flat percentage parenting-time credit is subtracted next
    // (Line 19b) if there is any court-ordered parenting time, then add-ons
    // are added (Line 21j) before the annual total is divided by 12 (Line 24).
    const mip = rules.min_of_individual_or_prorated;
    const individualObligation = lookupSchedule(scheduleTable, payingParentIncome, inputs.numChildren);
    const proratedObligation = baseObligation * payingShare;
    let annualAmount = Math.max(Math.min(individualObligation, proratedObligation), mip.min_order_annual);

    let ptCredit = 0;
    let adjustedForCustody = false;
    if (rules.custody_adjustment && rules.custody_adjustment.type === 'flat_percent_if_any_time' && payingParentOvernights > 0) {
      ptCredit = annualAmount * rules.custody_adjustment.pct;
      adjustedForCustody = true;
    }
    annualAmount = Math.max(0, annualAmount - ptCredit) + addOns;

    const monthly = applyRounding(annualAmount / 12, rules.rounding);
    return {
      monthlyAmount: monthly,
      payingParent,
      combinedIncome: combined,
      baseObligation,
      adjustedForCustody,
      deviationNote: rules.deviation_note,
      capWarning: combined > (params.income_cap_annual || Infinity)
        ? `Above the $${(params.income_cap_annual || 0).toLocaleString()}/yr schedule cap, the obligation cannot be determined from the schedule — courts set support case-by-case.`
        : null
    };
  }

  if (rules.pa_lesser_of_calculations) {
    // Pennsylvania's mechanism (Pa.R.Civ.P. 1910.16-2(e)(1)(ii)): when the
    // paying parent's income and number of children fall in the schedule's
    // shaded (self-support reserve) area, the obligation is the LESSER of
    // (A) a schedule lookup at the paying parent's own income alone, or
    // (B) a schedule lookup at combined income times that parent's share.
    // Structurally the same "lesser of two calculations" idea as Ohio, but
    // monthly (not annual), with no fixed minimum order — below the SSR
    // itself, the rule gives courts discretion rather than a formula floor.
    const pa = rules.pa_lesser_of_calculations;
    const individualObligation = lookupSchedule(scheduleTable, payingParentIncome, inputs.numChildren);
    const proratedObligation = baseObligation * payingShare;
    const amount = applyRounding(Math.min(individualObligation, proratedObligation) + addOns, rules.rounding);
    const belowReserve = payingParentIncome <= pa.self_support_reserve_monthly;
    let sharedCustodyWarning = null;
    if (rules.custody_adjustment && rules.custody_adjustment.type === 'overnights_threshold'
        && payingParentOvernights > rules.custody_adjustment.threshold) {
      sharedCustodyWarning = rules.custody_adjustment.warning_message;
    }
    return {
      monthlyAmount: amount,
      payingParent,
      combinedIncome: combined,
      baseObligation,
      adjustedForCustody: false,
      belowSelfSupportReserve: belowReserve,
      deviationNote: rules.deviation_note,
      capWarning: sharedCustodyWarning || (belowReserve
        ? `Paying parent's net income is at or below the Self-Support Reserve ($${pa.self_support_reserve_monthly.toLocaleString()}/mo) — courts have full discretion here rather than applying the schedule automatically.`
        : null)
    };
  }

  if (rules.self_support_reserve) {
    // North Carolina-style self-support reserve: gated on the PAYING parent's
    // own income, not combined income. Below the min-order threshold, a flat
    // minimum order applies. Above that but at/below the shaded-zone ceiling
    // for this child count, the schedule is looked up using the paying
    // parent's income alone (not combined), with no add-ons — per the
    // guidelines' "shaded area of the Schedule" rule for Worksheet A.
    const ssr = rules.self_support_reserve;
    if (payingParentIncome < ssr.min_order_threshold_monthly) {
      const minAmount = applyRounding(ssr.min_order_amount, rules.rounding);
      return {
        monthlyAmount: minAmount,
        payingParent,
        combinedIncome: combined,
        baseObligation: ssr.min_order_amount,
        adjustedForCustody: false,
        selfSupportMinimumOrderApplied: true,
        deviationNote: rules.deviation_note,
        capWarning: `Minimum order applies — paying parent's adjusted gross income is below $${ssr.min_order_threshold_monthly.toLocaleString()}/mo.`
      };
    }
    const shadedCeiling = ssr.shaded_zone_max_obligor_income[String(inputs.numChildren)];
    if (shadedCeiling && payingParentIncome <= shadedCeiling) {
      const soloObligation = lookupSchedule(scheduleTable, payingParentIncome, inputs.numChildren);
      const soloAmount = applyRounding(soloObligation, rules.rounding);
      return {
        monthlyAmount: soloAmount,
        payingParent,
        combinedIncome: combined,
        baseObligation: soloObligation,
        adjustedForCustody: false,
        selfSupportReserveZoneApplied: true,
        deviationNote: rules.deviation_note,
        capWarning: "Self-support reserve zone applies (Worksheet A): computed from the paying parent's own income only, not combined income — childcare and health insurance costs are not added in this zone."
      };
    }
  }

  if (rules.wa_self_support_floor) {
    // Washington's mechanism, RCW 26.19.065 (eff. 2026-01-01): (1) a
    // presumptive $50/child/month minimum whenever the paying parent's net
    // income is below the Self-Support Reserve (180% of the one-person
    // federal poverty guideline); (2) the basic obligation otherwise may not
    // reduce the paying parent's income below the SSR, EXCEPT the $50/child
    // minimum always applies even if that dips into the reserve; (3) total
    // support across all of that parent's children is capped at 45% of net
    // income. This is a floor/cap on the standard prorated amount, not a
    // different lookup method.
    const wa = rules.wa_self_support_floor;
    const minFloor = wa.min_per_child_monthly * inputs.numChildren;
    const proratedAmount = totalObligation * payingShare;
    const reserveCappedAmount = Math.max(0, payingParentIncome - wa.self_support_reserve_monthly);
    let amount = Math.max(minFloor, Math.min(proratedAmount, reserveCappedAmount));
    const percentCap = payingParentIncome * 0.45;
    const cappedAt45 = amount > percentCap;
    if (cappedAt45) amount = percentCap;
    amount = applyRounding(amount, rules.rounding);
    const belowReserve = payingParentIncome < wa.self_support_reserve_monthly;
    return {
      monthlyAmount: amount,
      payingParent,
      combinedIncome: combined,
      baseObligation,
      adjustedForCustody: false,
      belowSelfSupportReserve: belowReserve,
      deviationNote: rules.deviation_note,
      capWarning: cappedAt45
        ? "Capped at 45% of the paying parent's net income (RCW 26.19.065(1)) — this limit applies across ALL of that parent's children, not just this case."
        : (belowReserve
          ? `Presumptive $${wa.min_per_child_monthly}/child/month minimum applies — paying parent's net income is below the Self-Support Reserve ($${wa.self_support_reserve_monthly.toLocaleString()}/mo, 180% of the one-person federal poverty guideline).`
          : null)
    };
  }

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
    } else if (rules.custody_adjustment.type === 'parenting_time_pow25') {
      // Georgia's parenting time adjustment, O.C.G.A. § 19-6-15(g)(2)(B) (SB454,
      // eff. 2026-01-01). Raises each parent's court-ordered days with the child
      // to the power of 2.5, then cross-multiplies against the OTHER parent's
      // dollar share of the BASE obligation (add-ons are prorated separately,
      // unaffected by this adjustment):
      //   adjustment = (ncpDaysPow * cpShare$ - cpDaysPow * ncpShare$) / (ncpDaysPow + cpDaysPow)
      //   ncpObligation = ncpShare$ + adjustment
      const ncpDays = payingParentOvernights;
      const cpDays = 365 - ncpDays;
      const ncpShareDollars = baseObligation * payingShare;
      const cpShareDollars = baseObligation - ncpShareDollars;
      const ncpDaysPow = Math.pow(ncpDays, 2.5);
      const cpDaysPow = Math.pow(cpDays, 2.5);
      const ptAdjustment = ((ncpDaysPow * cpShareDollars) - (cpDaysPow * ncpShareDollars)) / (ncpDaysPow + cpDaysPow);
      amount = Math.max(0, ncpShareDollars + ptAdjustment) + (addOns * payingShare);
      adjustedForCustody = true;
    } else if (rules.custody_adjustment.type === 'va_shared_custody') {
      // Virginia's shared custody formula, Va. Code § 20-108.2(G)(3), triggers
      // when the parent with fewer overnights has more than 90 days/year.
      // sharedSupportNeed = basic schedule obligation × 1.4. Each parent's
      // "theoretical" amount owed to the other = (sharedSupportNeed × the
      // OTHER parent's custody share + that other parent's add-on costs) ×
      // this parent's income share. The difference between the two
      // theoretical amounts is the shared-custody support, paid by whichever
      // parent's theoretical amount is larger — unless the sole-custody
      // amount (already computed above as `amount`) is LESS, in which case
      // the lesser (sole-custody) amount is used instead (subsection (a)/(f)).
      // Limitation: the statute credits each parent's OWN add-on costs
      // separately, but this engine only collects one combined
      // childcare/health-insurance figure — approximated here as entirely
      // the custodial parent's cost, disclosed in the deviation note.
      const threshold = rules.custody_adjustment.threshold_days || 90;
      if (payingParentOvernights > threshold) {
        const custodyShareA = overnightsWithA / 365;
        const custodyShareB = 1 - custodyShareA;
        const sharedSupportNeed = baseObligation * 1.4;
        const aTheoretical = (sharedSupportNeed * custodyShareB + addOns) * shareA;
        const bTheoretical = (sharedSupportNeed * custodyShareA + addOns) * shareB;
        const sharedAmount = Math.abs(aTheoretical - bTheoretical);
        amount = Math.min(amount, sharedAmount);
        adjustedForCustody = true;
      }
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

function lookupGeneralCareBracket(table, income) {
  // table: [{incomeAmount, basePct, baseSupport, marginalPct}, ...] ascending.
  // Find the highest bracket whose incomeAmount <= income (matches MCSF's
  // "highest monthly income level that does not exceed the family's net
  // monthly income" rule).
  let bracket = table[0];
  for (const row of table) {
    if (income >= row.incomeAmount) bracket = row;
    else break;
  }
  return bracket;
}

function calcMichiganFormula(params, rules, inputs) {
  // Michigan Child Support Formula: General Care Equation per parent, then the
  // Parental Time Offset Equation. inputs: { parentANetIncome, parentBNetIncome,
  // numChildren, overnightsWithA, overnightsWithB } — MI counts each parent's
  // own annual overnights directly (not a single "overnightsWithA" split of 365).
  const threshold = params.low_income_threshold_monthly;
  const bracket = inputs.numChildren >= 5 ? '5' : String(inputs.numChildren);
  const table = params.general_care_tables[bracket];

  const aAboveThreshold = inputs.parentANetIncome > threshold;
  const bAboveThreshold = inputs.parentBNetIncome > threshold;
  // Simplification: if either parent is at/below the Low Income Threshold, the
  // per-parent Low Income Equation (10% of that parent's own income) applies
  // instead of the General Care Equation — implemented for both parents below,
  // but the "exclude from family income" nuance in MCSF 2.09(B) for the OTHER
  // parent's calc is not modeled here (documented simplification).
  function baseObligation(ownIncome, otherIncome, ownShare) {
    if (ownIncome <= threshold) {
      return ownIncome * 0.10;
    }
    const familyIncome = ownIncome + (otherIncome > threshold ? otherIncome : 0);
    const row = lookupGeneralCareBracket(table, familyIncome);
    const g = (row.baseSupport + row.marginalPct * (familyIncome - row.incomeAmount)) * ownShare;
    return g;
  }

  const combined = inputs.parentANetIncome + inputs.parentBNetIncome;
  const shareA = inputs.parentANetIncome / combined;
  const shareB = 1 - shareA;

  const As = baseObligation(inputs.parentANetIncome, inputs.parentBNetIncome, shareA);
  const Bs = baseObligation(inputs.parentBNetIncome, inputs.parentANetIncome, shareB);

  const Ao = inputs.overnightsWithA;
  const Bo = 365 - Ao;
  const AoP = Math.pow(Ao, 2.5);
  const BoP = Math.pow(Bo, 2.5);
  const offset = (AoP * Bs - BoP * As) / (AoP + BoP);

  const payingParent = offset < 0 ? 'A' : 'B';
  let amount = Math.abs(offset);
  amount = applyRounding(amount, rules.rounding);

  const payingParentIncome = payingParent === 'A' ? inputs.parentANetIncome : inputs.parentBNetIncome;
  const belowReserve = payingParentIncome <= threshold;

  return {
    monthlyAmount: amount,
    payingParent,
    combinedIncome: combined,
    deviationNote: rules.deviation_note,
    capWarning: belowReserve
      ? `The paying parent's income is at or below Michigan's Low Income Threshold ($${threshold.toLocaleString()}/mo) — a different Low Income Equation applies, which this estimate already uses, but courts retain discretion in these cases.`
      : null
  };
}

function calcAlgebraicKFactor(params, rules, inputs) {
  // California Fam. Code 4055: CS = K x [HN - (H% x TN)]
  // HN = higher earner's net monthly disposable income
  // H% = higher earner's custody timeshare (0-1)
  // TN = total net monthly disposable income of both parties
  // K = (1+H% if H%<=50%, else 2-H%) x a fraction that is a piecewise
  // function of TN itself (verbatim from the statute, not approximated):
  //   TN <= 2900:        0.165 + TN/82,857
  //   2900 < TN <= 5000:  0.131 + TN/42,149
  //   5000 < TN <= 10000: 0.250
  //   10000 < TN <= 15000: 0.10 + 1,499/TN
  //   TN > 15000:          0.12 + 1,200/TN
  // CS is computed for 1 child, then multiplied by a statutory per-child-count
  // multiplier (2 children: 1.6, 3: 2, ... 10: 2.86) -- the multiplier applies
  // to the whole CS amount, K itself does not vary by child count.
  const netA = inputs.parentANetIncome;
  const netB = inputs.parentBNetIncome;
  const higherIsA = netA >= netB;
  const HN = higherIsA ? netA : netB;
  const TN = netA + netB;
  const Hpct = inputs.higherEarnerTimesharePct;

  let fraction;
  if (TN <= 2900) fraction = 0.165 + TN / 82857;
  else if (TN <= 5000) fraction = 0.131 + TN / 42149;
  else if (TN <= 10000) fraction = 0.250;
  else if (TN <= 15000) fraction = 0.10 + 1499 / TN;
  else fraction = 0.12 + 1200 / TN;

  const K = (Hpct <= 0.5 ? (1 + Hpct) : (2 - Hpct)) * fraction;
  const cs1Child = K * (HN - (Hpct * TN));

  const childKey = String(Math.min(inputs.numChildren, 10));
  const multiplier = params.child_multipliers[childKey] || 1;
  let amount = cs1Child * multiplier;

  // Per statute: a positive result means the higher earner pays; negative
  // means the LOWER earner pays the absolute value (can happen when the
  // higher earner also has majority timeshare).
  const higherEarnerPays = amount >= 0;
  const payingParent = higherEarnerPays ? (higherIsA ? 'A' : 'B') : (higherIsA ? 'B' : 'A');
  amount = Math.abs(amount);
  amount = applyRounding(amount, rules.rounding);

  return {
    monthlyAmount: amount,
    payingParent,
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
    case 'michigan_formula':
      return calcMichiganFormula(stateEntry.params, rules, inputs);
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
  const rows = scheduleTable.rows;
  const maxKeyAvailable = Math.max(...Object.keys(rows[0].obligation).map(Number));
  const key = numChildren >= maxKeyAvailable ? String(maxKeyAvailable) : String(numChildren);

  if (combinedIncome > scheduleTable.maxIncome && scheduleTable.aboveCapPercentages) {
    // Some states (e.g. Indiana) define an exact fixed percentage of the
    // excess above the table's top bracket, rather than leaving it to
    // undocumented discretion — apply it precisely when available.
    const capRow = rows[rows.length - 1];
    const pctKey = numChildren >= maxKeyAvailable ? String(maxKeyAvailable) : String(numChildren);
    const excess = combinedIncome - scheduleTable.maxIncome;
    return capRow.obligation[key] + excess * scheduleTable.aboveCapPercentages[pctKey];
  }

  const capped = Math.min(combinedIncome, scheduleTable.maxIncome);
  if (capped <= rows[0].upTo) return rows[0].obligation[key];
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i], b = rows[i + 1];
    if (capped > a.upTo && capped <= b.upTo) {
      // Linear interpolation between the two nearest real anchor rows —
      // official schedule tables are smooth/monotonic between adjacent
      // increments, so this closely approximates the real table even when
      // anchors are spaced further apart than the table's native increment.
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
