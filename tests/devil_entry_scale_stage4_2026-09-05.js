'use strict';
const fs = require('fs');
const dir = 'C:/Users/ymyin/AppData/Local/Temp/claude/C--garon/9fb2a66f-4b92-4222-82ac-935dd2763c7c/scratchpad';
const pop3 = JSON.parse(fs.readFileSync(dir + '/pop3_race_level.json', 'utf8'));
function mean(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; }
function stakeSum(pop) { return pop.length * 800; }
function returnSum(pop) { return pop.reduce(function (s, r) { return s + r.winPayoutYen; }, 0); }
function roi(pop) { return pop.length ? returnSum(pop) / stakeSum(pop) * 100 : null; }
function hitRate(pop) { return pop.length ? pop.filter(function (r) { return r.hit; }).length / pop.length * 100 : null; }
function calibErr(pop) { if (!pop.length) return null; return mean(pop.map(function (r) { return r.p0_p1; })) * 100 - mean(pop.map(function (r) { return r.actualIsBoat1 ? 1 : 0; })) * 100; }
function excludeTopNPayout(pop, nExclude) {
  const sorted = pop.slice().sort(function (a, b) { return b.winPayoutYen - a.winPayoutYen; });
  return sorted.slice(nExclude);
}
function summarize(pop, label) {
  return {
    label: label, n: pop.length,
    hitRatePct: hitRate(pop), roiPct: roi(pop),
    meanP0p1: mean(pop.map(function (r) { return r.p0_p1; })),
    actualBoat1RatePct: pop.length ? mean(pop.map(function (r) { return r.actualIsBoat1 ? 1 : 0; })) * 100 : null,
    calibErrPct: calibErr(pop),
    meanDiffRaw: mean(pop.map(function (r) { return r.diffRaw; })),
    roiExTop1Pct: roi(excludeTopNPayout(pop, 1)),
    roiExTop2Pct: roi(excludeTopNPayout(pop, 2)),
  };
}
console.log('=== Deciles of estimate, pop3 n=' + pop3.length + ' ===');
const sorted = pop3.slice().sort(function (a, b) { return a.estimate - b.estimate; });
const n = sorted.length, nBins = 10;
const binSize = Math.ceil(n / nBins);
const decileResults = [];
for (let i = 0; i < nBins; i++) {
  const slice = sorted.slice(i * binSize, (i + 1) * binSize);
  if (!slice.length) continue;
  const s = summarize(slice, 'decile' + i);
  s.estimateRange = [slice[0].estimate, slice[slice.length - 1].estimate];
  decileResults.push(s);
  console.log(JSON.stringify(s));
}
console.log('=== Top-X% by estimate ===');
['top20', 'top10', 'top5'].forEach(function (label, idx) {
  const pct = [0.2, 0.1, 0.05][idx];
  const cnt = Math.round(n * pct);
  const slice = sorted.slice(n - cnt);
  console.log(JSON.stringify(summarize(slice, label + ' (n=' + cnt + ')')));
});
console.log('=== Current threshold split (entered true/false) ===');
console.log(JSON.stringify(summarize(pop3.filter(function (r) { return r.entered; }), 'entered=true')));
console.log(JSON.stringify(summarize(pop3.filter(function (r) { return !r.entered; }), 'entered=false')));
console.log('=== EvalA/EvalB ===');
['EvalA', 'EvalB', 'Beyond0902', 'PreLearningBoundary'].forEach(function (p) {
  console.log(JSON.stringify(summarize(pop3.filter(function (r) { return r.period === p; }), p)));
});
console.log('=== By day (entered=true only, to see day concentration of hits) ===');
const byDay = {};
pop3.forEach(function (r) { (byDay[r.date] = byDay[r.date] || []).push(r); });
Object.keys(byDay).sort().forEach(function (d) {
  const enteredThatDay = byDay[d].filter(function (r) { return r.entered; });
  if (enteredThatDay.length) console.log(d, JSON.stringify(summarize(enteredThatDay, d)));
});
console.log('=== By venue (entered=true only) ===');
const byVenue = {};
pop3.filter(function (r) { return r.entered; }).forEach(function (r) { (byVenue[r.venue] = byVenue[r.venue] || []).push(r); });
Object.keys(byVenue).forEach(function (v) { console.log(JSON.stringify(summarize(byVenue[v], v))); });
console.log('=== kimariteMissing flag (entered=true only) ===');
console.log(JSON.stringify(summarize(pop3.filter(function (r) { return r.entered && r.kimariteMissingFlag; }), 'entered&missing')));
console.log(JSON.stringify(summarize(pop3.filter(function (r) { return r.entered && !r.kimariteMissingFlag; }), 'entered&notMissing')));
fs.writeFileSync(dir + '/stage4_deciles.json', JSON.stringify(decileResults, null, 2));
