'use strict';
// GARON-20260905-006 Stage6: resolving control-set contradiction
const fs = require('fs');
const dir = 'C:/Users/ymyin/AppData/Local/Temp/claude/C--garon/9fb2a66f-4b92-4222-82ac-935dd2763c7c/scratchpad';
const pop3 = JSON.parse(fs.readFileSync(dir + '/pop3_race_level.json', 'utf8'));
const pop4 = pop3.filter(r => r.entered === true);
const pop5clean = pop3.filter(r => r.entered === false);
const pop4keys = new Set(pop4.map(r => r.key));

function mean(a) { return a.length ? a.reduce((s,x)=>s+x,0)/a.length : null; }
function stdev(a) { if (a.length<2) return null; const m=mean(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1)); }
function calibErr(pop, field) { field = field || 'p0_p1'; if (!pop.length) return null; return mean(pop.map(r=>r[field]))*100 - mean(pop.map(r=>r.actualIsBoat1?1:0))*100; }
function percentile(sortedArr, p) { const idx = Math.min(sortedArr.length-1, Math.max(0, Math.floor(p*sortedArr.length))); return sortedArr[idx]; }
function rankPercentileOf(sortedArr, value) {
  let lo=0, hi=sortedArr.length;
  while (lo<hi) { const mid=(lo+hi)>>1; if (sortedArr[mid] < value) lo=mid+1; else hi=mid; }
  return lo / sortedArr.length;
}

function quantileBins(target, field, nBins) {
  const sorted = target.map(r=>r[field]).sort((a,b)=>a-b);
  const edges=[-Infinity];
  for (let i=1;i<nBins;i++) edges.push(sorted[Math.floor(i*sorted.length/nBins)]);
  edges.push(Infinity);
  return edges;
}
function binIndex(val, edges) { for (let i=0;i<edges.length-1;i++) if (val>=edges[i] && val<edges[i+1]) return i; return edges.length-2; }
function matchedSample(donorPool, target, field, nBins) {
  const edges = quantileBins(target, field, nBins);
  const targetCounts = new Array(nBins).fill(0);
  target.forEach(r=>targetCounts[binIndex(r[field],edges)]++);
  const donorByBin=[]; for (let i=0;i<nBins;i++) donorByBin.push([]);
  donorPool.forEach(r=>donorByBin[binIndex(r[field],edges)].push(r));
  const sample=[];
  for (let b=0;b<nBins;b++) {
    const pool = donorByBin[b], need = targetCounts[b];
    if (!pool.length || need===0) continue;
    for (let k=0;k<need;k++) sample.push(pool[Math.floor(Math.random()*pool.length)]);
  }
  return sample;
}

const OBSERVED = calibErr(pop4);

function summarize(name, errs) {
  const sorted = errs.slice().sort((a,b)=>a-b);
  const m = mean(errs), sd = stdev(errs);
  const rankPct = rankPercentileOf(sorted, OBSERVED) * 100;
  const zScore = (OBSERVED - m) / sd;
  const zScoreVsMax = (OBSERVED - sorted[sorted.length-1]) / sd;
  console.log('=== ' + name + ' (n_iters=' + errs.length + ') ===');
  console.log('mean=' + m.toFixed(2) + ' sd=' + sd.toFixed(2) +
    ' p50=' + percentile(sorted,0.50).toFixed(2) +
    ' p90=' + percentile(sorted,0.90).toFixed(2) +
    ' p95=' + percentile(sorted,0.95).toFixed(2) +
    ' p99=' + percentile(sorted,0.99).toFixed(2) +
    ' max=' + sorted[sorted.length-1].toFixed(2));
  console.log('observed(' + OBSERVED.toFixed(2) + 'pt) empirical rank percentile in this distribution = ' + rankPct.toFixed(2) + '%');
  console.log('z-score of observed vs this distribution = ' + zScore.toFixed(2) + ' SD (z vs distribution max = ' + zScoreVsMax.toFixed(2) + ' SD)');
  console.log('fraction of iters >= observed:', (errs.filter(x=>x>=OBSERVED).length/errs.length));
  return { name, mean: m, sd, p50: percentile(sorted,0.50), p90: percentile(sorted,0.90), p95: percentile(sorted,0.95), p99: percentile(sorted,0.99), max: sorted[sorted.length-1], rankPct, zScore };
}

