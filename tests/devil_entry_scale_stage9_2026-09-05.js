'use strict';
// GARON-20260905-006 Stage9: candidate gate specification feasibility check (item 4)
const fs = require('fs');
const dir = 'C:/Users/ymyin/AppData/Local/Temp/claude/C--garon/9fb2a66f-4b92-4222-82ac-935dd2763c7c/scratchpad';
const pop3 = JSON.parse(fs.readFileSync(dir + '/pop3_race_level.json', 'utf8'));
const pop4 = pop3.filter(r => r.entered === true);
const THRESH = 1.440209615716716;
function mean(a) { return a.length ? a.reduce((s,x)=>s+x,0)/a.length : null; }

function estimateAgreeFixed8(rec, lo, hi) {
  let sum = 0, agreeCount = 0;
  rec.selected8.forEach(c => {
    const q = c.marketRaw; // full-120-normalized market prob, per spec
    const r = q > 0 ? c.pm / q : null;
    if (r !== null && r >= lo && r <= hi) {
      sum += c.mixed * c.odds;
      agreeCount++;
    }
  });
  return { value: sum / 8, agreeCount };
}

console.log('=== pop4 (n=' + pop4.length + '): estimate_agree_fixed8 with r range [0.5, 2.0] ===');
const vals = pop4.map(r => estimateAgreeFixed8(r, 0.5, 2.0));
const zeroAgree = vals.filter(v => v.agreeCount === 0).length;
console.log('agreeCount distribution:', JSON.stringify(
  [0,1,2,3,4,5,6,7,8].map(k => ({ k, n: vals.filter(v=>v.agreeCount===k).length }))
));
console.log('zeroAgreeCount races:', zeroAgree, '/', pop4.length);
const valuesOnly = vals.map(v=>v.value).sort((a,b)=>a-b);
console.log('estimate_agree_fixed8 distribution: min=' + valuesOnly[0].toFixed(3) +
  ' p25=' + valuesOnly[Math.floor(valuesOnly.length*0.25)].toFixed(3) +
  ' p50=' + valuesOnly[Math.floor(valuesOnly.length*0.5)].toFixed(3) +
  ' p75=' + valuesOnly[Math.floor(valuesOnly.length*0.75)].toFixed(3) +
  ' max=' + valuesOnly[valuesOnly.length-1].toFixed(3) +
  ' mean=' + mean(valuesOnly).toFixed(3));
console.log('CURRENT THRESHOLD=' + THRESH + ' -- how many pop4 races would pass estimate_agree_fixed8 >= THRESH? ' +
  vals.filter(v=>v.value>=THRESH).length + ' / ' + pop4.length);

console.log();
console.log('=== compare estimate_agree_fixed8 scale vs standard estimate (mean(mixed*odds) over all 8, no filter) ===');
function standardEstimate(rec) { return mean(rec.selected8.map(c=>c.mixed*c.odds)); }
console.log('pop4 standard estimate: mean=' + mean(pop4.map(standardEstimate)).toFixed(3) + ' (all >= ' + THRESH + ' by construction of entered=true)');
console.log('pop4 estimate_agree_fixed8: mean=' + mean(vals.map(v=>v.value)).toFixed(3));
