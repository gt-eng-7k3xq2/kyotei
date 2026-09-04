'use strict';
// GARON-20260904-002 補助チェック: 事前登録した対数損失(NLL)の二次的判定基準を算出する。
// メインスクリプト(research_pure_prediction_two_layer_2026-09-04.js)で確定したw=0.15199を再利用し、
// 再学習は行わない(結果を見てからの再フィッティングではない)。
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ROOT = path.join(__dirname, '..');
const { loadAllRaces } = require('./q_engine_entry_backtest.js');
const alphaPath = path.join(ROOT, 'scripts', 'lib', 'alpha_engine', 'alpha.js');
const alphaSrc = fs.readFileSync(alphaPath, 'utf8');
const MARK = 'module.exports={predict,MODEL_ID,ENTRY_THRESHOLD};';
const patchedSrc = alphaSrc.replace(MARK, 'module.exports={predict,MODEL_ID,ENTRY_THRESHOLD,distribution};');
const mm = new Module(alphaPath, module); mm.filename = alphaPath; mm.paths = Module._nodeModulePaths(path.dirname(alphaPath));
mm._compile(patchedSrc, alphaPath);
const alphaExt = mm.exports;

const W_FITTED = 0.15199; // メインスクリプトの学習結果をそのまま使用
const meanTrain = 5.2385, stdTrain = 1.9848; // メインスクリプトの学習結果をそのまま使用
function z(k) { return (k - meanTrain) / stdTrain; }
function softmax(scores) { const max = Math.max(...scores); const exps = scores.map(s => Math.exp(s - max)); const tot = exps.reduce((a,b)=>a+b,0); return exps.map(e=>e/tot); }
function distIdx(boats) {
  const dist = alphaExt.distribution(boats);
  const idx = Array.from({length:6},()=>Array.from({length:6},()=>new Array(6).fill(0)));
  for (const c of dist) { const [a,b,cc]=c.val.split('-').map(x=>Number(x)-1); idx[a][b][cc]=c.p; }
  return idx;
}
function boatKinMap(boats) { const m=new Array(6).fill(null); for (const b of boats) m[b.no-1]=(typeof b.kinsetsu6m==='number'&&Number.isFinite(b.kinsetsu6m))?b.kinsetsu6m:0; return m; }
function trueProb(idx, kin, wCoef, ci, cj, ck) {
  if (wCoef === 0) return idx[ci][cj][ck];
  const zArr = kin.map(z);
  const p1raw = new Array(6).fill(0);
  for (let i=0;i<6;i++){ let s=0; for(let j=0;j<6;j++) for(let k=0;k<6;k++) if(j!==i&&k!==i&&k!==j) s+=idx[i][j][k]; p1raw[i]=s; }
  const scores1 = p1raw.map((p,i)=>Math.log(Math.max(p,1e-12))+wCoef*zArr[i]);
  const p1w = softmax(scores1);
  const pPairRaw = new Array(6).fill(0);
  for (let j=0;j<6;j++){ if(j===ci) continue; let s=0; for(let k=0;k<6;k++) if(k!==ci&&k!==j) s+=idx[ci][j][k]; pPairRaw[j]=s; }
  const cand2 = [0,1,2,3,4,5].filter(j=>j!==ci);
  const p2raw = cand2.map(j=>pPairRaw[j]/Math.max(p1raw[ci],1e-12));
  const scores2 = cand2.map((j,ii)=>Math.log(Math.max(p2raw[ii],1e-12))+wCoef*zArr[j]);
  const p2w = softmax(scores2);
  const jPos = cand2.indexOf(cj);
  const cand3 = [0,1,2,3,4,5].filter(k=>k!==ci&&k!==cj);
  const p3raw = cand3.map(k=>idx[ci][cj][k]/Math.max(pPairRaw[cj],1e-12));
  const scores3 = cand3.map((k,ii)=>Math.log(Math.max(p3raw[ii],1e-12))+wCoef*zArr[k]);
  const p3w = softmax(scores3);
  const kPos = cand3.indexOf(ck);
  return p1w[ci]*p2w[jPos]*p3w[kPos];
}
function isUsableForLayer1(r){ return !!(r.resulted && r.boats && r.boats.length===6 && r.boats.every(b=>!b.isJogai) && r.chakuju); }
const all = loadAllRaces();
const layer1Pop = all.filter(isUsableForLayer1);
const evalA_races = layer1Pop.filter(r=>r.date>='2026-08-21'&&r.date<='2026-08-27');
const evalB_races = layer1Pop.filter(r=>r.date>='2026-08-28'&&r.date<='2026-09-02');
function nll(races,label){
  let sumBase=0,sumHyp=0,n=0;
  for (const r of races){
    let idx; try{idx=distIdx(r.boats);}catch(e){continue;}
    const kin=boatKinMap(r.boats);
    const [ci,cj,ck]=r.chakuju.split('-').map(x=>Number(x)-1);
    const pBase=trueProb(idx,kin,0,ci,cj,ck);
    const pHyp=trueProb(idx,kin,W_FITTED,ci,cj,ck);
    sumBase += -Math.log(Math.max(pBase,1e-12));
    sumHyp += -Math.log(Math.max(pHyp,1e-12));
    n++;
  }
  console.log(`[${label}] n=${n} 平均NLL: 基準=${(sumBase/n).toFixed(4)} 仮説=${(sumHyp/n).toFixed(4)} 差(仮説-基準)=${((sumHyp-sumBase)/n).toFixed(4)}(負なら改善)`);
}
nll(evalA_races,'EvalA(08-21〜08-27)');
nll(evalB_races,'EvalB(08-28〜09-02)');