console.log('pop4 n=' + pop4.length + ' OBSERVED calibErr=' + OBSERVED.toFixed(4));
console.log('pop5clean(donor pool, entered=false only) n=' + pop5clean.length);
console.log();

const results = { observed: OBSERVED, contaminated: {}, clean: {} };

console.log('##### ORIGINAL stage5 method (donorPool=pop3, includes pop4 = contaminated) #####');
['market_p1_raw','p0_p1'].forEach(field => {
  const nBins = 10;
  const errs = []; for (let it=0; it<2000; it++) errs.push(calibErr(matchedSample(pop3, pop4, field, nBins)));
  results.contaminated[field] = summarize('CONTAMINATED field=' + field, errs);
});
{
  const nBins = 8;
  const errs = []; for (let it=0; it<2000; it++) errs.push(calibErr(matchedSample(pop3, pop4, 'bandCount', nBins)));
  results.contaminated.bandCount = summarize('CONTAMINATED field=bandCount', errs);
}

console.log();
console.log('##### CORRECTED (donorPool = entered=false ONLY, no pop4 contamination) #####');
['market_p1_raw','p0_p1'].forEach(field => {
  const nBins = 10;
  const errs = []; for (let it=0; it<2000; it++) errs.push(calibErr(matchedSample(pop5clean, pop4, field, nBins)));
  results.clean[field] = summarize('CLEAN field=' + field, errs);
});
{
  const nBins = 8;
  const errs = []; for (let it=0; it<2000; it++) errs.push(calibErr(matchedSample(pop5clean, pop4, 'bandCount', nBins)));
  results.clean.bandCount = summarize('CLEAN field=bandCount', errs);
}

const byDay4 = {}; pop4.forEach(r => byDay4[r.date] = (byDay4[r.date]||0)+1);
const byDay5clean = {}; pop5clean.forEach(r => (byDay5clean[r.date]=byDay5clean[r.date]||[]).push(r));
function dateMatchedClean() {
  const out=[];
  Object.keys(byDay4).forEach(d => {
    const need = byDay4[d], pool = byDay5clean[d] || [];
    if (!pool.length) return;
    for (let k=0;k<need;k++) out.push(pool[Math.floor(Math.random()*pool.length)]);
  });
  return out;
}
{
  const errs=[]; for (let it=0; it<2000; it++) errs.push(calibErr(dateMatchedClean()));
  results.clean.dateMatched = summarize('CLEAN date-matched', errs);
}

const byDV4 = {}; pop4.forEach(r => { const k=r.date+'|'+r.venue; byDV4[k]=(byDV4[k]||0)+1; });
const byDV5clean = {}; pop5clean.forEach(r => { const k=r.date+'|'+r.venue; (byDV5clean[k]=byDV5clean[k]||[]).push(r); });
function dvMatchedClean() {
  const out=[];
  Object.keys(byDV4).forEach(k => {
    const need = byDV4[k]; let pool = byDV5clean[k] || [];
    const day = k.split('|')[0];
    if (!pool.length) pool = byDay5clean[day] || [];
    if (!pool.length) return;
    for (let i=0;i<need;i++) out.push(pool[Math.floor(Math.random()*pool.length)]);
  });
  return out;
}
{
  const errs=[]; for (let it=0; it<2000; it++) errs.push(calibErr(dvMatchedClean()));
  results.clean.dateVenueMatched = summarize('CLEAN date+venue-matched', errs);
}

