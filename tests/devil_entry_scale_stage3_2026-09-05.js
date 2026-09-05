'use strict';
const fs = require('fs');
const dir = 'C:/Users/ymyin/AppData/Local/Temp/claude/C--garon/9fb2a66f-4b92-4222-82ac-935dd2763c7c/scratchpad';
const pop3 = JSON.parse(fs.readFileSync(dir + '/pop3_race_level.json', 'utf8'));
const pop4 = pop3.filter(function (r) { return r.entered === true; });
const pop5 = pop3.filter(function (r) { return r.entered === false; });
function mean(a) { return a.reduce(function (s, x) { return s + x; }, 0) / a.length; }
function stdev(a) { var m = mean(a); return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1)); }
function welchT(a, b) {
  var ma = mean(a), mb = mean(b), sa = stdev(a), sb = stdev(b), na = a.length, nb = b.length;
  var se = Math.sqrt(sa * sa / na + sb * sb / nb);
  return { diff: ma - mb, t: (ma - mb) / se, ma: ma, mb: mb, sa: sa, sb: sb, na: na, nb: nb };
}
function cohend(a, b) {
  var na = a.length, nb = b.length, sa = stdev(a), sb = stdev(b);
  var pooled = Math.sqrt(((na - 1) * sa * sa + (nb - 1) * sb * sb) / (na + nb - 2));
  return (mean(a) - mean(b)) / pooled;
}
console.log('=== A: |p0_p1 - market_p1_raw| ===');
var absDiffA = welchT(pop4.map(function (r) { return Math.abs(r.diffRaw); }), pop5.map(function (r) { return Math.abs(r.diffRaw); }));
console.log(JSON.stringify(absDiffA));
console.log('cohend=', cohend(pop4.map(function (r) { return Math.abs(r.diffRaw); }), pop5.map(function (r) { return Math.abs(r.diffRaw); })));

console.log('=== B: entropy, maxP ===');
console.log('entropy:', JSON.stringify(welchT(pop4.map(function (r) { return r.entropy; }), pop5.map(function (r) { return r.entropy; }))));
console.log('maxP:', JSON.stringify(welchT(pop4.map(function (r) { return r.maxP; }), pop5.map(function (r) { return r.maxP; }))));

console.log('=== C: bandCount ===');
console.log(JSON.stringify(welchT(pop4.map(function (r) { return r.bandCount; }), pop5.map(function (r) { return r.bandCount; }))));

console.log('=== D: boat1LegFrac (selected8) ===');
console.log(JSON.stringify(welchT(pop4.map(function (r) { return r.boat1LegFrac; }), pop5.map(function (r) { return r.boat1LegFrac; }))));

console.log('=== E: date/venue/racenum distribution of pop4 (n=107) ===');
function counts(arr, key) { var c = {}; arr.forEach(function (r) { c[r[key]] = (c[r[key]] || 0) + 1; }); return c; }
console.log('byDate:', JSON.stringify(counts(pop4, 'date')));
console.log('byVenue:', JSON.stringify(counts(pop4, 'venue')));
console.log('byRacenum:', JSON.stringify(counts(pop4, 'racenum')));
console.log('kimariteMissing count in pop4:', pop4.filter(function (r) { return r.kimariteMissingFlag; }).length, '/ 107');
console.log('total races in pop3 by date (for denominator context):', JSON.stringify(counts(pop3, 'date')));

console.log('=== G: correlation diffRaw vs estimate, diffRaw vs actualBoat1 (pop3 overall) ===');
function pearson(xs, ys) {
  var n = xs.length, mx = mean(xs), my = mean(ys);
  var num = 0, dx2 = 0, dy2 = 0;
  for (var i = 0; i < n; i++) { var dx = xs[i] - mx, dy = ys[i] - my; num += dx * dy; dx2 += dx * dx; dy2 += dy * dy; }
  return num / Math.sqrt(dx2 * dy2);
}
var diffRawArr = pop3.map(function (r) { return r.diffRaw; });
var estimateArr = pop3.map(function (r) { return r.estimate; });
var actualArr = pop3.map(function (r) { return r.actualIsBoat1 ? 1 : 0; });
console.log('corr(diffRaw, estimate) over pop3 n=' + pop3.length + ':', pearson(diffRawArr, estimateArr));
console.log('corr(diffRaw, actualBoat1) over pop3:', pearson(diffRawArr, actualArr));
console.log('corr(estimate, actualBoat1) over pop3:', pearson(estimateArr, actualArr));

// terciles of diffRaw
var sorted = pop3.slice().sort(function (a, b) { return a.diffRaw - b.diffRaw; });
var n = sorted.length, k = 5;
var bins = [];
for (var i = 0; i < k; i++) {
  var slice = sorted.slice(Math.floor(i * n / k), Math.floor((i + 1) * n / k));
  bins.push({
    bin: i, n: slice.length,
    diffRawRange: [slice[0].diffRaw, slice[slice.length - 1].diffRaw],
    meanEstimate: mean(slice.map(function (r) { return r.estimate; })),
    enteredRate: slice.filter(function (r) { return r.entered; }).length / slice.length,
    actualBoat1Rate: mean(slice.map(function (r) { return r.actualIsBoat1 ? 1 : 0; })),
    meanP0p1: mean(slice.map(function (r) { return r.p0_p1; })),
  });
}
console.log('quintiles of diffRaw (p0_p1 - market_p1_raw), pop3:');
bins.forEach(function (b) { console.log(JSON.stringify(b)); });
