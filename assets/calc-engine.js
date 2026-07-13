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
  if (params.minimum_monthly) amount = Math.max(amount, params.minimum_monthly);
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
  let payingParent = aIsCustodial ? 'B' : 'A';
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

  if (rules.tn_parenting_and_ssr) {
    // Tennessee's mechanism (Tenn. Comp. R. & Regs. 1240-02-04-.04(7)(h)/.03(2)(b)2):
    // First, if the paying (ARP) parent has 92+ days/year of parenting time, a
    // "variable multiplier" adjusts the BCSO: multiplier = ARP's days ×
    // 0.0109589 (= 2/182.5), adjustedBCSO = baseObligation × multiplier, and
    // the difference (adjustedBCSO - baseObligation) is prorated by the
    // OTHER (custodial) parent's income share and credited against the
    // paying parent's prorated share — verified against the rule's own
    // worked example (94 days, $1,000 BCSO, 40% custodial share -> $587.94).
    // Second, that result is compared against a schedule lookup at the
    // paying parent's own income alone; the LESSER of the two applies (this
    // is what implements the Self-Support Reserve — if the individual lookup
    // wins, the paying parent effectively loses the parenting-time credit).
    const tn = rules.tn_parenting_and_ssr;
    const custodialShare = 1 - payingShare;
    let arpAmount = baseObligation * payingShare;
    let adjustedForCustody = false;
    if (payingParentOvernights >= tn.parenting_credit_threshold_days) {
      const multiplier = payingParentOvernights * tn.per_diem_multiplier;
      const adjustedBCSO = baseObligation * multiplier;
      const diff = adjustedBCSO - baseObligation;
      const credit = diff * custodialShare;
      arpAmount = Math.max(0, (baseObligation * payingShare) - credit);
      adjustedForCustody = true;
    }
    const individualObligation = lookupSchedule(scheduleTable, payingParentIncome, inputs.numChildren);
    const ssrApplied = individualObligation < arpAmount;
    const finalAmount = Math.min(individualObligation, arpAmount) + addOns;
    const amount = applyRounding(finalAmount, rules.rounding);
    return {
      monthlyAmount: amount,
      payingParent,
      combinedIncome: combined,
      baseObligation,
      adjustedForCustody: adjustedForCustody && !ssrApplied,
      deviationNote: rules.deviation_note,
      capWarning: ssrApplied
        ? "Self-Support Reserve applies — computed from the paying parent's own income alone (Tenn. Comp. R. & Regs. 1240-02-04-.03(2)(b)2), which also means the parenting-time credit does not apply even if the paying parent has 92+ days/year."
        : null
    };
  }

  if (rules.sd_lesser_of_monthly) {
    // South Dakota (SDCL 25-7-6.2): if the obligation using ONLY the paying
    // parent's own monthly net income falls within the schedule's emboldened
    // (self-support-reserve) areas, compare it to the standard combined-
    // income-prorated amount and use the LESSER — already in monthly terms
    // (unlike Ohio's annual worksheet), so no /12 conversion is needed here.
    const individualObligation = lookupSchedule(scheduleTable, payingParentIncome, inputs.numChildren);
    const proratedObligation = baseObligation * payingShare;
    const ssrApplied = individualObligation < proratedObligation;
    const amount = applyRounding(Math.min(individualObligation, proratedObligation) + addOns, rules.rounding);
    return {
      monthlyAmount: amount,
      payingParent,
      combinedIncome: combined,
      baseObligation,
      adjustedForCustody: false,
      deviationNote: rules.deviation_note,
      capWarning: ssrApplied
        ? "Self-Support Reserve applies (SDCL 25-7-6.2) — the paying parent's own-income schedule lookup is lower than the standard prorated amount, so the lower figure applies."
        : null
    };
  }

  if (rules.mo_lesser_of_with_credit) {
    // Missouri's mechanism (Form 14 Directions, Line 5/11 comments): the
    // overnight-visitation credit (a stepped percentage of the FULL basic
    // child support amount, by number of overnights) is computed ONCE, then
    // when the paying parent's income falls in the schedule's shaded
    // (self-support reserve) area, TWO calculations are compared using that
    // SAME credit dollar amount: (A) the standard combined-income-prorated
    // amount, and (B) the paying parent's own individual-income schedule
    // lookup (at 100%, not prorated). The LOWER of (A) and (B) applies.
    const overnightPct = stepLookup(rules.custody_adjustment.table, payingParentOvernights);
    const creditAmount = baseObligation * overnightPct;
    const addOnsShare = addOns * payingShare;
    const amountA = (baseObligation * payingShare) - creditAmount + addOnsShare;
    const individualObligation = lookupSchedule(scheduleTable, payingParentIncome, inputs.numChildren);
    const amountB = individualObligation - creditAmount + addOnsShare;
    const ssrApplied = amountB < amountA;
    const finalAmount = Math.max(0, Math.min(amountA, amountB));
    const amount = applyRounding(finalAmount, rules.rounding);
    return {
      monthlyAmount: amount,
      payingParent,
      combinedIncome: combined,
      baseObligation,
      adjustedForCustody: overnightPct > 0,
      deviationNote: rules.deviation_note,
      capWarning: ssrApplied
        ? "Self-Support Reserve applies (Form 14 shaded area) — the lower amount comes from a schedule lookup at the paying parent's own income alone, not the standard combined-income proration."
        : null
    };
  }

  if (rules.ky_lesser_of_ssr_or_credit) {
    // Kentucky's mechanism (KRS 403.212(5), 403.2122(3)(c)): the Self-Support
    // Reserve and the Shared Parenting Time Credit are NOT applied together
    // — the obligor pays whichever produces the LESSER amount. SSR: if the
    // paying parent's income is at/below a per-child-count ceiling, the
    // obligation is a schedule lookup at that parent's own income alone
    // (KRS 403.212(5)(b)). Shared parenting credit: a stepped percentage
    // (88+ days/year, 15%-50%) of the FULL combined obligation, subtracted
    // from the standard prorated share (KRS 403.2122(4)).
    const ky = rules.ky_lesser_of_ssr_or_credit;
    const proratedAmount = totalObligation * payingShare;
    let creditAdjustedAmount = proratedAmount;
    let creditApplied = false;
    if (payingParentOvernights >= ky.credit_threshold_days) {
      const creditPct = stepLookup(ky.credit_table, payingParentOvernights);
      creditAdjustedAmount = Math.max(0, proratedAmount - (baseObligation * creditPct));
      creditApplied = creditPct > 0;
    }

    const bracket = String(inputs.numChildren >= 6 ? 6 : inputs.numChildren);
    const shadedCeiling = ky.self_support_zone_max[bracket];
    let finalAmount = creditAdjustedAmount;
    let ssrApplied = false;
    if (shadedCeiling && payingParentIncome <= shadedCeiling) {
      const individualObligation = lookupSchedule(scheduleTable, payingParentIncome, inputs.numChildren);
      if (individualObligation < finalAmount) {
        finalAmount = individualObligation;
        ssrApplied = true;
      }
    }

    if (finalAmount < ky.minimum_order_monthly) finalAmount = ky.minimum_order_monthly;
    const amount = applyRounding(finalAmount, rules.rounding);

    return {
      monthlyAmount: amount,
      payingParent,
      combinedIncome: combined,
      baseObligation,
      adjustedForCustody: creditApplied && !ssrApplied,
      deviationNote: rules.deviation_note,
      capWarning: ssrApplied
        ? "Self-Support Reserve applies (KRS 403.212(5)(b)) — computed from the paying parent's own income alone, since it produced a lower amount than the shared parenting time credit."
        : null
    };
  }

  const skipLesserOfForSharedCustody = rules.custody_adjustment
    && rules.custody_adjustment.type === 'sc_shared_custody'
    && payingParentOvernights > (rules.custody_adjustment.threshold_days || 109);

  if (rules.pa_lesser_of_calculations && !skipLesserOfForSharedCustody) {
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
    } else if (rules.custody_adjustment.type === 'oregon_sigmoid_credit') {
      // Oregon's exact parenting time credit formula, OAR 137-050-0730(6):
      //   credit% = 1/(1+e^(-7.14*((overnights/365)-0.5))) - 0.0274 + (2*0.0274*(overnights/365))
      // a genuine logistic curve, not a lookup table — verbatim from the
      // rule text, not approximated. Applied to the basic obligation
      // (before add-ons), then subtracted from the paying parent's share.
      const f = payingParentOvernights / 365;
      const creditPct = 1 / (1 + Math.exp(-7.14 * (f - 0.5))) - 0.0274 + (2 * 0.0274 * f);
      amount = Math.max(0, amount - (baseObligation * creditPct));
      adjustedForCustody = creditPct > 0;
    } else if (rules.custody_adjustment.type === 'stepped_days_table') {
      // e.g. Arizona's Parenting Time Table — a true step function by day-range,
      // NOT interpolated (a real 100-114 day range all uses the same .175 credit).
      const creditPct = stepLookup(rules.custody_adjustment.table, payingParentOvernights);
      amount = Math.max(0, amount - (totalObligation * creditPct));
      adjustedForCustody = creditPct > 0;
    } else if (rules.custody_adjustment.type === 'parenting_time_pow25') {
      // Power-of-N parenting time cross-formula. Georgia: O.C.G.A. §
      // 19-6-15(g)(2)(B) (SB454, eff. 2026-01-01), power 2.5. Minnesota:
      // Minn. Stat. § 518A.36 subd. 2, power 3 (same structural formula,
      // different exponent — set via rules.custody_adjustment.power,
      // defaulting to 2.5 for backward compatibility with Georgia's rules
      // files that don't specify one). Raises each parent's annual
      // overnights to the power, then cross-multiplies against the OTHER
      // parent's dollar share of the BASE obligation (add-ons are prorated
      // separately, unaffected by this adjustment):
      //   adjustment = (ncpDaysPow * cpShare$ - cpDaysPow * ncpShare$) / (ncpDaysPow + cpDaysPow)
      //   ncpObligation = ncpShare$ + adjustment
      const power = rules.custody_adjustment.power || 2.5;
      const ncpDays = payingParentOvernights;
      const cpDays = 365 - ncpDays;
      const ncpShareDollars = baseObligation * payingShare;
      const cpShareDollars = baseObligation - ncpShareDollars;
      const ncpDaysPow = Math.pow(ncpDays, power);
      const cpDaysPow = Math.pow(cpDays, power);
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
      const multiplier = rules.custody_adjustment.multiplier || 1.4;
      if (payingParentOvernights > threshold) {
        const custodyShareA = overnightsWithA / 365;
        const custodyShareB = 1 - custodyShareA;
        const sharedSupportNeed = baseObligation * multiplier;
        let aTheoretical = (sharedSupportNeed * custodyShareB + addOns) * shareA;
        let bTheoretical = (sharedSupportNeed * custodyShareA + addOns) * shareB;
        // Maryland-style narrow-band bonus (Md. Fam. Law § 12-204(m)(2)(ii)):
        // in our convention payingParentOvernights is always the FEWER of the
        // two (<=182.5), so a narrow low-end band (e.g. 92-109 nights) can
        // only ever apply to the paying parent's theoretical amount, never
        // the custodial parent's.
        const nb = rules.custody_adjustment.narrow_band_bonus;
        if (nb && payingParentOvernights >= (rules.custody_adjustment.narrow_band_min || 0)
            && payingParentOvernights <= (rules.custody_adjustment.narrow_band_max || Infinity)) {
          const bonusPct = stepLookup(nb, payingParentOvernights);
          if (payingParent === 'A') aTheoretical += aTheoretical * bonusPct;
          else bTheoretical += bTheoretical * bonusPct;
        }
        const sharedAmount = Math.abs(aTheoretical - bTheoretical);
        amount = Math.min(amount, sharedAmount);
        adjustedForCustody = true;
      }
    } else if (rules.custody_adjustment.type === 'ok_parenting_time_factor') {
      // Oklahoma's Parenting Time Adjustment, 43 O.S. § 118E: triggers when
      // the paying parent has 121+ overnights/year. The combined base
      // obligation is multiplied by a stepped factor (2.0 / 1.75 / 1.5 for
      // 121-131 / 132-143 / 144+ overnights), divided between parents by
      // income share, then EACH parent's share is multiplied by the
      // percentage of time the child spends with the OTHER parent, and the
      // two resulting amounts are offset — capped so the result never
      // exceeds the standard (non-adjusted) sole-custody amount.
      const threshold = rules.custody_adjustment.threshold_overnights || 121;
      if (payingParentOvernights >= threshold) {
        const factor = stepLookup(rules.custody_adjustment.factor_table, payingParentOvernights);
        const adjustedCombined = totalObligation * factor;
        const custodyShareA = overnightsWithA / 365;
        const custodyShareB = 1 - custodyShareA;
        const aShare = (adjustedCombined * shareA) * custodyShareB;
        const bShare = (adjustedCombined * shareB) * custodyShareA;
        const sharedAmount = Math.abs(aShare - bShare);
        amount = Math.min(amount, sharedAmount);
        adjustedForCustody = true;
      }
    } else if (rules.custody_adjustment.type === 'sc_shared_custody') {
      // South Carolina's shared-custody Worksheet C (both parents >109
      // overnights/year, 30%+): basic obligation x1.5, apportioned to each
      // parent by THEIR OWN income share, then multiplied by the percentage
      // of time the child spends WITH THAT SAME parent (not the other
      // parent — this is the opposite cross-multiplication direction from
      // Virginia/Maryland's formula, verified against the rule text
      // verbatim). Whichever parent's result is larger pays the difference.
      // The 109-128 overnight graduated transition zone is not modeled here
      // (disclosed as a known gap) — this applies the full shared formula
      // whenever the threshold is met.
      const threshold = rules.custody_adjustment.threshold_days || 109;
      if (payingParentOvernights > threshold) {
        const custodyShareA = overnightsWithA / 365;
        const custodyShareB = 1 - custodyShareA;
        const sharedObligation = baseObligation * 1.5;
        const aObligation = sharedObligation * shareA * custodyShareA;
        const bObligation = sharedObligation * shareB * custodyShareB;
        // Unlike the standard majority-overnights convention used elsewhere,
        // this formula can make EITHER parent the actual payer — determined
        // here strictly from which computed obligation is larger, not from
        // who has more parenting time.
        payingParent = aObligation > bObligation ? 'A' : 'B';
        const finalShare = payingParent === 'A' ? shareA : shareB;
        amount = Math.abs(aObligation - bObligation) + (addOns * finalShare);
        adjustedForCustody = true;
      }
    }
  }

  let mnMinimumApplied = false;
  if (rules.mn_self_support_clamp) {
    // Minnesota's mechanism (Minn. Stat. § 518A.42): incomeAvailable =
    // obligor's PICS minus the Self-Support Reserve (120% of the one-person
    // federal poverty guideline). If incomeAvailable >= the guideline
    // amount (the parenting-time-adjusted `amount` above), no reduction. If
    // it's between the statutory minimum and the guideline amount, the
    // obligation is reduced down to incomeAvailable. If it's at/below the
    // minimum, or the obligor's gross income is itself below 120% FPL, the
    // flat statutory minimum applies instead.
    const mn = rules.mn_self_support_clamp;
    const minimumAmount = mn.minimums[String(inputs.numChildren >= 6 ? 6 : inputs.numChildren)];
    const incomeAvailable = payingParentIncome - mn.self_support_reserve_monthly;
    if (payingParentIncome < mn.self_support_reserve_monthly || incomeAvailable <= minimumAmount) {
      amount = minimumAmount;
      mnMinimumApplied = true;
    } else if (incomeAvailable < amount) {
      amount = incomeAvailable;
    }
  }

  let orMinimumApplied = false;
  if (rules.or_self_support_clamp) {
    // Oregon's mechanism (OAR 137-050-0745, -0755): the paying parent's
    // total obligation may not exceed their income available for support
    // (income minus the Self-Support Reserve), and a rebuttable $100/mo
    // minimum order applies (except at exactly equal parenting time).
    const or_ = rules.or_self_support_clamp;
    const availableIncome = Math.max(0, payingParentIncome - or_.self_support_reserve_monthly);
    if (amount > availableIncome) amount = availableIncome;
    if (amount < or_.min_order_monthly && payingParentOvernights !== 182.5) {
      amount = or_.min_order_monthly;
      orMinimumApplied = true;
    }
  }

  let neMinimumApplied = false;
  if (rules.ne_subsistence_clamp) {
    // Nebraska Ct. R. section 4-218 / 4-209: the paying parent's obligation
    // may not reduce their net income below the Basic Subsistence Limitation,
    // EXCEPT that the minimum support amount (the greater of $50 or 10% of
    // the obligor's net income, section 4-209) may still be ordered even if
    // it dips below that limitation.
    const ne = rules.ne_subsistence_clamp;
    const availableIncome = Math.max(0, payingParentIncome - ne.basic_subsistence_limitation_monthly);
    if (amount > availableIncome) amount = availableIncome;
    const statutoryMinimum = Math.max(ne.minimum_flat_amount, ne.minimum_pct_of_income * payingParentIncome);
    if (amount < statutoryMinimum) {
      amount = statutoryMinimum;
      neMinimumApplied = true;
    }
  }

  let wvAbilityToPayApplied = false;
  if (rules.wv_ability_to_pay && payingParentIncome < rules.wv_ability_to_pay.threshold_monthly) {
    // W. Va. Code 48-13-403, Part II (Ability to Pay Calculation), completed
    // only when the payor's adjusted gross income is below the threshold
    // (currently $2,600/mo): spendable income = 80% of that income; income
    // available for support = spendable minus the Self-Support Reserve
    // ($997/mo), floored at $50 if that would be less; the final order is
    // the LESSER of the standard recommended order or that available-income
    // figure (note: the $50 floor applies to the available-income term
    // itself, not to the final order, so a very small recommended order can
    // still come out below $50).
    const wv = rules.wv_ability_to_pay;
    const spendable = payingParentIncome * 0.80;
    let available = spendable - wv.self_support_reserve_monthly;
    if (available < 50) available = 50;
    if (amount > available) {
      amount = available;
      wvAbilityToPayApplied = true;
    }
  }

  amount = applyRounding(amount, rules.rounding);

  const reserve = params.self_support_reserve_monthly;
  const belowReserve = reserve && (payingParentIncome - amount) < reserve;
  const reservePeriodLabel = params.income_period === 'weekly' ? '/week' : '/mo';

  return {
    monthlyAmount: amount,
    payingParent,
    combinedIncome: combined,
    baseObligation,
    adjustedForCustody,
    belowSelfSupportReserve: belowReserve,
    selfSupportMinimumOrderApplied: mnMinimumApplied || orMinimumApplied || neMinimumApplied,
    deviationNote: rules.deviation_note,
    capWarning: mnMinimumApplied
      ? "Self-Support Reserve minimum applies (Minn. Stat. § 518A.42) — the paying parent's income available after the reserve is at or below the statutory minimum, so the flat minimum basic support amount applies instead of the guideline calculation."
      : (orMinimumApplied
        ? (rules.or_self_support_clamp.min_order_message || "Minimum order applies — a rebuttable minimum, since the calculated amount fell below it.")
        : (neMinimumApplied
          ? "Minimum support applies (Neb. Ct. R. § 4-209) — the greater of $50 or 10% of the paying parent's net income, which may apply even below the Basic Subsistence Limitation."
          : (wvAbilityToPayApplied
            ? "Ability to Pay Calculation applies (W. Va. Code § 48-13-403, Part II) — the paying parent's income available for support (80% of income minus the $997 Self-Support Reserve, floored at $50) is lower than the standard recommended order."
            : (custodyWarning || (belowReserve
              ? `This result would leave the paying parent below the state's self-support reserve ($${reserve.toLocaleString()}${reservePeriodLabel}) — courts typically adjust in this situation.`
              : null)))))
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

function calcNevadaFormula(params, rules, inputs) {
  // Nevada's Base Child Support Obligation (NAC 425.140). Like Wisconsin,
  // the base calculation uses the OBLIGOR's own gross income only, never
  // combined income — but Nevada has no shared-placement cross-formula
  // (deviations for time-sharing are purely discretionary under NAC
  // 425.150), and no income cap (the top tier has no upper bound).
  // inputs: { parentAGrossIncome, parentBGrossIncome, numChildren, overnightsWithA }
  const bracket = inputs.numChildren >= 6 ? '6' : String(inputs.numChildren);

  function tieredPercent(monthlyIncome) {
    let remaining = monthlyIncome;
    let prevCap = 0;
    let total = 0;
    for (const tier of params.income_tiers) {
      const cap = tier.upTo === null ? Infinity : tier.upTo;
      const portion = Math.max(0, Math.min(remaining, cap - prevCap));
      total += portion * tier.pct[bracket];
      remaining -= portion;
      prevCap = cap;
      if (remaining <= 0) break;
    }
    return total;
  }

  const overnightsWithA = inputs.overnightsWithA || 0;
  const aIsCustodial = overnightsWithA > 182.5;
  const payingParent = aIsCustodial ? 'B' : 'A';
  const payingIncome = payingParent === 'A' ? inputs.parentAGrossIncome : inputs.parentBGrossIncome;
  const amount = applyRounding(tieredPercent(payingIncome), rules.rounding);

  return {
    monthlyAmount: amount,
    payingParent,
    combinedIncome: inputs.parentAGrossIncome + inputs.parentBGrossIncome,
    baseObligation: null,
    adjustedForCustody: false,
    deviationNote: rules.deviation_note,
    capWarning: null
  };
}

function calcWisconsinFormula(params, rules, inputs) {
  // Wisconsin's Percentage of Income Standard (Wis. Admin. Code DCF 150).
  // Unlike income-shares states, the base calculation uses each parent's OWN
  // gross income individually, never combined income. inputs: {
  // parentAGrossIncome, parentBGrossIncome, numChildren, overnightsWithA }
  const bracket = inputs.numChildren >= 5 ? '5' : String(inputs.numChildren);

  function tieredPercent(monthlyIncome) {
    // High-income payers: the standard percentage applies to the first
    // tier of income, then progressively lower percentages apply to each
    // higher tier (Your Guide to Setting Support Amounts, DCF-P-DWSC824) --
    // verified against the guide's own worked example ($14,000/mo, 2
    // children -> $3,075: $7,000x25% + $5,500x20% + $1,500x15%).
    let remaining = monthlyIncome;
    let prevCap = 0;
    let total = 0;
    for (const tier of params.high_income_tiers) {
      const cap = tier.upTo === null ? Infinity : tier.upTo;
      const portion = Math.max(0, Math.min(remaining, cap - prevCap));
      total += portion * tier.pct[bracket];
      remaining -= portion;
      prevCap = cap;
      if (remaining <= 0) break;
    }
    return total;
  }

  const overnightsWithA = inputs.overnightsWithA || 0;
  const aIsCustodial = overnightsWithA > 182.5;
  const payingParent = aIsCustodial ? 'B' : 'A';
  const payingParentOvernights = payingParent === 'A' ? overnightsWithA : (365 - overnightsWithA);

  if (payingParentOvernights >= rules.shared_placement_threshold_days) {
    // Shared-placement formula (Your Guide, "Shared-placement cases"),
    // verified exactly against the guide's own worked example (2 children,
    // Parent A $2,000/60% custody, Parent B $3,000/40% custody -> $375
    // owed by Parent B):
    const custodyShareA = overnightsWithA / 365;
    const custodyShareB = 1 - custodyShareA;
    const line1A = tieredPercent(inputs.parentAGrossIncome);
    const line1B = tieredPercent(inputs.parentBGrossIncome);
    const line3A = (line1A * 1.5) * custodyShareB;
    const line3B = (line1B * 1.5) * custodyShareA;
    const finalPayingParent = line3A > line3B ? 'A' : 'B';
    const amount = applyRounding(Math.abs(line3A - line3B), rules.rounding);
    return {
      monthlyAmount: amount,
      payingParent: finalPayingParent,
      combinedIncome: inputs.parentAGrossIncome + inputs.parentBGrossIncome,
      baseObligation: null,
      adjustedForCustody: true,
      deviationNote: rules.deviation_note,
      capWarning: null
    };
  }

  const payingIncome = payingParent === 'A' ? inputs.parentAGrossIncome : inputs.parentBGrossIncome;
  const amount = applyRounding(tieredPercent(payingIncome), rules.rounding);
  return {
    monthlyAmount: amount,
    payingParent,
    combinedIncome: inputs.parentAGrossIncome + inputs.parentBGrossIncome,
    baseObligation: null,
    adjustedForCustody: false,
    deviationNote: rules.deviation_note,
    capWarning: null
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

function calcMontanaFormula(params, rules, inputs) {
  // Montana's Modified Melson Formula (ARM 37.62.101-148, tables eff.
  // 2026-02-01). NAI(parent) = income minus the Personal Allowance
  // ($1,729/mo, ARM 37.62.114). Primary Child Support Allowance is a fixed
  // monthly amount by number of children (ARM 37.62.121: 0.30x Personal
  // Allowance for the 1st child + 0.20x each for the 2nd/3rd + 0.10x each
  // additional — verified this formula reproduces the published table
  // exactly), prorated by each parent's share of combined NAI. SOLA is the
  // parent's remaining NAI (after their own primary share) times a factor
  // that rises with the number of children (ARM 37.62.128). Below 110
  // parenting days/year with the nonresidential parent, the transfer
  // payment IS simply that parent's total support amount — no further
  // cross-adjustment (unlike Delaware/Hawaii's Melson variants).
  const bracket = inputs.numChildren >= 8 ? '8' : String(inputs.numChildren);
  const naiA = Math.max(0, inputs.parentAGrossIncome - params.personal_allowance_monthly);
  const naiB = Math.max(0, inputs.parentBGrossIncome - params.personal_allowance_monthly);
  const combinedNAI = naiA + naiB;
  const shareA = combinedNAI > 0 ? naiA / combinedNAI : 0.5;
  const shareB = 1 - shareA;

  const addOns = (inputs.childcareCost || 0) + (inputs.healthInsuranceCost || 0);
  const primaryAllowance = params.primary_allowance_monthly[bracket] + addOns;
  const primaryA = shareA * primaryAllowance;
  const primaryB = shareB * primaryAllowance;

  const solaFactor = params.sola_factors[bracket];
  const solaBaseA = Math.max(0, naiA - primaryA);
  const solaBaseB = Math.max(0, naiB - primaryB);
  const solaA = solaBaseA * solaFactor;
  const solaB = solaBaseB * solaFactor;

  const totalSupportA = primaryA + solaA;
  const totalSupportB = primaryB + solaB;

  const overnightsWithA = inputs.overnightsWithA || 0;
  const aIsCustodial = overnightsWithA > 182.5;
  const payingParent = aIsCustodial ? 'B' : 'A';
  const payingParentOvernights = payingParent === 'A' ? overnightsWithA : (365 - overnightsWithA);
  const payingNAI = payingParent === 'A' ? naiA : naiB;
  let amount = payingParent === 'A' ? totalSupportA : totalSupportB;

  if (payingNAI > 0) {
    const minimumContribution = payingNAI * params.minimum_contribution_pct;
    amount = Math.max(amount, minimumContribution);
  }

  amount = applyRounding(amount, rules.rounding);

  const parentingDaysThreshold = rules.parenting_days_threshold || 110;
  const complexAllocation = payingParentOvernights > parentingDaysThreshold;

  return {
    monthlyAmount: amount,
    payingParent,
    combinedIncome: inputs.parentAGrossIncome + inputs.parentBGrossIncome,
    baseObligation: primaryA + primaryB,
    adjustedForCustody: false,
    deviationNote: rules.deviation_note,
    capWarning: complexAllocation
      ? `The nonresidential parent has more than ${parentingDaysThreshold} days/year with the child — ARM 37.62.134(2)(b) requires a per-child reallocation of each parent's obligation that this calculator does not compute. The amount shown is the standard (no-adjustment) figure only.`
      : null
  };
}

function calcHawaiiMelson(params, rules, inputs) {
  // Hawaii's Modified Melson Formula (2024 Hawai'i Child Support Guidelines,
  // HRS §§ 571-52.5, 576D-7). Structurally different from Delaware's Melson
  // in several ways confirmed from the primary source: Base Primary Support
  // is a flat $455/child with NO per-household component (unlike DE's
  // per-child + per-household split); SOLA is a flat 10%/child capped at
  // 30% (not DE's tiered 12/17/21%+2%, and no High Income Offset); and
  // "Net Income" is officially gross minus actual 2022 tax tables AND the
  // Self-Support Reserve — this engine only subtracts the Self-Support
  // Reserve ($1,693/mo) since the real tax-conversion table (Appendix B,
  // "Table of Incomes") isn't reproducible without HI's exact 2022 federal/
  // state tax brackets, so this OVERSTATES true net income somewhat
  // (disclosed in the deviation note, not silently assumed exact).
  const netIncomeA = Math.max(0, inputs.parentAGrossIncome - params.self_support_reserve_monthly);
  const netIncomeB = Math.max(0, inputs.parentBGrossIncome - params.self_support_reserve_monthly);
  const combinedNet = netIncomeA + netIncomeB;
  const shareA = combinedNet > 0 ? netIncomeA / combinedNet : 0.5;
  const shareB = 1 - shareA;

  const addOns = (inputs.childcareCost || 0) + (inputs.healthInsuranceCost || 0);
  const primaryNeed = (inputs.numChildren * params.base_primary_support_per_child) + addOns;

  const solaIncomeA = Math.max(0, inputs.parentAGrossIncome - params.sola_income_deduction);
  const solaIncomeB = Math.max(0, inputs.parentBGrossIncome - params.sola_income_deduction);
  const combinedSolaIncome = solaIncomeA + solaIncomeB;
  const remainingSola = Math.max(0, combinedSolaIncome - primaryNeed);
  const solaPct = Math.min(params.sola_percentage_max, inputs.numChildren * params.sola_percentage_per_child);
  const solaAmount = remainingSola * solaPct;

  const totalChildSupport = primaryNeed + solaAmount;

  const overnightsWithA = inputs.overnightsWithA || 0;
  const aIsCustodial = overnightsWithA > 182.5;
  const payingParent = aIsCustodial ? 'B' : 'A';
  const payingNetIncome = payingParent === 'A' ? netIncomeA : netIncomeB;
  const payingShare = payingParent === 'A' ? shareA : shareB;

  let amount = Math.min(payingNetIncome, payingShare * totalChildSupport);

  const minOrder = inputs.numChildren * params.minimum_per_child;
  let minimumOrderApplied = false;
  if (amount < minOrder) {
    amount = minOrder;
    minimumOrderApplied = true;
  }

  amount = applyRounding(amount, rules.rounding);

  return {
    monthlyAmount: amount,
    payingParent,
    combinedIncome: inputs.parentAGrossIncome + inputs.parentBGrossIncome,
    baseObligation: primaryNeed,
    adjustedForCustody: false,
    selfSupportMinimumOrderApplied: minimumOrderApplied,
    deviationNote: rules.deviation_note,
    capWarning: null
  };
}

function calcMelson(params, rules, inputs) {
  // The real Melson Formula (Delaware Family Court Rules 502-504; also used
  // by Hawaii and Montana). Three steps: (1) each parent keeps a
  // Self-Support Allowance before anything else counts; (2) the children's
  // Primary Support need is prorated by each parent's share of remaining
  // Net Available Income (NAI); (3) a Standard of Living Adjustment (SOLA)
  // shares each parent's LEFTOVER income (after their own primary share)
  // with the children, at a percentage that rises with the number of
  // children, with a High Income Offset above 10x the Self-Support
  // Allowance. Known simplifications (disclosed in the deviation note):
  // no other-dependents adjustment, no private-school primary expense, and
  // health insurance/childcare are added as flat combined figures rather
  // than the worksheet's exact 3/4-vs-1/2 premium-sharing split.
  const ssa = params.self_support_allowance_monthly;
  const naiA = Math.max(0, inputs.parentAGrossIncome - ssa);
  const naiB = Math.max(0, inputs.parentBGrossIncome - ssa);
  const combinedNAI = naiA + naiB;
  const shareA = combinedNAI > 0 ? naiA / combinedNAI : 0.5;
  const shareB = 1 - shareA;

  const primaryAllowance = (inputs.numChildren * params.per_child_allowance) + params.per_household_allowance;
  const addOns = (inputs.childcareCost || 0) + (inputs.healthInsuranceCost || 0);
  const totalPrimaryNeed = primaryAllowance + addOns;
  const primaryA = shareA * totalPrimaryNeed;
  const primaryB = shareB * totalPrimaryNeed;

  const naiForSolaA = naiA - primaryA;
  const naiForSolaB = naiB - primaryB;
  const highIncomeThreshold = ssa * 10;
  const excessA = Math.max(0, naiForSolaA - highIncomeThreshold);
  const excessB = Math.max(0, naiForSolaB - highIncomeThreshold);
  const highIncomeOffset = (excessA + excessB) * params.high_income_offset_pct;
  const combinedNaiForSola = Math.max(0, (naiForSolaA + naiForSolaB) - highIncomeOffset);

  const bracket = inputs.numChildren >= 3 ? '3' : String(inputs.numChildren);
  const solaPct = params.sola_percentages[bracket]
    + (inputs.numChildren > 3 ? (inputs.numChildren - 3) * params.sola_percentage_per_additional_child : 0);
  const solaCombined = combinedNaiForSola * solaPct;
  const solaA = solaCombined * shareA;
  const solaB = solaCombined * shareB;

  const overnightsWithA = inputs.overnightsWithA || 0;
  const aIsCustodial = overnightsWithA > 182.5;
  const payingParent = aIsCustodial ? 'B' : 'A';
  const payingParentOvernights = payingParent === 'A' ? overnightsWithA : (365 - overnightsWithA);
  let amount = (payingParent === 'A' ? (primaryA + solaA) : (primaryB + solaB));

  let adjustedForCustody = false;
  if (rules.custody_adjustment && rules.custody_adjustment.type === 'stepped_days_table') {
    const creditPct = stepLookup(rules.custody_adjustment.table, payingParentOvernights);
    amount = Math.max(0, amount * (1 - creditPct));
    adjustedForCustody = creditPct > 0;
  }

  const payingParentNAI = payingParent === 'A' ? naiA : naiB;
  const selfSupportProtection = payingParentNAI * params.self_support_protection_pct;
  const cappedBySelfSupportProtection = amount > selfSupportProtection;
  if (cappedBySelfSupportProtection) amount = selfSupportProtection;

  const minOrder = inputs.numChildren >= 2 ? params.minimum_order_multiple_children : params.minimum_order_one_child;
  let minimumOrderApplied = false;
  if (amount < minOrder) {
    amount = minOrder;
    minimumOrderApplied = true;
  }

  amount = applyRounding(amount, rules.rounding);

  return {
    monthlyAmount: amount,
    payingParent,
    combinedIncome: inputs.parentAGrossIncome + inputs.parentBGrossIncome,
    baseObligation: primaryA + primaryB,
    adjustedForCustody,
    selfSupportMinimumOrderApplied: minimumOrderApplied,
    deviationNote: rules.deviation_note,
    capWarning: minimumOrderApplied
      ? null
      : (cappedBySelfSupportProtection
        ? `Self-Support Protection applies — the paying parent's obligation is capped at ${(params.self_support_protection_pct * 100).toFixed(0)}% of their own Net Available Income.`
        : null)
  };
}

function calcIdahoFormula(params, rules, inputs) {
  // Idaho Rule 120 computes the Basic Child Support obligation as a series of
  // MARGINAL brackets over ANNUAL combined Guidelines Income (like a tax
  // bracket, not a flat schedule lookup) -- e.g. for 2 children: 26% of the
  // first $10,000, 25% of the next $10,000, 23% of the next $10,000, etc.
  // Verified exactly against the rule's own worked example: $25,000 +
  // $10,000 combined = $35,000, 2 children -> $217+$208+$192+$92 = $709/mo.
  // inputs: { parentAGrossIncome, parentBGrossIncome, numChildren, overnightsWithA,
  //           childcareCost, healthInsuranceCost } -- gross MONTHLY incomes.
  const id = rules.id_brackets;
  const key = String(Math.min(inputs.numChildren, 5));
  const brackets = id.schedules[key];
  const combinedMonthly = inputs.parentAGrossIncome + inputs.parentBGrossIncome;
  const annualCombined = combinedMonthly * 12;

  let remaining = annualCombined;
  let annualObligation = 0;
  for (const b of brackets) {
    const portion = Math.min(remaining, b.width);
    annualObligation += portion * b.pct;
    remaining -= portion;
    if (remaining <= 0) break;
  }
  const baseObligation = annualObligation / 12;

  const shareA = inputs.parentAGrossIncome / combinedMonthly;
  const shareB = 1 - shareA;
  const addOns = (inputs.childcareCost || 0) + (inputs.healthInsuranceCost || 0);

  const overnightsWithA = inputs.overnightsWithA || 0;
  const overnightsWithB = 365 - overnightsWithA;
  const aPct = (overnightsWithA / 365) * 100;
  const bPct = 100 - aPct;

  let payingParent;
  let amount;
  let adjustedForCustody = false;

  if (aPct <= 25 || bPct <= 25) {
    // Primary Parenting Time (Rule 120(3)(B)): one parent has 25% or less of
    // the overnights -- standard prorated calculation, no adjustment.
    payingParent = aPct <= bPct ? 'A' : 'B';
    const payingShare = payingParent === 'A' ? shareA : shareB;
    amount = (baseObligation + addOns) * payingShare;
  } else {
    // Shared Physical Custody (Rule 120(4)(B)): both parents have more than
    // 25% of the overnights. The basic obligation is multiplied by 1.5, each
    // parent's share of that pool is multiplied by their income share, then
    // by the percentage of time the child spends with the OTHER parent. The
    // two results are offset (the larger payer pays the difference), capped
    // so neither parent pays more than they would have under sole custody.
    const sharedPool = baseObligation * 1.5;
    const aAmt = sharedPool * shareA * (bPct / 100);
    const bAmt = sharedPool * shareB * (aPct / 100);
    payingParent = aAmt > bAmt ? 'A' : 'B';
    const payingShare = payingParent === 'A' ? shareA : shareB;
    const diff = Math.abs(aAmt - bAmt);
    const soleCustodyCap = baseObligation * payingShare;
    amount = Math.min(diff, soleCustodyCap) + (addOns * payingShare);
    adjustedForCustody = true;
  }

  const payingParentIncome = payingParent === 'A' ? inputs.parentAGrossIncome : inputs.parentBGrossIncome;
  let selfSupportReviewApplies = false;
  if (payingParentIncome < id.self_support_review_threshold_monthly) {
    const presumptiveMinimum = id.minimum_per_child_monthly * inputs.numChildren;
    if (amount < presumptiveMinimum) {
      amount = presumptiveMinimum;
    }
    selfSupportReviewApplies = true;
  }

  amount = applyRounding(amount, rules.rounding);

  return {
    monthlyAmount: amount,
    payingParent,
    combinedIncome: combinedMonthly,
    baseObligation,
    adjustedForCustody,
    deviationNote: rules.deviation_note,
    capWarning: selfSupportReviewApplies
      ? `Paying parent's monthly income is below $${id.self_support_review_threshold_monthly.toLocaleString()} -- Idaho courts review the case individually here, with a rebuttable presumption of at least $${id.minimum_per_child_monthly}/child/month.`
      : (annualCombined > id.max_annual_combined_income
        ? `Above $${id.max_annual_combined_income.toLocaleString()}/yr combined Guidelines Income, Idaho's bracket schedule does not extend further -- this result is capped at the top bracket.`
        : null)
  };
}

function calcMaineFormula(params, rules, scheduleTable, inputs) {
  // Maine's Schedule of Basic Support Obligation (19-A M.R.S. section 2006) has
  // a genuine unit mismatch: the table's left-hand axis is COMBINED ANNUAL
  // gross income, but each cell's dollar value is WEEKLY. inputs here are
  // annual gross incomes (matching the table's own axis exactly); the
  // looked-up weekly figure is converted to monthly (x 52/12) for display,
  // consistent with the rest of the site.
  // inputs: { parentAGrossIncome, parentBGrossIncome, numChildren, overnightsWithA,
  //           childcareCost, healthInsuranceCost } -- all in ANNUAL dollars.
  const me = rules.me_self_support_reserve;
  const combined = inputs.parentAGrossIncome + inputs.parentBGrossIncome;
  const shareA = inputs.parentAGrossIncome / combined;
  const shareB = 1 - shareA;

  const overnightsWithA = inputs.overnightsWithA || 0;
  const aIsCustodial = overnightsWithA > 182.5;
  const payingParent = aIsCustodial ? 'B' : 'A';
  const payingShare = payingParent === 'A' ? shareA : shareB;
  const payingParentIncome = payingParent === 'A' ? inputs.parentAGrossIncome : inputs.parentBGrossIncome;

  let amount;
  let selfSupportReserveApplied = false;
  if (payingParentIncome > 0 && payingParentIncome <= me.self_support_reserve_ceiling_annual) {
    const weeklyAmount = lookupSchedule(scheduleTable, payingParentIncome, inputs.numChildren);
    amount = weeklyAmount * (52 / 12);
    selfSupportReserveApplied = true;
  } else {
    const weeklyBase = lookupSchedule(scheduleTable, combined, inputs.numChildren);
    const basicEntitlementMonthly = weeklyBase * (52 / 12);
    const addOnsMonthly = ((inputs.childcareCost || 0) + (inputs.healthInsuranceCost || 0)) / 12;
    amount = (basicEntitlementMonthly + addOnsMonthly) * payingShare;
  }

  amount = applyRounding(amount, rules.rounding);

  return {
    monthlyAmount: amount,
    payingParent,
    combinedIncome: combined,
    baseObligation: null,
    adjustedForCustody: false,
    deviationNote: rules.deviation_note,
    capWarning: selfSupportReserveApplied
      ? `Self-Support Reserve applies (19-A M.R.S. section 2006(5)(C)) — computed from the paying parent's own annual income only, not combined income, with no add-ons.`
      : (combined > scheduleTable.maxIncome
        ? `Above $${scheduleTable.maxIncome.toLocaleString()}/yr combined income, the table amount is only a presumptive MINIMUM (19-A M.R.S. section 2006(5)(B)) — courts may order more.`
        : null)
  };
}

function maTableA(income) {
  // Massachusetts Table A, transcribed VERBATIM from the live calculation
  // script embedded in the official 2025 Child Support Guidelines Worksheet
  // (CJD 304, eff. 2025-12-01) -- a genuine piecewise-linear formula, not a
  // step-function chart, giving the 1-child weekly support amount.
  const capped = Math.min(income, 8654);
  if (capped <= 301) return 15;
  if (capped <= 391) return 15 + Math.round(0.20 * (capped - 301));
  if (capped <= 1000) return Math.round(0.22 * capped);
  if (capped <= 1600) return 220 + Math.round(0.21 * (capped - 1000));
  if (capped <= 2400) return 346 + Math.round(0.18 * (capped - 1600));
  if (capped <= 3500) return 490 + Math.round(0.14 * (capped - 2400));
  if (capped <= 5000) return 644 + Math.round(0.11 * (capped - 3500));
  return 809 + Math.round(0.10 * (capped - 5000));
}

function calcMassachusettsFormula(params, rules, inputs) {
  // inputs: { parentAGrossIncome, parentBGrossIncome, numChildren, overnightsWithA,
  //           childcareCost, healthInsuranceCost } -- weekly gross income.
  const ma = rules.ma_table_a;
  const numChildrenAdjustment = { 0: 0, 1: 1.00, 2: 1.40, 3: 1.68, 4: 1.85, 5: 1.94 };
  const multiplier = numChildrenAdjustment[Math.min(inputs.numChildren, 5)];

  const combined = inputs.parentAGrossIncome + inputs.parentBGrossIncome;
  const shareA = inputs.parentAGrossIncome / combined;
  const shareB = 1 - shareA;

  const overnightsWithA = inputs.overnightsWithA || 0;
  const aIsCustodial = overnightsWithA > 182.5;
  const payingParent = aIsCustodial ? 'B' : 'A';
  const payingShare = payingParent === 'A' ? shareA : shareB;
  const payingParentIncome = payingParent === 'A' ? inputs.parentAGrossIncome : inputs.parentBGrossIncome;

  let amount;
  let selfSupportReserveApplied = false;
  if (payingParentIncome <= ma.self_support_reserve_weekly) {
    // Shaded area of the Guidelines Chart: use the PAYING parent's own income
    // alone, regardless of the other parent's income -- this is their full
    // obligation directly, with no further proration and no add-ons.
    const base = maTableA(payingParentIncome);
    amount = Math.round(base * multiplier);
    selfSupportReserveApplied = true;
  } else {
    const base = maTableA(combined);
    const combinedSupport = Math.round(base * multiplier);
    const addOns = (inputs.childcareCost || 0) + (inputs.healthInsuranceCost || 0);
    amount = (combinedSupport + addOns) * payingShare;
  }

  amount = applyRounding(amount, rules.rounding);

  return {
    monthlyAmount: amount,
    payingParent,
    combinedIncome: combined,
    baseObligation: null,
    adjustedForCustody: false,
    deviationNote: rules.deviation_note,
    capWarning: selfSupportReserveApplied
      ? `Self-Support Reserve applies (shaded area of the Guidelines Chart) — computed from the paying parent's own weekly income alone, not combined income.`
      : (combined > ma.max_weekly_combined_income
        ? `Above $${ma.max_weekly_combined_income.toLocaleString()}/week ($450,000/yr) combined available income, this result is only a presumptive MINIMUM — courts may order more.`
        : null)
  };
}

function calcNorthDakotaFormula(params, rules, scheduleTable, inputs) {
  // North Dakota (NDAC 75-02-04.1-10) is an obligor-only schedule model, like
  // Nevada -- no combined income, no proration; the custodial parent's income
  // never factors in. The schedule is a real dollar-amount table (not a
  // tiered percentage), looked up directly against the paying parent's own
  // monthly net income.
  // inputs: { parentAGrossIncome, parentBGrossIncome, numChildren, overnightsWithA }
  const nd = rules.nd_extended_parenting_time;
  const overnightsWithA = inputs.overnightsWithA || 0;
  const aIsCustodial = overnightsWithA > 182.5;
  const payingParent = aIsCustodial ? 'B' : 'A';
  const payingParentIncome = payingParent === 'A' ? inputs.parentAGrossIncome : inputs.parentBGrossIncome;
  const payingParentOvernights = payingParent === 'A' ? overnightsWithA : (365 - overnightsWithA);

  const baseObligation = lookupSchedule(scheduleTable, payingParentIncome, inputs.numChildren);
  let amount = baseObligation;
  let adjustedForCustody = false;

  if (payingParentOvernights > nd.extended_parenting_time_threshold_overnights) {
    // NDAC 75-02-04.1-08.1: creditFactor = (365 - overnights x 0.32) / 365,
    // applied per child then summed -- since every child here shares the
    // same overnights figure, this collapses to one multiplicative factor
    // on the total obligation.
    const creditFactor = Math.max(0, 365 - payingParentOvernights * 0.32) / 365;
    amount = baseObligation * creditFactor;
    adjustedForCustody = true;
  }

  amount = applyRounding(amount, rules.rounding);

  return {
    monthlyAmount: amount,
    payingParent,
    combinedIncome: inputs.parentAGrossIncome + inputs.parentBGrossIncome,
    baseObligation,
    adjustedForCustody,
    deviationNote: rules.deviation_note,
    capWarning: null
  };
}

function calcUtahFormula(params, rules, scheduleTable, inputs) {
  // Utah Code 81-6-304 (combined-income table) / 81-6-305 (Low-Income Table,
  // obligor's own individual income only). Below a per-child-count individual
  // income threshold, 81-6-305 governs directly (no proration); above it,
  // 81-6-304's combined-income table is prorated by income share as usual.
  // inputs: { parentAGrossIncome, parentBGrossIncome, numChildren, overnightsWithA,
  //           childcareCost, healthInsuranceCost }
  const ut = rules.ut_low_income;
  const combined = inputs.parentAGrossIncome + inputs.parentBGrossIncome;
  const shareA = inputs.parentAGrossIncome / combined;
  const shareB = 1 - shareA;

  const overnightsWithA = inputs.overnightsWithA || 0;
  const aIsCustodial = overnightsWithA > 182.5;
  const payingParent = aIsCustodial ? 'B' : 'A';
  const payingShare = payingParent === 'A' ? shareA : shareB;
  const payingParentIncome = payingParent === 'A' ? inputs.parentAGrossIncome : inputs.parentBGrossIncome;

  const childKey = String(Math.min(inputs.numChildren, 6));
  const threshold = ut.threshold_individual_income[childKey];

  let amount;
  let lowIncomeApplied = false;
  if (payingParentIncome <= threshold) {
    amount = lookupSchedule(ut.schedule, payingParentIncome, inputs.numChildren);
    lowIncomeApplied = true;
  } else {
    const base = lookupSchedule(scheduleTable, combined, inputs.numChildren);
    const addOns = (inputs.childcareCost || 0) + (inputs.healthInsuranceCost || 0);
    amount = (base + addOns) * payingShare;
  }

  amount = applyRounding(amount, rules.rounding);

  return {
    monthlyAmount: amount,
    payingParent,
    combinedIncome: combined,
    baseObligation: null,
    adjustedForCustody: false,
    deviationNote: rules.deviation_note,
    capWarning: lowIncomeApplied
      ? "Low-Income Table applies (Utah Code 81-6-305) — computed from the paying parent's own individual income only, not combined income."
      : (combined > scheduleTable.maxIncome
        ? `Above $${scheduleTable.maxIncome.toLocaleString()}/mo combined income, Utah's table does not extend automatically — courts determine the amount case-by-case.`
        : null)
  };
}

function calcWyomingFormula(params, rules, inputs) {
  // Wyoming (Wyo. Stat. 20-2-304) computes the base obligation via marginal
  // brackets over combined MONTHLY net income (no annual conversion, unlike
  // Idaho's otherwise-similar bracket structure) -- verified against the
  // statute's own published base amounts at each breakpoint (within ~$1-2,
  // consistent with the statute's rates being rounded to one decimal place).
  // inputs: { parentAGrossIncome, parentBGrossIncome, numChildren, overnightsWithA,
  //           childcareCost, healthInsuranceCost } -- net monthly incomes.
  const wy = rules.wy_brackets;
  const key = String(Math.min(inputs.numChildren, 5));
  const brackets = wy.schedules[key];
  const combined = inputs.parentAGrossIncome + inputs.parentBGrossIncome;

  let remaining = combined;
  let baseObligation = 0;
  for (const b of brackets) {
    const width = b.width === undefined ? remaining : b.width;
    const portion = Math.min(remaining, width);
    baseObligation += portion * b.pct;
    remaining -= portion;
    if (remaining <= 0) break;
  }

  const shareA = inputs.parentAGrossIncome / combined;
  const shareB = 1 - shareA;
  const addOns = (inputs.childcareCost || 0) + (inputs.healthInsuranceCost || 0);

  const overnightsWithA = inputs.overnightsWithA || 0;
  const aIsCustodial = overnightsWithA > 182.5;
  const payingParent = aIsCustodial ? 'B' : 'A';
  const payingShare = payingParent === 'A' ? shareA : shareB;
  const payingParentOvernights = payingParent === 'A' ? overnightsWithA : (365 - overnightsWithA);
  const payingParentIncome = payingParent === 'A' ? inputs.parentAGrossIncome : inputs.parentBGrossIncome;

  let amount;
  let adjustedForCustody = false;
  if (payingParentOvernights > wy.shared_responsibility_threshold_overnights) {
    // Wyo. Stat. 20-2-304(c): when EACH parent has more than 25% of the
    // year's overnights, the total obligation is multiplied by 150%, split
    // by income share, then each parent's share is multiplied by the
    // percentage of time the child spends with the OTHER parent, and the
    // two amounts are offset.
    const sharedPool = baseObligation * wy.shared_responsibility_multiplier;
    const custodyShareA = overnightsWithA / 365;
    const custodyShareB = 1 - custodyShareA;
    const aAmt = sharedPool * shareA * custodyShareB;
    const bAmt = sharedPool * shareB * custodyShareA;
    const soleAmount = (baseObligation + addOns) * payingShare;
    amount = Math.min(soleAmount, Math.abs(aAmt - bAmt));
    adjustedForCustody = true;
  } else {
    amount = (baseObligation + addOns) * payingShare;
  }

  let selfSupportApplied = false;
  const available = payingParentIncome - wy.self_support_reserve_monthly;
  if (available < amount) {
    amount = Math.max(0, available);
    selfSupportApplied = true;
  }

  amount = applyRounding(amount, rules.rounding);

  return {
    monthlyAmount: amount,
    payingParent,
    combinedIncome: combined,
    baseObligation,
    adjustedForCustody,
    deviationNote: rules.deviation_note,
    capWarning: selfSupportApplied
      ? `Self-Support Reserve applies (Wyo. Stat. § 20-2-304(f)) — the paying parent's net income minus the reserve ($${wy.self_support_reserve_monthly.toLocaleString()}/mo) is lower than the standard obligation.`
      : null
  };
}

function calcDCFormula(params, rules, scheduleTable, inputs) {
  // DC Code 16-916.01/16-916.01a: the schedule and worksheet operate in
  // ANNUAL dollars (unlike most states) -- inputs here are annual income,
  // matching the schedule's own axis; the final result is converted to
  // monthly for display.
  // inputs: { parentAGrossIncome, parentBGrossIncome, numChildren, overnightsWithA,
  //           childcareCost, healthInsuranceCost } -- annual dollars.
  const dc = rules.dc_self_support;
  const combined = inputs.parentAGrossIncome + inputs.parentBGrossIncome;
  const shareA = inputs.parentAGrossIncome / combined;
  const shareB = 1 - shareA;

  const overnightsWithA = inputs.overnightsWithA || 0;
  const aIsCustodial = overnightsWithA > 182.5;
  const payingParent = aIsCustodial ? 'B' : 'A';
  const payingShare = payingParent === 'A' ? shareA : shareB;
  const payingParentIncome = payingParent === 'A' ? inputs.parentAGrossIncome : inputs.parentBGrossIncome;

  const base = lookupSchedule(scheduleTable, combined, inputs.numChildren);
  const addOns = (inputs.childcareCost || 0) + (inputs.healthInsuranceCost || 0);

  let annualAmount;
  let selfSupportApplied = false;
  let cappedAt35 = false;
  if (payingParentIncome < dc.self_support_reserve_annual) {
    // D.C. Code 16-916.01(g): below the Self-Support Reserve, the amount is
    // individualized by the court -- simplified here to the presumptive
    // $75/month ($900/year) minimum, rebuttable to $0 or higher.
    annualAmount = dc.presumptive_minimum_annual;
    selfSupportApplied = true;
  } else {
    annualAmount = (base + addOns) * payingShare;
    const cap = dc.total_obligation_cap_pct * payingParentIncome;
    if (annualAmount > cap) {
      annualAmount = cap;
      cappedAt35 = true;
    }
  }

  const monthly = applyRounding(annualAmount / 12, rules.rounding);

  return {
    monthlyAmount: monthly,
    payingParent,
    combinedIncome: combined,
    baseObligation: base,
    adjustedForCustody: false,
    deviationNote: rules.deviation_note,
    capWarning: selfSupportApplied
      ? `Self-Support Reserve applies (D.C. Code § 16-916.01(g)) — presumptive $${(dc.presumptive_minimum_annual / 12).toFixed(0)}/month minimum, rebuttable by the court based on the paying parent's individual circumstances.`
      : (cappedAt35
        ? "Capped at 35% of the paying parent's adjusted gross income (D.C. Code § 16-916.01(n)), including add-ons."
        : null)
  };
}

function calcKansasFormula(params, rules, scheduleTable, inputs) {
  // Kansas is the only state modeled here whose schedule varies by the AGE of
  // each child, not just the total count (Appendix II: separate One/Two/.../
  // Six Child Families tables, each with 0-5, 6-11, 12-18 columns). The
  // schedule file stores only the 12-18 base value per family size; the 0-5
  // and 6-11 amounts are derived at calc time via the guideline's own stated
  // method (base x 0.84, base x 0.94), not an approximation.
  // inputs: { parentAGrossIncome, parentBGrossIncome, children0to5, children6to11,
  //           children12to18, overnightsWithA }
  const ks = rules.ks_age_schedule;
  const combined = inputs.parentAGrossIncome + inputs.parentBGrossIncome;
  const numChildren = (inputs.children0to5 || 0) + (inputs.children6to11 || 0) + (inputs.children12to18 || 0);
  const familySizeKey = numChildren >= 6 ? '6' : String(Math.max(numChildren, 1));

  let base12to18;
  if (combined > scheduleTable.maxIncome) {
    const coef = ks.extended_formula_coefficients[familySizeKey];
    base12to18 = coef * Math.pow(combined, ks.extended_formula_exponent);
  } else {
    base12to18 = lookupSchedule(scheduleTable, combined, numChildren);
  }

  const perChild0to5 = Math.round(base12to18 * ks.age_multipliers['0-5']);
  const perChild6to11 = Math.round(base12to18 * ks.age_multipliers['6-11']);
  const perChild12to18 = Math.round(base12to18);

  const baseObligation = (inputs.children0to5 || 0) * perChild0to5
    + (inputs.children6to11 || 0) * perChild6to11
    + (inputs.children12to18 || 0) * perChild12to18;

  const shareA = inputs.parentAGrossIncome / combined;
  const shareB = 1 - shareA;

  const overnightsWithA = inputs.overnightsWithA || 0;
  const aIsCustodial = overnightsWithA > 182.5;
  const payingParent = aIsCustodial ? 'B' : 'A';
  const payingShare = payingParent === 'A' ? shareA : shareB;
  const payingParentOvernights = payingParent === 'A' ? overnightsWithA : (365 - overnightsWithA);
  const nonresidentialTimePct = (payingParentOvernights / 365) * 100;

  let amount = baseObligation * payingShare;
  let adjustedForCustody = false;
  for (const tier of ks.parenting_time_adjustment_table) {
    if (nonresidentialTimePct >= tier.minPct && nonresidentialTimePct <= tier.maxPct) {
      amount = amount * (1 - tier.reductionPct);
      adjustedForCustody = true;
      break;
    }
  }

  amount = applyRounding(amount, rules.rounding);

  return {
    monthlyAmount: amount,
    payingParent,
    combinedIncome: combined,
    baseObligation,
    adjustedForCustody,
    deviationNote: rules.deviation_note,
    capWarning: nonresidentialTimePct >= 50
      ? 'At 50% or more parenting time, Kansas uses a distinct shared-residency worksheet not modeled by this calculator — consult the official worksheet.'
      : (combined > scheduleTable.maxIncome
        ? `Above $${scheduleTable.maxIncome.toLocaleString()}/mo combined income, Kansas's extended formula is presumptive but the court retains discretion (Section IV.G).`
        : null)
  };
}

function calculateChildSupport(stateEntry, rules, scheduleTable, inputs) {
  switch (stateEntry.formula_model) {
    case 'percentage_of_income':
      return calcPercentageOfIncome(stateEntry.params, rules, inputs);
    case 'income_shares':
      return calcIncomeShares(stateEntry.params, rules, scheduleTable, inputs);
    case 'melson':
      return calcMelson(stateEntry.params, rules, inputs);
    case 'hi_melson':
      return calcHawaiiMelson(stateEntry.params, rules, inputs);
    case 'mt_melson':
      return calcMontanaFormula(stateEntry.params, rules, inputs);
    case 'algebraic_kfactor':
      return calcAlgebraicKFactor(stateEntry.params, rules, inputs);
    case 'michigan_formula':
      return calcMichiganFormula(stateEntry.params, rules, inputs);
    case 'wi_percentage_shared':
      return calcWisconsinFormula(stateEntry.params, rules, inputs);
    case 'nv_tiered_percentage':
      return calcNevadaFormula(stateEntry.params, rules, inputs);
    case 'ks_age_schedule':
      return calcKansasFormula(stateEntry.params, rules, scheduleTable, inputs);
    case 'id_bracket_shares':
      return calcIdahoFormula(stateEntry.params, rules, inputs);
    case 'me_weekly_table_annual_income':
      return calcMaineFormula(stateEntry.params, rules, scheduleTable, inputs);
    case 'ma_table_a_shares':
      return calcMassachusettsFormula(stateEntry.params, rules, inputs);
    case 'nd_obligor_schedule':
      return calcNorthDakotaFormula(stateEntry.params, rules, scheduleTable, inputs);
    case 'ut_low_income_or_shares':
      return calcUtahFormula(stateEntry.params, rules, scheduleTable, inputs);
    case 'wy_bracket_shares':
      return calcWyomingFormula(stateEntry.params, rules, inputs);
    case 'dc_annual_shares':
      return calcDCFormula(stateEntry.params, rules, scheduleTable, inputs);
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

  if (scheduleTable.stepBrackets) {
    // Some states (e.g. Minnesota) define the table as literal flat
    // brackets — a fixed dollar amount for an entire $100-wide income
    // range — rather than a smooth curve meant to be interpolated between
    // sparse anchors. Since every row is a real transcribed value here (not
    // a sparse sample), a true step lookup reproduces the statute exactly
    // instead of averaging across the bracket boundary.
    for (const row of rows) {
      if (capped <= row.upTo) return row.obligation[key];
    }
    return rows[rows.length - 1].obligation[key];
  }

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
  if (mode === 'round_down_whole_dollar') return Math.floor(amount);
  return amount;
}