console.log();
console.log('##### CONTAMINATION DIAGNOSTIC: pop4 self-inclusion fraction in original stage5 donor pool #####');
function contaminationReport(field, nBins) {
  const edges = quantileBins(pop4, field, nBins);
  const targetCounts = new Array(nBins).fill(0);
  pop4.forEach(r=>targetCounts[binIndex(r[field],edges)]++);
  const donorByBin=[]; for (let i=0;i<nBins;i++) donorByBin.push([]);
  pop3.forEach(r=>donorByBin[binIndex(r[field],edges)].push(r));
  console.log('field=' + field);
  for (let b=0;b<nBins;b++) {
    const pool = donorByBin[b];
    const self = pool.filter(r=>pop4keys.has(r.key)).length;
    console.log('  bin'+b, 'donorPoolSize='+pool.length, 'pop4SelfCount='+self, 'selfFrac=' + (pool.length? (self/pool.length*100).toFixed(1):'NA') + '%');
  }
}
contaminationReport('market_p1_raw', 10);

console.log();
console.log('##### DAY-BLOCK BOOTSTRAP: CI for pop4 (entered=true) own calibration error #####');
const pop4Days = Array.from(new Set(pop4.map(r=>r.date)));
const pop4ByDay = {}; pop4.forEach(r => (pop4ByDay[r.date]=pop4ByDay[r.date]||[]).push(r));
console.log('pop4 spans ' + pop4Days.length + ' unique days');
function dayBlockResamplePop4() {
  const out=[];
  for (let i=0;i<pop4Days.length;i++) {
    const d = pop4Days[Math.floor(Math.random()*pop4Days.length)];
    out.push.apply(out, pop4ByDay[d]);
  }
  return out;
}
const pop4BootErrs = [];
for (let it=0; it<5000; it++) pop4BootErrs.push(calibErr(dayBlockResamplePop4()));
pop4BootErrs.sort((a,b)=>a-b);
console.log('pop4 own calibErr day-block-bootstrap: mean=' + mean(pop4BootErrs).toFixed(2) +
  ' 95CI=[' + percentile(pop4BootErrs,0.025).toFixed(2) + ', ' + percentile(pop4BootErrs,0.975).toFixed(2) + ']' +
  ' median=' + percentile(pop4BootErrs,0.5).toFixed(2));

console.log();
console.log('##### COMBINED DIFFERENCE DISTRIBUTION: pop4(day-block-boot) minus clean-control(iid resample), 95CI #####');
function diffCI(name, controlErrs) {
  const diffs = [];
  for (let i=0;i<5000;i++) {
    const a = pop4BootErrs[Math.floor(Math.random()*pop4BootErrs.length)];
    const b = controlErrs[Math.floor(Math.random()*controlErrs.length)];
    diffs.push(a-b);
  }
  diffs.sort((a,b)=>a-b);
  console.log(name + ': mean diff=' + mean(diffs).toFixed(2) + ' 95CI=[' + percentile(diffs,0.025).toFixed(2) + ', ' + percentile(diffs,0.975).toFixed(2) + '] fraction<=0: ' + (diffs.filter(x=>x<=0).length/diffs.length).toFixed(4));
}
function rawErrs(donorPool, field, nBins, n) { const out=[]; for (let it=0;it<n;it++) out.push(calibErr(matchedSample(donorPool, pop4, field, nBins))); return out; }
const cleanMarketErrs = rawErrs(pop5clean, 'market_p1_raw', 10, 2000);
const cleanModelErrs = rawErrs(pop5clean, 'p0_p1', 10, 2000);
const cleanBandErrs = rawErrs(pop5clean, 'bandCount', 8, 2000);
const cleanDateErrs = []; for (let it=0;it<2000;it++) cleanDateErrs.push(calibErr(dateMatchedClean()));
const cleanDVErrs = []; for (let it=0;it<2000;it++) cleanDVErrs.push(calibErr(dvMatchedClean()));
diffCI('vs CLEAN market_p1_raw-matched', cleanMarketErrs);
diffCI('vs CLEAN p0_p1-matched', cleanModelErrs);
diffCI('vs CLEAN bandCount-matched', cleanBandErrs);
diffCI('vs CLEAN date-matched', cleanDateErrs);
diffCI('vs CLEAN date+venue-matched', cleanDVErrs);

fs.writeFileSync('C:/garon/logs/devil_entry_scale_stage6_2026-09-05_results.json', JSON.stringify(results, null, 2));
console.log('DONE_STAGE6');
