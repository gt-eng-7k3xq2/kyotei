'use strict';
// GARON-20260901-003 継続、CEO指示(2026-09-02): 既存アーカイブを活用した「買い目順位モデル」の
// 開発。今回は新しい参入モデル(閾値ゲート)を同時に作らない。買い目順位(点選択)の効果だけを
// 測る。市場基準(A)・低深度決定木モデル(B)とも、選別は「帯内候補あり→締切順→1日10件」のみ。
//
// 【事前登録: 実装前に固定、結果を見る前】
// 1. 目的変数: 艇が1着かどうか(y=1/0)、艇単位でプールした二値分類(レースをまたいで6艇×n件の
//    プールとして学習する。線形PLモデルのように6艇同時softmaxで学習するのではなく、艇単位の
//    独立した二値分類として学習する点が最初の相違点)。
// 2. 入力特徴量: 既存のtests/lib/alpha-features.jsをそのまま再利用(コース位置ダミー5+ST/決まり手/
//    連対率/機力/展示の系統別順位5、計10次元)。特徴量は変更しない、モデルの型だけを変える。
// 3. モデル規模(固定、結果を見た調整はしない): 単一のCART決定木、最大深さ3・葉の最小サンプル数50。
//    複数木のアンサンブル・ブースティングは行わない(「低深度の決定木系」の最小構成)。
// 4. 線形PLモデルとの違い: (a)線形モデルはw・xの単純な重み付き和で、特徴量間の交互作用を
//    表現できない。決定木は再帰分割により「コース<=1 かつ ST順位>0.67」のような交互作用を
//    捉えられる。(b)線形モデルは6艇同時softmax(多項ロジット)で学習するが、今回の木は艇単位の
//    独立な二値分類(1着かどうか)としてプールして学習する、根本的に異なる学習目的。
// 5. 出力の扱い: 木の葉の値(その葉に属する艇のうち実際に1着だった割合)を「順位スコア」として
//    扱う。較正済み確率とは呼ばない。艇ごとの順位スコアを、既存のPlackett-Luce型の組合せ展開
//    (_plWinProbs/_plConditionalProbs、tests/lib/extract-pl-engine.js)にそのまま入力し、
//    全120通りの三連単の「順位」を得る(この展開機構自体は入力が確率である必要はなく、艇の
//    相対的な強さスコアを組合せへ変換する既存の道具としてそのまま再利用する)。出力される数値を
//    確率と呼ばず、スコア×オッズを期待値として扱わない。
//
// 【データの使い分け】
// 学習: 評価期間(2026-08-21)より前の、isUsable(選手情報・確定着順が利用できる)な全レース
//   (オッズ不要、n=5,761、2026-07-01〜08-20の42日間)。後日更新値・時点不明の選手情報は
//   使わない(boats配列の系統別順位は当該レース収集時点のスナップショット値のみ、既存プロジェクト
//   全体で確認済みの前提をそのまま踏襲)。
// 買い目評価: 締切前オッズ確認済み(真T-10)のレースのみ(n=1,215、2026-08-21〜08-31の11日間、
//   hasFullData制約は課さない=艇特徴量は木がneutral値0.5で自然に処理できるため)。
//
// 【固定する比較】A: 市場オッズ昇順・帯内8点。B: 木モデルの順位順・帯内8点。
//   予想時点50-150倍、8点未満は見送り、1点100円。同一レース集合で点選択を比較した後、
//   同じ締切順・最大10件/日を両方式に適用する。今回は参入モデル(閾値ゲート)を作らない。
//
// 使い方: node tests/research_tree_rank_model_v8_2026-09-02.js

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { loadQEngine } = require('./lib/extract-q-engine.js');
const { loadPLEngine } = require('./lib/extract-pl-engine.js');
const { buildFeatures, FEATURE_NAMES } = require('./lib/alpha-features.js');
const { isUsable, loadAllRaces } = require('./q_engine_entry_backtest.js');
const { computeAllComboProbs } = require('./engine_alpha_prototype.js');

