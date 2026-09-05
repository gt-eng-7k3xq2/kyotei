'use strict';
// GARON-20260905-006 Stage8: endogenous selection continuity diagnostic (item 3)
const fs = require('fs');
const dir = 'C:/Users/ymyin/AppData/Local/Temp/claude/C--garon/9fb2a66f-4b92-4222-82ac-935dd2763c7c/scratchpad';
const pop3 = JSON.parse(fs.readFileSync(dir + '/pop3_race_level.json', 'utf8'));
const THRESH = 1.440209615716716;
function mean(a) { return a.length ? a.reduce((s,x)=>s+x,0)/a.length : null; }
function calibErr(pop, field) { field = field || 'p0_p1'; if (!pop.length) return null; return mean(pop.map(r=>r[field]))*100 - mean(pop.map(r=>r.actualIsBoat1?1:0))*100; }
function actualRate(pop) { return mean(pop.map(r=>r.actualIsBoat1?1:0)); }

console.log('THRESHOLD=', THRESH, 'pop3 n=', pop3.length);
console.log();
console.log('=== A: threshold-anchored bands (pre-specified, not tuned post-hoc) ===');
const bands = [
  { label: 'pop3 all', filter: r => true },
  { label: 'near-threshold +-10%', filter: r => r.estimate >= THRESH*0.9 && r.estimate <= THRESH*1.1 },
  { label: 'near-threshold +-20%', filter: r => r.estimate >= THRESH*0.8 && r.estimate <= THRESH*1.2 },
  { label: 'above 1.5x threshold', filter: r => r.estimate >= THRESH*1.5 },
  { label: 'top5% by estimate', filter: null },
  { label: 'entered=true (pop4)', filter: r => r.entered === true },
];
const sortedByEst = pop3.slice().sort((a,b)=>b.estimate-a.estimate);
const top5pctSet = new Set(sortedByEst.slice(0, Math.round(pop3.length*0.05)).map(r=>r.key));
bands.forEach(b => {
  const sub = b.label==='top5% by estimate' ? pop3.filter(r=>top5pctSet.has(r.key)) : pop3.filter(b.filter);
  console.log(b.label + ': n=' + sub.length + ' calibErr=' + (calibErr(sub)||0).toFixed(2) + 'pt actualRate=' + (actualRate(sub)*100).toFixed(1) + '% meanP0p1=' + (mean(sub.map(r=>r.p0_p1))*100).toFixed(1) + '%');
});

console.log();
console.log('=== estimate distribution diagnostics (to explain n=1 for 1.5x threshold band) ===');
const ests = pop3.map(r=>r.estimate).sort((a,b)=>a-b);
console.log('estimate: min=' + ests[0].toFixed(3) + ' p50=' + ests[Math.floor(ests.length*0.5)].toFixed(3) +
  ' p90=' + ests[Math.floor(ests.length*0.9)].toFixed(3) + ' p95=' + ests[Math.floor(ests.length*0.95)].toFixed(3) +
  ' p99=' + ests[Math.floor(ests.length*0.99)].toFixed(3) + ' max=' + ests[ests.length-1].toFixed(3));
console.log('threshold*1.2=' + (THRESH*1.2).toFixed(3) + ' threshold*1.5=' + (THRESH*1.5).toFixed(3));
const above12 = pop3.filter(r=>r.estimate>=THRESH*1.2);
console.log('above 1.2x threshold: n=' + above12.length + ' calibErr=' + (calibErr(above12)||0).toFixed(2) + 'pt actualRate=' + (actualRate(above12)*100).toFixed(1) + '%');

console.log();
console.log('=== B: deciles of model-market divergence (diffRaw = p0_p1 - market_p1_raw), pop3, n=10 bins ===');
const sortedDiff = pop3.slice().sort((a,b)=>a.diffRaw-b.diffRaw);
const n = sortedDiff.length, k = 10;
for (let i=0;i<k;i++) {
  const slice = sortedDiff.slice(Math.floor(i*n/k), Math.floor((i+1)*n/k));
  console.log('decile' + i + ': n=' + slice.length +
    ' diffRawRange=[' + slice[0].diffRaw.toFixed(3) + ',' + slice[slice.length-1].diffRaw.toFixed(3) + ']' +
    ' meanEstimate=' + mean(slice.map(r=>r.estimate)).toFixed(3) +
    ' enteredRate=' + (slice.filter(r=>r.entered).length/slice.length*100).toFixed(1) + '%' +
    ' actualBoat1Rate=' + (actualRate(slice)*100).toFixed(1) + '%' +
    ' calibErr=' + (calibErr(slice)||0).toFixed(2) + 'pt');
}

console.log();
console.log('=== C: split near-threshold band by entered/not-entered (RDD-style boundary check) ===');
const near10 = pop3.filter(r => r.estimate >= THRESH*0.9 && r.estimate <= THRESH*1.1);
const near10below = near10.filter(r => r.entered === false);
const near10above = near10.filter(r => r.entered === true);
console.log('near10% band n=' + near10.length);
console.log('  just-below-threshold (not entered) within band: n=' + near10below.length + ' calibErr=' + (calibErr(near10below)||0).toFixed(2) + 'pt actualRate=' + (actualRate(near10below)*100).toFixed(1) + '%');
console.log('  just-at/above-threshold (entered) within band: n=' + near10above.length + ' calibErr=' + (calibErr(near10above)||0).toFixed(2) + 'pt actualRate=' + (actualRate(near10above)*100).toFixed(1) + '%');

console.log();
console.log('=== D: finer breakdown of the extreme tail (top decile) for continuity vs sudden-jump check ===');
const top10pctSet = new Set(sortedByEst.slice(0, Math.round(pop3.length*0.10)).map(r=>r.key));
const top10pct = pop3.filter(r=>top10pctSet.has(r.key));
const top2pctSet = new Set(sortedByEst.slice(0, Math.round(pop3.length*0.02)).map(r=>r.key));
const top2pct = pop3.filter(r=>top2pctSet.has(r.key));
const top1pctSet = new Set(sortedByEst.slice(0, Math.round(pop3.length*0.01)).map(r=>r.key));
const top1pct = pop3.filter(r=>top1pctSet.has(r.key));
[['top10%', top10pct], ['top5%', pop3.filter(r=>top5pctSet.has(r.key))], ['top2%', top2pct], ['top1%', top1pct], ['entered=true(top6.5%)', pop3.filter(r=>r.entered===true)]].forEach(([label, sub]) => {
  console.log(label + ': n=' + sub.length + ' calibErr=' + (calibErr(sub)||0).toFixed(2) + 'pt actualRate=' + (actualRate(sub)*100).toFixed(1) + '%');
});
