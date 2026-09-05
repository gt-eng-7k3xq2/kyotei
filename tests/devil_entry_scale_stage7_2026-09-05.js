'use strict';
// GARON-20260905-006 Stage7: mechanistic decomposition of the "half" phenomenon (item 2)
const fs = require('fs');
const dir = 'C:/Users/ymyin/AppData/Local/Temp/claude/C--garon/9fb2a66f-4b92-4222-82ac-935dd2763c7c/scratchpad';
const pop3 = JSON.parse(fs.readFileSync(dir + '/pop3_race_level.json', 'utf8'));
const pop4 = pop3.filter(r => r.entered === true);
const pop5 = pop3.filter(r => r.entered === false);
function mean(a) { return a.reduce((s,x)=>s+x,0)/a.length; }

// ---- Part A: two-class algebraic identity check (toy sweep) ----
// idealized model: market matches true combo probabilities exactly (p_S = true marginal),
// model applies a uniform multiplicative log-bias e to all combos in class S (boat1-first), 0 elsewhere.
// Prediction: mixed_S (0.5:0.5 sqrt geometric mean, renormalized over the 2-class reduction) satisfies
//   logit(mixed_S) = 0.5*logit(p_S) + 0.5*logit(pm_S)   [EXACT under this idealization]
function logit(p) { return Math.log(p/(1-p)); }
function invlogit(x) { return 1/(1+Math.exp(-x)); }
function pmFromBias(pS, e) {
  // pm_S = pS*exp(e) / (pS*exp(e) + (1-pS))
  return (pS*Math.exp(e)) / (pS*Math.exp(e) + (1-pS));
}
function mixedFromBias(pS, e) {
  return pmFromBias(pS, e/2);
}
console.log('=== Part A: toy two-class sweep (market=true exactly, uniform log-bias e on class S) ===');
console.log('pS, bias_e, pm_S(model), mixed_S(predicted via exact halving), pctErrReduction');
[0.15, 0.25, 0.31, 0.40, 0.55].forEach(pS => {
  [0.3, 0.6, 1.0, 1.5, 2.0].forEach(e => {
    const pmS = pmFromBias(pS, e);
    const mixedS = mixedFromBias(pS, e);
    const modelErr = pmS - pS, mixedErr = mixedS - pS;
    const ratio = mixedErr / modelErr;
    console.log('pS='+pS.toFixed(2)+' e='+e.toFixed(2)+' pm='+ (pmS*100).toFixed(1)+'% mixed='+(mixedS*100).toFixed(1)+'% attenuationRatio='+ratio.toFixed(4));
  });
});

console.log();
console.log('=== Part B: per-race real-data validity check of the two-class logit-averaging approximation ===');
function predictedMixedTwoClass(r) {
  const pS = r.market_p1_raw, pm = r.p0_p1;
  if (pS<=0 || pS>=1 || pm<=0 || pm>=1) return null;
  const avgLogit = 0.5*logit(pS) + 0.5*logit(pm);
  return invlogit(avgLogit);
}
function summPop(pop, label) {
  const preds = pop.map(predictedMixedTwoClass).filter(x=>x!==null);
  const actualMixedMean = mean(pop.map(r=>r.market_p1_mixed));
  const predMean = mean(preds);
  const actualCalib = actualMixedMean*100 - mean(pop.map(r=>r.actualIsBoat1?1:0))*100;
  const predCalib = predMean*100 - mean(pop.map(r=>r.actualIsBoat1?1:0))*100;
  console.log(label + ': n=' + pop.length +
    ' actual_mixed_mean=' + (actualMixedMean*100).toFixed(2) + '%' +
    ' twoClassPredicted_mixed_mean=' + (predMean*100).toFixed(2) + '%' +
    ' | actual_mixed_calibErr=' + actualCalib.toFixed(2) + 'pt' +
    ' predicted_mixed_calibErr(twoClassApprox)=' + predCalib.toFixed(2) + 'pt');
}
summPop(pop4, 'pop4(entered=true)');
summPop(pop5, 'pop5(entered=false)');
summPop(pop3, 'pop3(all)');

// per-race error of the two-class approximation itself vs actual mixed (full 120-way exact computation)
function perRaceApproxError(pop) {
  const errs = pop.map(r => {
    const pred = predictedMixedTwoClass(r);
    if (pred===null) return null;
    return (pred - r.market_p1_mixed)*100;
  }).filter(x=>x!==null);
  return { meanAbsErr: mean(errs.map(Math.abs)), meanErr: mean(errs), n: errs.length };
}
console.log('per-race two-class-approx vs actual-mixed field, pop4:', JSON.stringify(perRaceApproxError(pop4)));
console.log('per-race two-class-approx vs actual-mixed field, pop3:', JSON.stringify(perRaceApproxError(pop3)));
