/* Simple-interest arrears calculator. Deliberately does not model compounding —
   states that compound (see the "compounds" flag per state) are disclosed as a
   known simplification rather than silently approximated. */
function calcArrearsInterest(principal, annualRatePct, days) {
  const interest = principal * (annualRatePct / 100) * (days / 365);
  return {
    interest: Math.round(interest * 100) / 100,
    total: Math.round((principal + interest) * 100) / 100
  };
}
