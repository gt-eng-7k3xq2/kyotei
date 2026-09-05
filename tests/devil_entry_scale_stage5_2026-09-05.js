'use strict';
const fs = require('fs');
const dir = 'C:/Users/ymyin/AppData/Local/Temp/claude/C--garon/9fb2a66f-4b92-4222-82ac-935dd2763c7c/scratchpad';
const pop3 = JSON.parse(fs.readFileSync(dir + '/pop3_race_level.json', 'utf8'));
const pop4 = pop3.filter(function (r) { return r.entered === true; });
function mean(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; }
function stdev(a) { var m = mean(a); return Math.sqrt(a.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (a.length - 1)); }
function calibErr(pop) { if (!pop.length) return null; return mean(pop.map(function (r) { return r.p0_p1; })) * 100 - mean(pop.map(function (r) { return r.actualIsBoat1 ? 1 : 0; })) * 100; }
function tstatCalib(pop) {
  var n = pop.length;
  var errs = pop.map(function (r) { return r.p0_p1 - (r.actualIsBoat1 ? 1 : 0); });
  var m = mean(errs), sd = stdev(errs);
  return m / (sd / Math.sqrt(n)) ;
}

function quantileBins(target, field, nBins) {
  var sorted = target.map(function (r) { return r[field]; }).sort(function (a, b) { return a - b; });
  var edges = [-Infinity];
  for (var i = 1; i < nBins; i++) edges.push(sorted[Math.floor(i * sorted.length / nBins)]);
  edges.push(Infinity);
  return edges;
}
function binIndex(val, edges) {
  for (var i = 0; i < edges.length - 1; i++) if (val >= edges[i] && val < edges[i + 1]) return i;
  return edges.length - 2;
}
function matchedSample(donorPool, target, field, nBins) {
  var edges = quantileBins(target, field, nBins);
  var targetCounts = new Array(nBins).fill(0);
  target.forEach(function (r) { targetCounts[binIndex(r[field], edges)]++; });
  var donorByBin = [];
  for (var i = 0; i < nBins; i++) donorByBin.push([]);
  donorPool.forEach(function (r) { donorByBin[binIndex(r[field], edges)].push(r); });
  var sample = [];
  for (var b = 0; b < nBins; b++) {
    var pool = donorByBin[b];
    var need = targetCounts[b];
    if (!pool.length || need === 0) continue;
    for (var k = 0; k < need; k++) sample.push(pool[Math.floor(Math.random() * pool.length)]);
  }
  return sample;
}
function runControl(name, field, nBins, iters) {
  var errs = [];
  for (var it = 0; it < iters; it++) {
    var s = matchedSample(pop3, pop4, field, nBins);
    errs.push(calibErr(s));
  }
  errs.sort(function (a, b) { return a - b; });
  console.log('--- control: ' + name + ' (field=' + field + ', nBins=' + nBins + ', iters=' + iters + ') ---');
  console.log('mean calibErr=' + mean(errs).toFixed(2) + ' sd=' + stdev(errs).toFixed(2) + ' p2.5=' + errs[Math.floor(iters * 0.025)].toFixed(2) + ' p50=' + errs[Math.floor(iters * 0.5)].toFixed(2) + ' p97.5=' + errs[Math.floor(iters * 0.975)].toFixed(2) + ' max=' + errs[iters - 1].toFixed(2));
  console.log('observed pop4 calibErr=24.17 => fraction of control iters >= observed:', (errs.filter(function (x) { return x >= 24.17; }).length / iters));
}

console.log('pop4 n=' + pop4.length + ' observed calibErr=' + calibErr(pop4).toFixed(2) + ' t=' + tstatCalib(pop4).toFixed(2));
console.log();
runControl('marketP1raw-matched', 'market_p1_raw', 10, 2000);
runControl('pureModelP1-matched', 'p0_p1', 10, 2000);
runControl('bandCount-matched', 'bandCount', 8, 2000);

// date-matched: for each day, sample same count as pop4 that day from pop3 that day
var byDay4 = {};
pop4.forEach(function (r) { (byDay4[r.date] = byDay4[r.date] || 0); byDay4[r.date]++; });
var byDay3 = {};
pop3.forEach(function (r) { (byDay3[r.date] = byDay3[r.date] || []).push(r); });
function dateMatchedSample() {
  var out = [];
  Object.keys(byDay4).forEach(function (d) {
    var need = byDay4[d];
    var pool = byDay3[d] || [];
    if (!pool.length) return;
    for (var k = 0; k < need; k++) out.push(pool[Math.floor(Math.random() * pool.length)]);
  });
  return out;
}
var dateErrs = [];
for (var it = 0; it < 2000; it++) dateErrs.push(calibErr(dateMatchedSample()));
dateErrs.sort(function (a, b) { return a - b; });
console.log('--- control: date-matched (same day, same n as pop4 per day) ---');
console.log('mean=' + mean(dateErrs).toFixed(2) + ' p2.5=' + dateErrs[50].toFixed(2) + ' p50=' + dateErrs[1000].toFixed(2) + ' p97.5=' + dateErrs[1950].toFixed(2));
console.log('fraction >= observed(24.17):', dateErrs.filter(function (x) { return x >= 24.17; }).length / 2000);

// venue+date matched (fallback to date-only when venue combo has no pool)
var byDayVenue4 = {};
pop4.forEach(function (r) { var k = r.date + '|' + r.venue; byDayVenue4[k] = (byDayVenue4[k] || 0) + 1; });
var byDayVenue3 = {};
pop3.forEach(function (r) { var k = r.date + '|' + r.venue; (byDayVenue3[k] = byDayVenue3[k] || []).push(r); });
function dateVenueMatchedSample() {
  var out = [];
  Object.keys(byDayVenue4).forEach(function (k) {
    var need = byDayVenue4[k];
    var pool = byDayVenue3[k] || [];
    var day = k.split('|')[0];
    if (!pool.length) pool = byDay3[day] || [];
    if (!pool.length) return;
    for (var i = 0; i < need; i++) out.push(pool[Math.floor(Math.random() * pool.length)]);
  });
  return out;
}
var dv = [];
for (var it2 = 0; it2 < 2000; it2++) dv.push(calibErr(dateVenueMatchedSample()));
dv.sort(function (a, b) { return a - b; });
console.log('--- control: date+venue-matched (fallback to date-only if venue empty) ---');
console.log('mean=' + mean(dv).toFixed(2) + ' p2.5=' + dv[50].toFixed(2) + ' p50=' + dv[1000].toFixed(2) + ' p97.5=' + dv[1950].toFixed(2));
console.log('fraction >= observed(24.17):', dv.filter(function (x) { return x >= 24.17; }).length / 2000);
