'use strict';
const fs=require('fs'),path=require('path'),zlib=require('zlib'),Module=require('module');
const ALPHA_DIR='C:/garon/scripts/lib/alpha_engine';
const PKG='C:/garon/research/alpha_kinsetsu_candidate_v2_handoff/codex_delivery_20260904';

function loadAlphaWithDistribution(){
  const src = fs.readFileSync(path.join(ALPHA_DIR,'alpha.js'),'utf8');
  const patched = src.replace('module.exports={predict,MODEL_ID,ENTRY_THRESHOLD};','module.exports={predict,MODEL_ID,ENTRY_THRESHOLD,distribution};');
  const m = new Module(path.join(ALPHA_DIR,'alpha.js'), module);
  m.filename = path.join(ALPHA_DIR,'alpha.js');
  m.paths = Module._nodeModulePaths(ALPHA_DIR);
  m._compile(patched, m.filename);
  return m.exports;
}
const alphaP0 = loadAlphaWithDistribution(); // 本番P0(alpha.js、ディスク未変更・メモリパッチのみ)

// P1: candidate_features.js(パッケージ同梱、本番へは一切繋がない研究用コピー)をそのまま使う
const candidateFeatures = require(path.join(PKG,'candidate_features.js'));
const p1Model = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(PKG,'trained','form_kinsetsu6m_model.json.gz'))));

// alpha.jsのdistribution()と同一の木の辿り方をP1モデル用に汎用化(ロジックはコピーではなく再実装、値は同一手順)
function walkTree(t, x){
  // alpha.js本体と同一のインデックス辿り方(t=ノードのフラット配列、n.left/n.rightは配列インデックス)
  let n = t[0];
  while(!n.is_leaf){
    if(n.is_categorical) throw Error('CATEGORICAL_SPLIT');
    const v = x[n.feature_idx];
    n = t[Number.isNaN(v) ? (n.missing_go_to_left?n.left:n.right) : (v<=n.num_threshold?n.left:n.right)];
  }
  return n.value;
}
function stageProbs(stage, x, prior){
  // train.pyのcontext()/alpha.jsのprobs()と同一: 事前確定した艇(prior)を6要素one-hotで末尾に連結
  const ctx = [...x, ...prior.flatMap(p=>[0,1,2,3,4,5].map(c=>+(p===c)))];
  const s = stage.baseline.slice();
  for(const group of stage.trees){
    for(let c=0;c<6;c++){
      s[c] += walkTree(group[c], ctx); // group[c] = ノードのフラット配列(alpha.jsのtと同一)
    }
  }
  const items=[0,1,2,3,4,5].filter(c=>!prior.includes(c));
  const max=Math.max(...items.map(i=>s[i]));
  const e=items.map(i=>Math.exp(s[i]-max));
  const sum=e.reduce((a,b)=>a+b,0);
  return Object.fromEntries(items.map((i,k)=>[i,e[k]/sum]));
}
function distributionP1(boats){
  const x = candidateFeatures.features(boats).form;
  const p1 = stageProbs(p1Model.stages[0], x, []);
  const out=[];
  for(let i=0;i<6;i++){
    const p2 = stageProbs(p1Model.stages[1], x, [i]);
    for(let j=0;j<6;j++) if(j!==i){
      const p3 = stageProbs(p1Model.stages[2], x, [i,j]);
      for(let k=0;k<6;k++) if(k!==i&&k!==j) out.push({val:`${i+1}-${j+1}-${k+1}`, p:p1[i]*p2[j]*p3[k]});
    }
  }
  return out;
}

// サニティチェック: 自作P1推論が、パッケージ同梱のtrained/form_kinsetsu6m_predictions.json.gzと一致するか
const pkgPred = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(PKG,'trained','form_kinsetsu6m_predictions.json.gz'))));
const frozenEval = JSON.parse(fs.readFileSync(path.join(PKG,'reference','frozen_eval.json'),'utf8')).races;
{
  let maxDiff=0;
  for(let i=0;i<Math.min(50,pkgPred.keys.length);i++){
    const race = frozenEval.find(r=>r.key===pkgPred.keys[i]);
    const dist = distributionP1(race.boats);
    const pmMap = new Map(dist.map(c=>[c.val,c.p]));
    for(let j=0;j<pkgPred.labels.length;j++){
      const d = Math.abs(pmMap.get(pkgPred.labels[j]) - pkgPred.probabilities[i][j]);
      if(d>maxDiff) maxDiff=d;
    }
  }
  console.log('サニティチェック(自作P1推論 vs パッケージ同梱predictions、先頭50レース): 最大差=', maxDiff);
}

module.exports = { alphaP0, distributionP1 };
