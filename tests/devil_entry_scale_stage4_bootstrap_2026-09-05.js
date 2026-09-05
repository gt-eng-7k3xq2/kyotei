'use strict';
const fs = require('fs');
const dir = 'C:/Users/ymyin/AppData/Local/Temp/claude/C--garon/9fb2a66f-4b92-4222-82ac-935dd2763c7c/scratchpad';
const pop3 = JSON.parse(fs.readFileSync(dir + '/pop3_race_level.json', 'utf8'));
const byDay = {};
pop3.forEach(function (r) { (byDay[r.date] = byDay[r.date] || []).push(r); });
const days = Object.keys(byDay);
console.log('distinct days in pop3:', days.length);
function roiOf(pop) { if (!pop.length) return null; const stake = pop.length * 800; const ret = pop.reduce(function (s, r) { return s + r.winPayoutYen; }, 0); return ret / stake * 100; }
function hitRateOf(pop) { if (!pop.length) return null; return pop.filter(function (r) { return r.hit; }).length / pop.length * 100; }

const ITERS = 2000;
const diffRoi = [], enteredRoiArr = [], notEnteredRoiArr = [], enteredNArr = [];
const top10Adv = []; // top10% estimate roi - bottom90% roi, recomputed within resample using GLOBAL estimate cutoff learned from original data (fixed threshold approach) to avoid leakage of resample-specific cutoff
const sortedOrig = pop3.slice().sort(function (a, b) { return a.estimate - b.estimate; });
const top10CutIdx = Math.floor(sortedOrig.length * 0.9);
const top10CutoffEstimate = sortedOrig[top10CutIdx].estimate;

for (let it = 0; it < ITERS; it++) {
  const sampleDays = [];
  for (let i = 0; i < days.length; i++) sampleDays.push(days[Math.floor(Math.random() * days.length)]);
  let resample = [];
  sampleDays.forEach(function (d) { resample = resample.concat(byDay[d]); });
  const entered = resample.filter(function (r) { return r.entered; });
  const notEntered = resample.filter(function (r) { return !r.entered; });
  const top10 = resample.filter(function (r) { return r.estimate >= top10CutoffEstimate; });
  const bottom90 = resample.filter(function (r) { return r.estimate < top10CutoffEstimate; });
  const er = roiOf(entered), nr = roiOf(notEntered);
  enteredRoiArr.push(er); notEnteredRoiArr.push(nr); enteredNArr.push(entered.length);
  if (er != null && nr != null) diffRoi.push(er - nr);
  const tr = roiOf(top10), br = roiOf(bottom90);
  if (tr != null && br != null) top10Adv.push(tr - br);
}
function pct(arr, p) { const s = arr.slice().sort(function (a, b) { return a - b; }); return s[Math.floor(s.length * p)]; }
function mean(a) { return a.reduce(function (s, x) { return s + x; }, 0) / a.length; }
console.log('=== Block bootstrap by day (n=' + ITERS + ') ===');
console.log('entered ROI: mean=' + mean(enteredRoiArr.filter(function(x){return x!=null;})).toFixed(1) + ' p2.5=' + pct(enteredRoiArr.filter(function(x){return x!=null;}),0.025).toFixed(1) + ' p50=' + pct(enteredRoiArr.filter(function(x){return x!=null;}),0.5).toFixed(1) + ' p97.5=' + pct(enteredRoiArr.filter(function(x){return x!=null;}),0.975).toFixed(1));
console.log('notEntered ROI: mean=' + mean(notEnteredRoiArr.filter(function(x){return x!=null;})).toFixed(1) + ' p2.5=' + pct(notEnteredRoiArr.filter(function(x){return x!=null;}),0.025).toFixed(1) + ' p97.5=' + pct(notEnteredRoiArr.filter(function(x){return x!=null;}),0.975).toFixed(1));
console.log('diff (entered-notEntered) ROI: mean=' + mean(diffRoi).toFixed(1) + ' p2.5=' + pct(diffRoi,0.025).toFixed(1) + ' p50=' + pct(diffRoi,0.5).toFixed(1) + ' p97.5=' + pct(diffRoi,0.975).toFixed(1));
console.log('fraction of iters diff<=0:', (diffRoi.filter(function(x){return x<=0;}).length/diffRoi.length).toFixed(4));
console.log('entered n per iter: mean=' + mean(enteredNArr).toFixed(1) + ' p2.5=' + pct(enteredNArr,0.025) + ' p97.5=' + pct(enteredNArr,0.975));
console.log('top10%(fixed cutoff=' + top10CutoffEstimate.toFixed(4) + ') - bottom90% ROI diff: mean=' + mean(top10Adv).toFixed(1) + ' p2.5=' + pct(top10Adv,0.025).toFixed(1) + ' p97.5=' + pct(top10Adv,0.975).toFixed(1));
console.log('fraction top10Adv<=0:', (top10Adv.filter(function(x){return x<=0;}).length/top10Adv.length).toFixed(4));
