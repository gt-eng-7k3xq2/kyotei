'use strict';
// GARON-20260901-003 継続、CEO指示(2026-09-02): 「間接的な確信度」ではなく、最終目標を直接
// 予測するレース選別モデルを1方式だけ実装・比較する。買い目(市場基準・帯内オッズ昇順8点)は
// 固定し、変えるのはレース選別(参入判断)のみ。
//
// 【0. 前回モデル(v6のPL)の学習・比較期間・重みの作成時点(結果を見る前に確認・訂正)】
// tests/research_model_v6_band50to150_2026-09-02.jsの重みwは、本スクリプト・当該スクリプトの
// いずれも実行のたびにゼロから再学習しており(trainWeights()内でw=new Array(...).fill(0)から
// 開始、過去の学習係数の持ち越しは無い)、学習に使ったのは2026-07-01〜07-05(n=797)のみ。
// v6の「比較期間」(07-08・08-11・08-26〜08-30・08-31、n=520)は重みの作成に一切使っていない
// (train.filter(inRange(TRAIN_LO,TRAIN_HI))で明確に分離、コード上も確認可能)。
// したがって520件の比較は学習済みデータ上の記述結果ではなく、未知データでの評価として扱ってよい。
// 訂正が必要な事実は無かったため、追加の再実行はしていない。
//
// 【1. 目的変数(実装前に固定)】
// y=1: 固定した買い目(市場基準・予想時点50-150倍オッズ昇順8点、8点未満は対象外)の的中目に
//      着順が一致し、かつ確定払戻倍率が50-150倍である。y=0: それ以外。
// 確定着順・確定払戻・結果後情報は目的変数の構成にのみ使い、入力特徴量には一切使わない。
//
// 【2. 入力特徴量(実装前に固定、各項目の関係し得る理由を明記)】
//  (a) bandCandidateCount: 予想時点50-150倍の全候補数(120通り中)/120。理由: 市場の確率質量が
//      中間配当帯にどれだけ広く分布しているかの指標。候補が多いレースほど、実際の結果も
//      その帯に収まりやすいと考えられる。
//  (b) oddsSpread8: 固定8点(市場基準で選ばれたオッズ最安値8点)の最大-最小オッズ/100。理由:
//      8点が帯の特定の狭い範囲(端寄り)に密集しているレースは、確定時のわずかな変動で
//      帯外へ出やすい。散らばりが大きい(帯の広い範囲をカバーする)ほど頑健と考えられる。
//  (c) centeredness: min(平均オッズ-50, 150-平均オッズ)/50(負値は0にクリップ)。理由: 8点の
//      平均が帯の中心に近いほど、確定時の変動に対して帯からはみ出しにくい。
//  (d) marketEntropy: 各艇の市場逆オッズ由来1着確率のシャノンエントロピー/ln(6)。理由: 市場が
//      1艇に収束している(エントロピー低い)レースは決着が堅く低配当寄り、逆に大きく割れている
//      レースは大穴寄りになりやすいと考えられ、中間的なエントロピーの帯が中配当帯と関係し得る。
//  (e) plTopProb: 既存資産(v6で学習済みのPlackett-Luce多項ロジット、学習期間2026-07-01〜07-05
//      で固定、艇の系統別順位のみを入力)が推定する、そのレースの最上位1点の確率。理由:
//      艇の地力情報を要約した「決着の堅さ」の別角度からの指標。今回はこれ単体で参入判断せず、
//      他の特徴量と合わせて目的変数へ直接再学習する(CEO指示通り)。
// 上記5項目はいずれも予想時点(締切前)に計算可能で、確定結果・確定払戻・後日更新統計を含まない。
// 説明できない項目は採用していない(総当たり探索はしていない)。
//
// 【3. モデル】L2正則化付きロジスティック回帰(1方式のみ、勾配降下でフルバッチ学習)。
//   複数モデルの比較・特徴量総当たり・グリッドサーチは行わない。
//
// 【4. 時系列評価】締切前確認済み集合(真T-10、archivedAtが締切0-20分前・同日)を主結果とし、
//   拡大型(expanding window)の日付順walk-forwardで学習→評価を行う。時点不明データを含む集合は
//   感度分析としてのみ別掲し、本番再現性の証拠にはしない。参入閾値は学習期間のスコア分布のみ
//   から平均10件/日になる絶対値を機械的に決定し、評価期間で結果を見て変更しない。
//
// 使い方: node tests/research_direct_target_model_v7_2026-09-02.js

