# Child Support Calculator USA

Free child support calculator using each US state's official guideline formula, with a full guidelines/worksheet explainer per state — not just a bare calculator.

## Status

All 50 states + DC shipped and verified. See `research/sourcing-tracker.csv` and `research/verification-log.csv` for per-state research/verification status, and `research/PHASE3-RECAP.md` for a summary of known limitations and unmodeled edge cases.

## Architecture

- Static site, no framework. `generate-pages.js` reads `data/states.json` and builds one `[state-slug]/index.html` per state.
- `assets/calc-engine.js`: shared calculator engine (3 formula models: percentage of income, income shares, Melson).
- `data/rules/[state].json`: per-state exception layer (rounding, custody adjustments, income-cap behavior, deviation notes) — the shared engine alone is too simple for real guidelines.
- `data/schedules/[state]_schedule.json`: income-shares lookup tables (combined income × children → base obligation).
- `data/states.schema.json`: required fields per state entry; `generate-pages.js` refuses to build a page missing a cited source or verification date.
- `research/verification-log.csv`: test scenarios cross-checked against each state's official calculator/worksheet before shipping.

## Build

```
node generate-pages.js
node generate-sitemap.js
```

## Deploy

Cloudflare Pages, build command `node generate-pages.js && node generate-sitemap.js`, output directory `.`.

## Free Companion Tools

- [Overnight Parenting Time Calculator](https://sadiyaqeen92639572-cloud.github.io/overnight-custody-percentage-calculator/) — converts a parenting schedule's yearly overnights into an exact custody percentage and shows which states' shared-custody thresholds it crosses. Powered by [usachildsupportcalculator.com](https://usachildsupportcalculator.com/) for the actual state-by-state dollar calculation.
