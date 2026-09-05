'use strict';
const fs = require('fs');
const dir = 'C:/Users/ymyin/AppData/Local/Temp/claude/C--garon/9fb2a66f-4b92-4222-82ac-935dd2763c7c/scratchpad';
const pop3 = JSON.parse(fs.readFileSync(dir + '/pop3_race_level.json', 'utf8'));
const pop4 = pop3.filter(r => r.entered === true);
const pop5clean = pop3.filter(r => r.entered === false);
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
['market_p1_raw','p0_p1'].forEach(field => {
  const s = matchedSample(pop5clean, pop4, field, 10);
  console.log(field, 'sample n=', s.length, '(target=' + pop4.length + ')');
});
console.log('bandCount', 'sample n=', matchedSample(pop5clean, pop4, 'bandCount', 8).length);
const byDay4 = {}; pop4.forEach(r => byDay4[r.date] = (byDay4[r.date]||0)+1);
const byDay5clean = {}; pop5clean.forEach(r => (byDay5clean[r.date]=byDay5clean[r.date]||[]).push(r));
let dateN = 0; Object.keys(byDay4).forEach(d => { if ((byDay5clean[d]||[]).length) dateN += byDay4[d]; });
console.log('date-matched achievable n=', dateN, '/ target', pop4.length);
const byDV4 = {}; pop4.forEach(r => { const k=r.date+'|'+r.venue; byDV4[k]=(byDV4[k]||0)+1; });
const byDV5clean = {}; pop5clean.forEach(r => { const k=r.date+'|'+r.venue; (byDV5clean[k]=byDV5clean[k]||[]).push(r); });
let dvN = 0; Object.keys(byDV4).forEach(k => { const day=k.split('|')[0]; const pool = (byDV5clean[k]||[]).length ? byDV5clean[k] : (byDay5clean[day]||[]); if (pool.length) dvN += byDV4[k]; });
console.log('date+venue-matched achievable n=', dvN, '/ target', pop4.length);