const path = require('path');
const fs = require('fs');
const { loadQEngine } = require('./lib/extract-q-engine.js');
const { loadPLEngine } = require('./lib/extract-pl-engine.js');
const { buildFeatures, FEATURE_NAMES } = require('./lib/alpha-features.js');
const { isUsable, hasFullData, loadAllRaces } = require('./q_engine_entry_backtest.js');
const { computeAllComboProbs } = require('./engine_alpha_prototype.js');
const { trainWeights: trainPLWeights, prepareDataset } = require('./alpha_train_model.js');

const ROOT = path.join(__dirname, '..');
const FLAT_STAKE = 100;
const POINTS_FIXED = 8;
const DAILY_CAP = 10;
const PL_TRAIN_LO = '2026-07-01', PL_TRAIN_HI = '2026-07-05'; // v6と同一、既存資産をそのまま再利用

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

function buildMarketRecord(r) {
  const entries = validOdds(r);
  if (entries.length !== 120) return { skip: 'INCOMPLETE_ODDS_120' };
  const band = entries.filter(([, v]) => v >= 50 && v <= 150).map(([val, v]) => ({ val, odds: v }));
  if (band.length < POINTS_FIXED) return { skip: 'INSUFFICIENT_BAND_CANDIDATES' };
  const sorted = band.slice().sort((a, b) => (a.odds - b.odds) || (a.val < b.val ? -1 : a.val > b.val ? 1 : 0));
  const chosen = sorted.slice(0, POINTS_FIXED);
  return { skip: null, points: chosen.map(p => p.val), oddsOfPoints: chosen.map(p => p.odds), bandCandidateCount: band.length };
}

function marketEntropyOf(r) {
  const boats = r.boats.map(b => String(b.no));
  const minOdds = {};
  boats.forEach(no => {
    let m = Infinity;
    for (const k of Object.keys(r.oddsMap || {})) if (k.startsWith(`${no}-`)) { const o = parseFloat(r.oddsMap[k]); if (o > 0 && o < m) m = o; }
    minOdds[no] = m;
  });
  if (Object.values(minOdds).some(v => !isFinite(v))) return null;
  const inv = {}; let sum = 0; boats.forEach(no => { inv[no] = 1 / minOdds[no]; sum += inv[no]; });
  const probs = boats.map(no => inv[no] / sum);
  const H = -probs.reduce((s, p) => s + (p > 0 ? p * Math.log(p) : 0), 0);
  return H / Math.log(6); // 0-1正規化
}

function buildFeatureRow(qEngine, plEngine, plW, r, market) {
  const bandCandidateCount = market.bandCandidateCount / 120;
  const oddsSpread8 = (Math.max(...market.oddsOfPoints) - Math.min(...market.oddsOfPoints)) / 100;
  const meanOdds = market.oddsOfPoints.reduce((s, o) => s + o, 0) / market.oddsOfPoints.length;
  const centeredness = Math.max(0, Math.min(meanOdds - 50, 150 - meanOdds)) / 50;
  const entropy = marketEntropyOf(r);
  if (entropy == null) return null;
  let ranks; try { ranks = qEngine.rankBoatsBySystem(r.boats); } catch (e) { return null; }
  const feat = buildFeatures(r.boats, ranks);
  const scores = feat.map(x => x.reduce((s, v, k) => s + v * plW[k], 0));
  const scoreMap = {}; r.boats.forEach((b, i) => { scoreMap[String(b.no)] = scores[i]; });
  let comboProbs; try { comboProbs = computeAllComboProbs(plEngine, scoreMap, 1); } catch (e) { return null; }
  const plTopProb = comboProbs.length ? Math.max(...comboProbs.map(c => c.p)) : 0;
  return [bandCandidateCount, oddsSpread8, centeredness, entropy, plTopProb];
}
const FEATURE_LABELS = ['bandCandidateCount', 'oddsSpread8', 'centeredness', 'marketEntropy', 'plTopProb'];