const ROOT = path.join(__dirname, '..');
const FLAT_STAKE = 100;
const POINTS_FIXED = 8;
const DAILY_CAP = 10;
const TRAIN_HI_EXCLUSIVE = '2026-08-21'; // train: date < this
const EVAL_LO = '2026-08-21', EVAL_HI = '2026-08-31';
const MAX_DEPTH = 3, MIN_LEAF = 50; // モデル規模(固定、結果を見た調整はしない)

function parsePayout100(s) { if (!s) return 0; const n = parseInt(String(s).replace(/[^\d]/g, ''), 10); return isNaN(n) ? 0 : n; }
function shimekiriMin(s) { if (!s) return null; const m = String(s).match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; }
function validOdds(r) { return Object.entries(r.oddsMap || {}).filter(([, v]) => parseFloat(v) > 0); }
function inRange(d, lo, hi) { return d >= lo && d <= hi; }
function classifyTiming(r) {
  if (!r.archivedAt) return 'unknown';
  const archJST = new Date(new Date(r.archivedAt).getTime() + 9 * 3600 * 1000);
  const archDateJST = archJST.toISOString().slice(0, 10);
  const archMinJST = archJST.getUTCHours() * 60 + archJST.getUTCMinutes();
  const sMin = shimekiriMin(r.shimekiri);
  if (archDateJST === r.date && sMin != null) {
    const diff = sMin - archMinJST;
    if (diff >= 0 && diff <= 20) return 'true';
  }
  return 'unknown';
}
function hashObj(obj) { return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex'); }

// ===== 低深度CART決定木(単一木、二値分類、葉の値=正例割合) =====
function giniOfCounts(pos, n) { if (n === 0) return 0; const p = pos / n; return 2 * p * (1 - p); }
function buildTree(rows, depth) {
  const n = rows.length;
  const pos = rows.reduce((s, r) => s + r.y, 0);
  if (depth >= MAX_DEPTH || n < 2 * MIN_LEAF) return { leaf: true, value: pos / n, n };
  let best = null;
  for (let f = 0; f < FEATURE_NAMES.length; f++) {
    const sorted = rows.slice().sort((a, b) => a.x[f] - b.x[f]);
    let leftPos = 0;
    for (let i = 0; i < n - 1; i++) {
      leftPos += sorted[i].y;
      const leftN = i + 1, rightN = n - leftN;
      if (leftN < MIN_LEAF || rightN < MIN_LEAF) continue;
      if (sorted[i].x[f] === sorted[i + 1].x[f]) continue; // 同値はしきい値にしない
      const rightPos = pos - leftPos;
      const gini = (leftN / n) * giniOfCounts(leftPos, leftN) + (rightN / n) * giniOfCounts(rightPos, rightN);
      if (!best || gini < best.gini) {
        best = { gini, f, threshold: (sorted[i].x[f] + sorted[i + 1].x[f]) / 2, leftN, rightN };
      }
    }
  }
  const parentGini = giniOfCounts(pos, n);
  if (!best || best.gini >= parentGini) return { leaf: true, value: pos / n, n };
  const leftRows = rows.filter(r => r.x[best.f] <= best.threshold);
  const rightRows = rows.filter(r => r.x[best.f] > best.threshold);
  return {
    leaf: false, featureIdx: best.f, featureName: FEATURE_NAMES[best.f], threshold: best.threshold, n,
    left: buildTree(leftRows, depth + 1), right: buildTree(rightRows, depth + 1),
  };
}
function predictTree(tree, x) {
  if (tree.leaf) return tree.value;
  return x[tree.featureIdx] <= tree.threshold ? predictTree(tree.left, x) : predictTree(tree.right, x);
}
function printTree(tree, indent) {
  if (tree.leaf) { console.log(`${indent}葉: 順位スコア=${tree.value.toFixed(3)} (n=${tree.n})`); return; }
  console.log(`${indent}[${tree.featureName} <= ${tree.threshold.toFixed(3)}?] (n=${tree.n})`);
  console.log(`${indent}├─Yes:`); printTree(tree.left, indent + '│  ');
  console.log(`${indent}└─No:`); printTree(tree.right, indent + '   ');
}

function buildMarketRecord(r) {
  const entries = validOdds(r);
  if (entries.length !== 120) return { skip: 'INCOMPLETE_ODDS_120' };
  const band = entries.filter(([, v]) => v >= 50 && v <= 150).map(([val, v]) => ({ val, odds: v }));
  if (band.length < POINTS_FIXED) return { skip: 'INSUFFICIENT_BAND_CANDIDATES' };
  const sorted = band.slice().sort((a, b) => (a.odds - b.odds) || (a.val < b.val ? -1 : a.val > b.val ? 1 : 0));
  return { skip: null, points: sorted.slice(0, POINTS_FIXED).map(p => p.val) };
}
function buildModelRecord(qEngine, plEngine, tree, r) {
  let ranks; try { ranks = qEngine.rankBoatsBySystem(r.boats); } catch (e) { return { skip: 'RANK_ERROR' }; }
  const feat = buildFeatures(r.boats, ranks);
  const scoreMap = {};
  r.boats.forEach((b, i) => { scoreMap[String(b.no)] = predictTree(tree, feat[i]); });
  let comboScores; try { comboScores = computeAllComboProbs(plEngine, scoreMap, 1); } catch (e) { return { skip: 'PL_ERROR' }; } // .pは「順位スコア」、確率とは呼ばない
  const entries = validOdds(r);
  if (entries.length !== 120) return { skip: 'INCOMPLETE_ODDS_120' };
  const oddsOf = {}; entries.forEach(([val, v]) => { oddsOf[val] = v; });
  const band = comboScores.filter(c => oddsOf[c.val] != null && oddsOf[c.val] >= 50 && oddsOf[c.val] <= 150);
  if (band.length < POINTS_FIXED) return { skip: 'INSUFFICIENT_BAND_CANDIDATES' };
  const sortedBand = band.slice().sort((a, b) => (b.p - a.p) || (a.val < b.val ? -1 : a.val > b.val ? 1 : 0));
  return { skip: null, points: sortedBand.slice(0, POINTS_FIXED).map(c => c.val) };
}

function evalFlat(pool, pointsField) {
  let hit = 0, bandHit = 0, migratedOutHit = 0, stake = 0, payout = 0;
  const dayHitMap = {}; const seq = [];
  for (const r of pool) {
    const pts = r[pointsField];
    const isHit = r.chakuju && pts.includes(r.chakuju);
    const isResultBand = r.payoutMul >= 50 && r.payoutMul <= 150;
    const isBandHit = isHit && isResultBand;
    stake += pts.length * FLAT_STAKE;
    if (isHit) payout += Math.round(FLAT_STAKE / 100 * (r.payoutMul * 100));
    if (isHit) hit++;
    if (isBandHit) { bandHit++; dayHitMap[r.date] = true; }
    if (isHit && !isResultBand) migratedOutHit++;
    seq.push(isBandHit ? 1 : 0);
  }
  const n = pool.length;
  let maxStreak = 0, cur = 0;
  for (const s of seq) { if (s === 0) { cur++; maxStreak = Math.max(maxStreak, cur); } else cur = 0; }
  return { n, hit, bandHit, migratedOutHit, stake, payout, roi: stake ? payout / stake * 100 : null, dayHitMap, maxStreak };
}
function applyDailyCap(pool) {
  const byDate = {};
  for (const r of pool) (byDate[r.date] = byDate[r.date] || []).push(r);
  const dates = Object.keys(byDate).sort();
  const selected = []; const perDay = {};
  for (const date of dates) {
    const dayRaces = byDate[date].slice().sort((a, b) => (a.shimekiriMin ?? 0) - (b.shimekiriMin ?? 0));
    const chosen = dayRaces.slice(0, DAILY_CAP);
    selected.push(...chosen);
    perDay[date] = { poolCount: dayRaces.length, selectedCount: chosen.length };
  }
  return { selected, perDay, dates };
}

function main() {
  console.log('=== GARON-20260901-003 継続: 決定木による買い目順位モデル(B) vs 市場基準(A)(2026-09-02) ===\n');
  console.log('【明記】既存データのみ使用(開発用、既に分析済みの期間、探索的評価)。今回は新しい参入モデルは作らず、点選択の効果のみ測る。\n');

  // ===== データを一度だけ読み込み、以降は再読込しない(稼働中アーカイブの途中読み直し禁止) =====
  const loadedAt = new Date().toISOString();
  const all = loadAllRaces();
  const usable = all.filter(isUsable);
  console.log('データ読込完了(loadedAt=' + loadedAt + ')、以降このスナップショットのみを使用。isUsable総数=', usable.length);

  const trainRaces = usable.filter(r => r.date < TRAIN_HI_EXCLUSIVE);
  const evalRacesAll = usable.filter(r => inRange(r.date, EVAL_LO, EVAL_HI));
  const evalRaces = evalRacesAll.filter(r => classifyTiming(r) === 'true');
  console.log('\n=== 1. データの使い分け ===');
  console.log('学習(評価期間より前、isUsableのみ・オッズ不要) n=', trainRaces.length, ' 日数=', [...new Set(trainRaces.map(r => r.date))].length, ' 範囲=2026-07-01〜', TRAIN_HI_EXCLUSIVE, '(未満)');
  console.log('買い目評価(締切前オッズ確認済み、真T-10) n=', evalRaces.length, '/', evalRacesAll.length, '(', EVAL_LO, '〜', EVAL_HI, 'のisUsable中)');
  const evalDates = [...new Set(evalRaces.map(r => r.date))].sort();
  console.log('評価日付・件数:', evalDates.map(d => d + ':' + evalRaces.filter(r => r.date === d).length).join(' '));

  // ===== 入力の凍結(ハッシュ・対象ID・コード版を保存) =====
  const trainKeys = trainRaces.map(r => `${r.date}_${r.venue}_${r.racenum}`).sort();
  const evalKeys = evalRaces.map(r => `${r.date}_${r.venue}_${r.racenum}`).sort();
  const scriptHash = hashObj(fs.readFileSync(__filename, 'utf8'));
  const freezeManifest = {
    generatedAt: loadedAt, scriptHash,
    trainKeysHash: hashObj(trainKeys), trainKeysCount: trainKeys.length,
    evalKeysHash: hashObj(evalKeys), evalKeysCount: evalKeys.length,
    trainKeys, evalKeys,
  };
  fs.writeFileSync(path.join(ROOT, 'logs', 'research_tree_rank_model_v8_frozen_inputs_2026-09-02.json'), JSON.stringify(freezeManifest));
  console.log('\n入力を凍結保存(logs/research_tree_rank_model_v8_frozen_inputs_2026-09-02.json): trainKeysHash=', freezeManifest.trainKeysHash.slice(0, 16), '... evalKeysHash=', freezeManifest.evalKeysHash.slice(0, 16), '...');

  // ===== 2. 学習(艇単位プール、二値分類、単一CART木・深さ3固定) =====
  console.log('\n=== 2. 学習(単一CART決定木、最大深さ3・葉最小50、事前固定・調整なし) ===');
  const qEngine = loadQEngine(path.join(ROOT, 'garon_q_engine.html'));
  const plEngine = loadPLEngine(path.join(ROOT, 'sg_narutou.html'));
  const trainRows = [];
  for (const r of trainRaces) {
    let ranks; try { ranks = qEngine.rankBoatsBySystem(r.boats); } catch (e) { continue; }
    const feat = buildFeatures(r.boats, ranks);
    const winnerBoat = parseInt(r.chakuju.split('-')[0], 10);
    r.boats.forEach((b, i) => { trainRows.push({ x: feat[i], y: b.no === winnerBoat ? 1 : 0 }); });
  }
  console.log('艇単位プール学習データ n=', trainRows.length, '(', trainRaces.length, 'レース×6艇、正例=', trainRows.reduce((s, r) => s + r.y, 0), ')');
  const tree = buildTree(trainRows, 0);
  console.log('\n学習された木の構造:');
  printTree(tree, '  ');

  // ===== 3. A/Bレコード構築(同一の評価レース集合) =====
  console.log('\n=== 3. 買い目順位付けの差(同一レース集合、帯内8点、100円固定、選別なし) ===');
  const records = [];
  for (const r of evalRaces) {
    const market = buildMarketRecord(r);
    const model = buildModelRecord(qEngine, plEngine, tree, r);
    records.push({
      date: r.date, venue: r.venue, racenum: r.racenum, shimekiriMin: shimekiriMin(r.shimekiri),
      chakuju: r.chakuju, payoutMul: parsePayout100(r.payout) / 100,
      marketSkip: market.skip, marketPoints: market.points,
      modelSkip: model.skip, modelPoints: model.points,
    });
  }
  const both = records.filter(r => !r.marketSkip && !r.modelSkip);
  const marketOnlySkip = records.filter(r => r.marketSkip && !r.modelSkip).length;
  const modelOnlySkip = records.filter(r => !r.marketSkip && r.modelSkip).length;
  console.log('評価対象(真T-10) n=', evalRaces.length, ' 両方式構成可能(積集合) n=', both.length);
  console.log('市場のみ不可(モデルは可) =', marketOnlySkip, ' モデルのみ不可(市場は可) =', modelOnlySkip);

  const pureA = evalFlat(both, 'marketPoints');
  const pureB = evalFlat(both, 'modelPoints');
  console.log(`市場基準: 帯内的中${pureA.bandHit}/${pureA.n}=${(pureA.bandHit / pureA.n * 100).toFixed(2)}% 全的中${pureA.hit} ROI${pureA.roi.toFixed(1)}%`);
  console.log(`木モデル: 帯内的中${pureB.bandHit}/${pureB.n}=${(pureB.bandHit / pureB.n * 100).toFixed(2)}% 全的中${pureB.hit} ROI${pureB.roi.toFixed(1)}%`);
  let onlyModelPure = 0, onlyMarketPure = 0, bothPure = 0;
  for (const r of both) {
    const hm = r.chakuju && r.modelPoints.includes(r.chakuju) && r.payoutMul >= 50 && r.payoutMul <= 150;
    const hk = r.chakuju && r.marketPoints.includes(r.chakuju) && r.payoutMul >= 50 && r.payoutMul <= 150;
    if (hm && hk) bothPure++; else if (hm) onlyModelPure++; else if (hk) onlyMarketPure++;
  }
  console.log(`帯内的中の内訳(選別なし): 木だけ=${onlyModelPure} 市場だけ=${onlyMarketPure} 両方=${bothPure}`);

  // ===== 4. 日次上限適用後(両方式とも同じ選別規則: 帯内候補あり→締切順→1日10件) =====
  console.log('\n=== 4. 日次上限10件/日 適用前後の比較(A: 市場基準、B: 木モデル、いずれも選別は帯内候補あり→締切順→上限のみ) ===');
  const marketPool = records.filter(r => !r.marketSkip);
  const modelPool = records.filter(r => !r.modelSkip);
  console.log('上限適用前: 市場候補 n=', marketPool.length, ' 木モデル候補 n=', modelPool.length);

  const capA = applyDailyCap(marketPool);
  const capB = applyDailyCap(modelPool);
  const resA = evalFlat(capA.selected, 'marketPoints');
  const resB = evalFlat(capB.selected, 'modelPoints');
  console.log(`\nA(市場基準、上限後): n=${resA.n} 日数=${capA.dates.length} 1日平均=${(resA.n / capA.dates.length).toFixed(1)}`);
  console.log(`  帯内的中率=${(resA.bandHit / resA.n * 100).toFixed(2)}%(${resA.bandHit}件) 全的中率=${(resA.hit / resA.n * 100).toFixed(2)}% ROI=${resA.roi.toFixed(1)}%`);
  console.log(`  無的中日数=${capA.dates.filter(d => !resA.dayHitMap[d]).length}/${capA.dates.length} 最大連敗=${resA.maxStreak} 帯外移動=${resA.migratedOutHit}`);
  console.log('  日別:', capA.dates.map(d => `${d}:${capA.perDay[d].selectedCount}(候補${capA.perDay[d].poolCount})`).join('  '));

  console.log(`\nB(木モデル、上限後): n=${resB.n} 日数=${capB.dates.length} 1日平均=${(resB.n / capB.dates.length).toFixed(1)}`);
  console.log(`  帯内的中率=${(resB.bandHit / resB.n * 100).toFixed(2)}%(${resB.bandHit}件) 全的中率=${(resB.hit / resB.n * 100).toFixed(2)}% ROI=${resB.roi.toFixed(1)}%`);
  console.log(`  無的中日数=${capB.dates.filter(d => !resB.dayHitMap[d]).length}/${capB.dates.length} 最大連敗=${resB.maxStreak} 帯外移動=${resB.migratedOutHit}`);
  console.log('  日別:', capB.dates.map(d => `${d}:${capB.perDay[d].selectedCount}(候補${capB.perDay[d].poolCount})`).join('  '));

  // Aだけ/Bだけ/両方的中(共通レースIDで突合、上限適用後)
  const aKeys = new Map(capA.selected.map(r => [`${r.date}_${r.venue}_${r.racenum}`, r]));
  const bKeys = new Map(capB.selected.map(r => [`${r.date}_${r.venue}_${r.racenum}`, r]));
  let onlyA = 0, onlyB = 0, bothHit = 0;
  const allKeys = new Set([...aKeys.keys(), ...bKeys.keys()]);
  for (const k of allKeys) {
    const ra = aKeys.get(k), rb = bKeys.get(k);
    const hitA = ra && ra.chakuju && ra.marketPoints.includes(ra.chakuju) && ra.payoutMul >= 50 && ra.payoutMul <= 150;
    const hitB = rb && rb.chakuju && rb.modelPoints.includes(rb.chakuju) && rb.payoutMul >= 50 && rb.payoutMul <= 150;
    if (hitA && hitB) bothHit++; else if (hitA) onlyA++; else if (hitB) onlyB++;
  }
  console.log(`\nAだけ的中=${onlyA} Bだけ的中=${onlyB} 両方的中=${bothHit}(上限適用後、共通レースIDで突合)`);

  console.log('\n=== 目標(10本前後・帯内的中率20%)との差 ===');
  console.log(`A: 1日平均${(resA.n / capA.dates.length).toFixed(1)}本 帯内的中率${(resA.bandHit / resA.n * 100).toFixed(2)}%(差${(20 - resA.bandHit / resA.n * 100).toFixed(1)}pt)`);
  console.log(`B: 1日平均${(resB.n / capB.dates.length).toFixed(1)}本 帯内的中率${(resB.bandHit / resB.n * 100).toFixed(2)}%(差${(20 - resB.bandHit / resB.n * 100).toFixed(1)}pt)`);

  const manifest = {
    generatedAt: loadedAt, scriptHash,
    frozenInputs: { trainKeysHash: freezeManifest.trainKeysHash, trainKeysCount: freezeManifest.trainKeysCount, evalKeysHash: freezeManifest.evalKeysHash, evalKeysCount: freezeManifest.evalKeysCount },
    scopeNote: '既存データのみ使用(開発用、既に分析済みの期間、探索的評価)。単一train/eval分割(foldなし)。新しい参入モデルは作らず点選択のみ比較。',
    modelSpec: { type: 'single CART tree', maxDepth: MAX_DEPTH, minLeaf: MIN_LEAF, features: FEATURE_NAMES },
    dataUsage: { trainCount: trainRaces.length, trainDays: [...new Set(trainRaces.map(r => r.date))].length, evalCount: evalRaces.length, evalDays: evalDates.length },
    pureRanking: { n: both.length, market: pureA, model: pureB, onlyModel: onlyModelPure, onlyMarket: onlyMarketPure, both: bothPure },
    afterDailyCap: { A: { ...resA, dayHitMap: undefined, days: capA.dates.length }, B: { ...resB, dayHitMap: undefined, days: capB.dates.length }, onlyA, onlyB, both: bothHit },
  };
  fs.writeFileSync(path.join(ROOT, 'logs', 'research_tree_rank_model_v8_2026-09-02.json'), JSON.stringify(manifest, null, 2));
  console.log('\n結果を logs/research_tree_rank_model_v8_2026-09-02.json へ保存しました。');
}

if (require.main === module) main();
module.exports = { main, buildTree, predictTree, buildMarketRecord, buildModelRecord };