function sigmoid(z) { return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z)))); }
function trainLogistic(X, y, nFeatures, { l2 = 0.05, lr = 0.3, epochs = 500 } = {}) {
  let w = new Array(nFeatures).fill(0), b = 0;
  const n = X.length;
  for (let epoch = 0; epoch < epochs; epoch++) {
    const gradW = new Array(nFeatures).fill(0); let gradB = 0;
    for (let i = 0; i < n; i++) {
      const z = b + X[i].reduce((s, v, k) => s + v * w[k], 0);
      const p = sigmoid(z);
      const err = p - y[i];
      for (let k = 0; k < nFeatures; k++) gradW[k] += err * X[i][k];
      gradB += err;
    }
    for (let k = 0; k < nFeatures; k++) { const g = gradW[k] / n + l2 * w[k]; w[k] -= lr * g; }
    b -= lr * (gradB / n);
  }
  return { w, b };
}
function standardize(X, meanArr, stdArr) { return X.map(row => row.map((v, k) => stdArr[k] > 1e-9 ? (v - meanArr[k]) / stdArr[k] : 0)); }
function meanStd(X, nFeatures) {
  const n = X.length; const mean = new Array(nFeatures).fill(0), std = new Array(nFeatures).fill(0);
  for (const row of X) row.forEach((v, k) => { mean[k] += v / n; });
  for (const row of X) row.forEach((v, k) => { std[k] += (v - mean[k]) ** 2 / n; });
  return { mean, std: std.map(Math.sqrt) };
}
function auc(scores, labels) {
  const pos = []; const neg = [];
  scores.forEach((s, i) => (labels[i] ? pos.push(s) : neg.push(s)));
  if (!pos.length || !neg.length) return null;
  let count = 0;
  for (const p of pos) for (const ng of neg) { if (p > ng) count++; else if (p === ng) count += 0.5; }
  return count / (pos.length * neg.length);
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

function buildAllRecords(qEngine, plEngine, plW, races) {
  const out = [];
  for (const r of races) {
    const market = buildMarketRecord(r);
    if (market.skip) continue;
    const feat = buildFeatureRow(qEngine, plEngine, plW, r, market);
    if (!feat) continue;
    const payoutMul = parsePayout100(r.payout) / 100;
    const y = (r.chakuju && market.points.includes(r.chakuju) && payoutMul >= 50 && payoutMul <= 150) ? 1 : 0;
    out.push({
      date: r.date, venue: r.venue, racenum: r.racenum, shimekiriMin: shimekiriMin(r.shimekiri),
      chakuju: r.chakuju, payoutMul, marketPoints: market.points, features: feat, y,
    });
  }
  return out;
}

function calibrationTable(scores, labels, bins = 5) {
  const rows = scores.map((s, i) => ({ s, y: labels[i] })).sort((a, b) => a.s - b.s);
  const binSize = Math.ceil(rows.length / bins);
  const out = [];
  for (let b = 0; b < bins; b++) {
    const slice = rows.slice(b * binSize, (b + 1) * binSize);
    if (!slice.length) continue;
    out.push({ n: slice.length, avgScore: slice.reduce((s, r) => s + r.s, 0) / slice.length, actualRate: slice.reduce((s, r) => s + r.y, 0) / slice.length });
  }
  return out;
}

function main() {
  console.log('=== GARON-20260901-003 継続: 目的変数を直接予測するレース選別モデル(2026-09-02) ===\n');

  const qEngine = loadQEngine(path.join(ROOT, 'garon_q_engine.html'));
  const plEngine = loadPLEngine(path.join(ROOT, 'sg_narutou.html'));

  // v6と同一の既存PLモデルを再学習(2026-07-01〜07-05のみ、比較期間は使わない)
  const all = loadAllRaces();
  const usable = all.filter(isUsable);
  const full = usable.filter(hasFullData);
  full.sort((a, b) => (a.date + a.venue + a.racenum).localeCompare(b.date + b.venue + b.racenum));
  const plTrainRaces = full.filter(r => inRange(r.date, PL_TRAIN_LO, PL_TRAIN_HI));
  console.log('【0確認】PLモデル学習期間=', PL_TRAIN_LO, '〜', PL_TRAIN_HI, ' n=', plTrainRaces.length, '(比較期間データは学習に不使用、今回もゼロから再学習)');
  const plSet = prepareDataset(qEngine, plTrainRaces);
  const plW = trainPLWeights(plSet, FEATURE_NAMES.length);

  console.log('\n=== 1. データ母集団の確認 ===');
  console.log('着順学習用(isUsable&&hasFullData) n=', full.length);
  const trueT10 = full.filter(r => classifyTiming(r) === 'true');
  const unknown = full.filter(r => classifyTiming(r) === 'unknown');
  console.log('締切前確認済み(真T-10) n=', trueT10.length, ' 時点不明 n=', unknown.length);
  const t10Dates = [...new Set(trueT10.map(r => r.date))].sort();
  console.log('真T-10日付・件数:', t10Dates.map(d => d + ':' + trueT10.filter(r => r.date === d).length).join(' '));

  // ===== 主結果: 真T-10のみ、拡大型walk-forward =====
  console.log('\n=== 2-3. 主結果(締切前確認済み集合、拡大型walk-forward) ===');
  const t10Records = buildAllRecords(qEngine, plEngine, plW, trueT10);
  console.log('レコード構築後 n=', t10Records.length, '(帯内候補8点未満等の除外を含む)');
  const posCount = t10Records.filter(r => r.y === 1).length;
  console.log('目的変数y=1の件数=', posCount, '(', (posCount / t10Records.length * 100).toFixed(2), '%)');

  const FOLDS = [
    { trainHi: '2026-08-28', evalLo: '2026-08-29', evalHi: '2026-08-29', label: 'Fold1: train~08-28 / eval 08-29' },
    { trainHi: '2026-08-29', evalLo: '2026-08-30', evalHi: '2026-08-30', label: 'Fold2: train~08-29 / eval 08-30' },
    { trainHi: '2026-08-30', evalLo: '2026-08-31', evalHi: '2026-08-31', label: 'Fold3: train~08-30 / eval 08-31' },
  ];
  const TRAIN_LO_T10 = '2026-08-26';

  const foldResults = [];
  let allEvalA = [], allEvalB = [];
  for (const fold of FOLDS) {
    const trainRecs = t10Records.filter(r => inRange(r.date, TRAIN_LO_T10, fold.trainHi));
    const evalRecs = t10Records.filter(r => inRange(r.date, fold.evalLo, fold.evalHi));
    if (!trainRecs.length || !evalRecs.length) { console.log(`\n[${fold.label}] 学習または評価データが0件のためスキップ`); continue; }
    const trainPos = trainRecs.filter(r => r.y === 1).length;
    console.log(`\n[${fold.label}] 学習n=${trainRecs.length}(陽性${trainPos}) 評価n=${evalRecs.length}(陽性${evalRecs.filter(r => r.y === 1).length})`);

    const { mean, std } = meanStd(trainRecs.map(r => r.features), FEATURE_LABELS.length);
    const Xtrain = standardize(trainRecs.map(r => r.features), mean, std);
    const ytrain = trainRecs.map(r => r.y);
    const { w, b } = trainLogistic(Xtrain, ytrain, FEATURE_LABELS.length);
    console.log('  係数:', FEATURE_LABELS.map((name, i) => `${name}=${w[i].toFixed(3)}`).join(' '), ` bias=${b.toFixed(3)}`);

    // 閾値: 学習期間のスコア分布のみから、平均10件/日になる絶対値を機械的に決定(的中・ROI不使用)
    const trainDays = [...new Set(trainRecs.map(r => r.date))].length;
    const scoresTrain = Xtrain.map(x => sigmoid(b + x.reduce((s, v, k) => s + v * w[k], 0)));
    const target = Math.min(DAILY_CAP * trainDays, scoresTrain.length);
    const sortedScores = scoresTrain.slice().sort((a, b2) => b2 - a);
    const THRESHOLD = sortedScores[Math.max(0, target - 1)];
    console.log(`  閾値(学習期間から機械的決定、目標${DAILY_CAP}件/日×${trainDays}日=${target}) THRESHOLD=${THRESHOLD.toFixed(4)}`);

    const Xeval = standardize(evalRecs.map(r => r.features), mean, std);
    const scoresEval = Xeval.map(x => sigmoid(b + x.reduce((s, v, k) => s + v * w[k], 0)));
    const yEval = evalRecs.map(r => r.y);
    const aucVal = auc(scoresEval, yEval);
    console.log(`  評価期間の識別性能(AUC、y=1をより高スコアにできているか)= ${aucVal != null ? aucVal.toFixed(3) : 'N/A'}`);
    const cal = calibrationTable(scoresEval, yEval, 3);
    console.log('  較正(評価期間、3分位): ' + cal.map(c => `n${c.n}:予測${(c.avgScore * 100).toFixed(1)}%→実${(c.actualRate * 100).toFixed(1)}%`).join(' / '));

    const evalWithScore = evalRecs.map((r, i) => ({ ...r, score: scoresEval[i] }));
    const evalPassB = evalWithScore.filter(r => r.score >= THRESHOLD);

    const capA = applyDailyCap(evalWithScore); // A: 選別なし・帯内候補あり→締切順10件
    const capB = applyDailyCap(evalPassB); // B: 閾値通過→締切順10件
    const resA = evalFlat(capA.selected, 'marketPoints');
    const resB = evalFlat(capB.selected, 'marketPoints');
    console.log(`  A(選別なし): n=${resA.n} 帯内的中=${resA.bandHit}(${resA.n ? (resA.bandHit / resA.n * 100).toFixed(2) : '-'}%) ROI=${resA.roi != null ? resA.roi.toFixed(1) : '-'}%`);
    console.log(`  B(モデル閾値): n=${resB.n} 帯内的中=${resB.bandHit}(${resB.n ? (resB.bandHit / resB.n * 100).toFixed(2) : '-'}%) ROI=${resB.roi != null ? resB.roi.toFixed(1) : '-'}%`);

    foldResults.push({ label: fold.label, trainN: trainRecs.length, trainPos, evalN: evalRecs.length, auc: aucVal, resA, resB, threshold: THRESHOLD });
    allEvalA.push(...capA.selected);
    allEvalB.push(...capB.selected);
  }

  console.log('\n=== 集計(全fold合算、各レースは自身のfoldの学習・閾値のみを使用) ===');
  const aggA = evalFlat(allEvalA, 'marketPoints');
  const aggB = evalFlat(allEvalB, 'marketPoints');
  const datesA = [...new Set(allEvalA.map(r => r.date))];
  const datesB = [...new Set(allEvalB.map(r => r.date))];
  console.log(`A(選別なし): n=${aggA.n} 日数=${datesA.length} 1日平均=${(aggA.n / Math.max(1, datesA.length)).toFixed(1)} 帯内的中=${aggA.bandHit}(${(aggA.bandHit / aggA.n * 100).toFixed(2)}%) 全的中=${aggA.hit}(${(aggA.hit / aggA.n * 100).toFixed(2)}%) ROI=${aggA.roi.toFixed(1)}% 無的中日=${datesA.filter(d => !aggA.dayHitMap[d]).length}/${datesA.length} 最大連敗=${aggA.maxStreak} 帯外移動=${aggA.migratedOutHit}`);
  console.log(`B(モデル閾値): n=${aggB.n} 日数=${datesB.length} 1日平均=${(aggB.n / Math.max(1, datesB.length)).toFixed(1)} 帯内的中=${aggB.bandHit}(${aggB.n ? (aggB.bandHit / aggB.n * 100).toFixed(2) : '-'}%) 全的中=${aggB.hit}(${aggB.n ? (aggB.hit / aggB.n * 100).toFixed(2) : '-'}%) ROI=${aggB.roi != null ? aggB.roi.toFixed(1) : '-'}% 無的中日=${datesB.filter(d => !aggB.dayHitMap[d]).length}/${datesB.length} 最大連敗=${aggB.maxStreak} 帯外移動=${aggB.migratedOutHit}`);

  // Aだけ的中/Bだけ的中/両方的中(共通のレースIDで突合)
  const aKeys = new Map(allEvalA.map(r => [`${r.date}_${r.venue}_${r.racenum}`, r]));
  const bKeys = new Map(allEvalB.map(r => [`${r.date}_${r.venue}_${r.racenum}`, r]));
  let onlyA = 0, onlyB = 0, both = 0;
  const allKeys = new Set([...aKeys.keys(), ...bKeys.keys()]);
  for (const k of allKeys) {
    const ra = aKeys.get(k), rb = bKeys.get(k);
    const hitA = ra && ra.chakuju && ra.marketPoints.includes(ra.chakuju) && ra.payoutMul >= 50 && ra.payoutMul <= 150;
    const hitB = rb && rb.chakuju && rb.marketPoints.includes(rb.chakuju) && rb.payoutMul >= 50 && rb.payoutMul <= 150;
    if (hitA && hitB) both++; else if (hitA) onlyA++; else if (hitB) onlyB++;
  }
  console.log(`\nAだけ的中=${onlyA} Bだけ的中=${onlyB} 両方的中=${both}`);

  console.log('\n=== 目標(10本前後・帯内的中率20%)との差 ===');
  console.log(`A: 1日平均${(aggA.n / Math.max(1, datesA.length)).toFixed(1)}本 帯内的中率${(aggA.bandHit / aggA.n * 100).toFixed(2)}%(差${(20 - aggA.bandHit / aggA.n * 100).toFixed(1)}pt)`);
  if (aggB.n) console.log(`B: 1日平均${(aggB.n / Math.max(1, datesB.length)).toFixed(1)}本 帯内的中率${(aggB.bandHit / aggB.n * 100).toFixed(2)}%(差${(20 - aggB.bandHit / aggB.n * 100).toFixed(1)}pt)`);

  console.log('\n=== fold別の方向一致・不一致(B-ROI - A-ROI) ===');
  foldResults.forEach(f => {
    const diff = (f.resB.roi != null && f.resA.roi != null) ? (f.resB.roi - f.resA.roi) : null;
    console.log(`  ${f.label}: A_ROI=${f.resA.roi != null ? f.resA.roi.toFixed(1) : '-'}% B_ROI=${f.resB.roi != null ? f.resB.roi.toFixed(1) : '-'}% 差=${diff != null ? diff.toFixed(1) : '-'}pt AUC=${f.auc != null ? f.auc.toFixed(3) : '-'}`);
  });

  // ===== 感度分析: 時点不明を含む全hasFullData集合(本番再現性の証拠にしない) =====
  console.log('\n=== 感度分析(時点不明データを含む全hasFullData集合、本番再現性の証拠にはしない) ===');
  const allRecords = buildAllRecords(qEngine, plEngine, plW, full);
  const senseTrainRecs = allRecords.filter(r => inRange(r.date, PL_TRAIN_LO, PL_TRAIN_HI));
  const senseEvalRecs = allRecords.filter(r => !inRange(r.date, PL_TRAIN_LO, PL_TRAIN_HI));
  console.log('感度分析 学習n=', senseTrainRecs.length, '(陽性', senseTrainRecs.filter(r => r.y === 1).length, ') 評価n=', senseEvalRecs.length, '(陽性', senseEvalRecs.filter(r => r.y === 1).length, ')');
  if (senseTrainRecs.length && senseEvalRecs.length) {
    const { mean: sm, std: ss } = meanStd(senseTrainRecs.map(r => r.features), FEATURE_LABELS.length);
    const sXtrain = standardize(senseTrainRecs.map(r => r.features), sm, ss);
    const sYtrain = senseTrainRecs.map(r => r.y);
    const { w: sw, b: sb } = trainLogistic(sXtrain, sYtrain, FEATURE_LABELS.length);
    const sTrainDays = [...new Set(senseTrainRecs.map(r => r.date))].length;
    const sScoresTrain = sXtrain.map(x => sigmoid(sb + x.reduce((s, v, k) => s + v * sw[k], 0)));
    const sTarget = Math.min(DAILY_CAP * sTrainDays, sScoresTrain.length);
    const sThreshold = sScoresTrain.slice().sort((a, b2) => b2 - a)[Math.max(0, sTarget - 1)];
    const sXeval = standardize(senseEvalRecs.map(r => r.features), sm, ss);
    const sScoresEval = sXeval.map(x => sigmoid(sb + x.reduce((s, v, k) => s + v * sw[k], 0)));
    const sEvalWithScore = senseEvalRecs.map((r, i) => ({ ...r, score: sScoresEval[i] }));
    const sPassB = sEvalWithScore.filter(r => r.score >= sThreshold);
    const sCapA = applyDailyCap(sEvalWithScore);
    const sCapB = applyDailyCap(sPassB);
    const sResA = evalFlat(sCapA.selected, 'marketPoints');
    const sResB = evalFlat(sCapB.selected, 'marketPoints');
    console.log(`感度分析A(選別なし): n=${sResA.n} 帯内的中=${sResA.bandHit}(${(sResA.bandHit / sResA.n * 100).toFixed(2)}%) ROI=${sResA.roi.toFixed(1)}%`);
    console.log(`感度分析B(モデル閾値): n=${sResB.n} 帯内的中=${sResB.bandHit}(${sResB.n ? (sResB.bandHit / sResB.n * 100).toFixed(2) : '-'}%) ROI=${sResB.roi != null ? sResB.roi.toFixed(1) : '-'}%`);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    scopeNote: '主結果は締切前確認済み(真T-10)集合の拡大型walk-forward。時点不明データを含む感度分析は本番再現性の証拠にしない。既存アーカイブのみ使用、外部取得・AI/API呼び出しなし。',
    plModel: { trainRange: [PL_TRAIN_LO, PL_TRAIN_HI], trainN: plTrainRaces.length, note: '比較期間データは学習に不使用' },
    dataPopulation: { fullDataCount: full.length, trueT10Count: trueT10.length, unknownCount: unknown.length },
    features: FEATURE_LABELS,
    folds: foldResults.map(f => ({ label: f.label, trainN: f.trainN, trainPos: f.trainPos, evalN: f.evalN, auc: f.auc, threshold: f.threshold, resA: { ...f.resA, dayHitMap: undefined }, resB: { ...f.resB, dayHitMap: undefined } })),
    aggregate: { A: { ...aggA, dayHitMap: undefined, days: datesA.length }, B: { ...aggB, dayHitMap: undefined, days: datesB.length }, onlyA, onlyB, both },
  };
  fs.writeFileSync(path.join(ROOT, 'logs', 'research_direct_target_model_v7_2026-09-02.json'), JSON.stringify(manifest, null, 2));
  console.log('\n結果を logs/research_direct_target_model_v7_2026-09-02.json へ保存しました。');
}

if (require.main === module) main();
module.exports = { main, buildMarketRecord, buildFeatureRow, trainLogistic, sigmoid };
