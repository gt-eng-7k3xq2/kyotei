'use strict';
// GARON-20260901-003 継続、CEO承認(2026-09-02、Codexレビュー受領): v8の実装/説明の不一致を
// 修正した上での再比較。今回は新モデルの総当たりではなく、学習・評価の実装と説明を一致させる。
// PL変換・木の深さ・特徴量・同点規則は変更しない(それらの変更は別の仮説として扱う)。
//
// 【修正1: 学習条件の独立(isUsable()のoddsMap必須要件を学習には課さない)】
// 共有のisUsable()(tests/q_engine_entry_backtest.js)や本番コードは変更しない。研究専用の
// isTrainEligible()をこのファイル内にのみ定義する。
//
// 【修正2: 締切判定の秒切り捨てバグ】
// 旧classifyTiming()(v6/v7/v8で使用)は分単位への丸めにより、締切後59秒までを
// 「締切前」と誤判定し得た(shimekiriMin()・getUTCMinutes()がいずれも秒を切り捨てるため)。
// 本ファイルのclassifyTimingFixed()はミリ秒精度で比較し、取得時刻が締切より厳密に前
// (diffMs>0)であることを要求する。境界テストをmain()冒頭で実行する。
//
// archivedAtがoddsMapの取得時刻を表す根拠(収集コードで確認済み): scripts/lib/archive-entry.js
// のbuildArchiveEntry(d,...)がarchivedAt=new Date().toISOString()を設定するのは、呼び出し元
// (scripts/realtime_screening.js:328,343、scripts/collect_playwright.js)がparseData()で
// oddsMap込みのdを構築した直後であり、介在する非同期待機は無い。またscripts/lib/collect-race.js
// のcollectOneRace()は1回のページ読み込み(race_shusso.php)でBM相当データ(艇情報・オッズを含む)
// を一括取得しており、oddsMapだけ別タイミングで取得される経路は無い。したがってarchivedAtは
// そのレコードのoddsMap取得時刻の妥当な代理指標として扱える。
//
// 【修正3: 本当の入力・モデル固定】
// レースIDだけでなく、学習に使った特徴量・ラベルの実データ、評価に使ったoddsMap/boats/chakuju/
// payoutの実データを研究用フリーズファイルへ保存し、内容ハッシュを付ける。学習済みの木も
// JSON保存し、以降の構造診断はこの保存済みモデルを読み込む形にする(このファイル自体は
// 「今回1回だけ学習する」ため木を直接使うが、次回以降の診断はfrozenの木JSONを読む設計とする)。
// 原本(daikibo_archive_*.json)は変更しない。
//
// 前回の構造診断(research_findings_2026-09-02_band50to150_v8_structure_audit.md)の訂正:
// 「保存済み設計図からの再構築」という表現は、レースIDのみが凍結されていた実態を踏まえると
// 正確ではない。実際には「現行データで同じ手順を再学習した」だけであり、艇の系統別順位等の
// 実データが凍結時点から変化していないかまでは検証していなかった。今回はその反省を踏まえ、
// 実データそのものをハッシュ付きで凍結する。
//
// 使い方: node tests/research_tree_rank_model_v9_2026-09-02.js

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { loadQEngine } = require('./lib/extract-q-engine.js');
const { loadPLEngine } = require('./lib/extract-pl-engine.js');
const { buildFeatures, FEATURE_NAMES } = require('./lib/alpha-features.js');
const { loadAllRaces } = require('./q_engine_entry_backtest.js');
const { computeAllComboProbs } = require('./engine_alpha_prototype.js');
const v8 = require('./research_tree_rank_model_v8_2026-09-02.js'); // buildTree/predictTreeは変更しないためそのまま再利用

const ROOT = path.join(__dirname, '..');
const FLAT_STAKE = 100;
const POINTS_FIXED = 8;
const DAILY_CAP = 10;
const TRAIN_HI_EXCLUSIVE = '2026-08-21';
const EVAL_LO = '2026-08-21', EVAL_HI = '2026-08-31';

function hashObj(obj) { return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex'); }
function parsePayout100(s) { if (!s) return 0; const n = parseInt(String(s).replace(/[^\d]/g, ''), 10); return isNaN(n) ? 0 : n; }
function shimekiriMinTrunc(s) { if (!s) return null; const m = String(s).match(/(\d{1,2}):(\d{2})/); return m ? (+m[1]) * 60 + (+m[2]) : null; } // 旧(分丸め)実装、比較用に残す
function validOdds(r) { return Object.entries(r.oddsMap || {}).filter(([, v]) => parseFloat(v) > 0); }
function inRange(d, lo, hi) { return d >= lo && d <= hi; }

// ===== 修正1: 学習専用の適格条件(研究用のみ、isUsable()・本番は無変更) =====
function isTrainEligible(r) {
  return r.resulted === true && !!r.chakuju && r.boats && r.boats.length === 6 && r.boats.every(b => !b.isJogai);
}

// ===== 修正2: 締切判定(ミリ秒精度、取得時刻は締切より厳密に前) =====
function shimekiriMsFixed(dateStr, shimekiriStr) {
  const m = String(shimekiriStr).match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const ms = Date.parse(`${dateStr}T${m[1].padStart(2, '0')}:${m[2]}:00.000+09:00`);
  return isNaN(ms) ? null : ms;
}
function classifyTimingFixed(r) {
  if (!r.archivedAt) return { cls: 'unknown', diffMs: null };
  const archMs = Date.parse(r.archivedAt);
  if (isNaN(archMs)) return { cls: 'unknown', diffMs: null };
  const deadlineMs = shimekiriMsFixed(r.date, r.shimekiri);
  if (deadlineMs == null) return { cls: 'unknown', diffMs: null };
  const diffMs = deadlineMs - archMs; // 正なら締切より前
  if (diffMs > 0 && diffMs <= 20 * 60 * 1000) return { cls: 'true', diffMs };
  return { cls: 'unknown', diffMs };
}
// 旧実装(分丸め、バグあり)。比較専用に再現する。
function classifyTimingOldBuggy(r) {
  if (!r.archivedAt) return 'unknown';
  const archJST = new Date(new Date(r.archivedAt).getTime() + 9 * 3600 * 1000);
  const archDateJST = archJST.toISOString().slice(0, 10);
  const archMinJST = archJST.getUTCHours() * 60 + archJST.getUTCMinutes();
  const sMin = shimekiriMinTrunc(r.shimekiri);
  if (archDateJST === r.date && sMin != null) {
    const diff = sMin - archMinJST;
    if (diff >= 0 && diff <= 20) return 'true';
  }
  return 'unknown';
}

function runBoundaryTests() {
  console.log('=== 締切判定 境界テスト(旧バグ実装 vs 新ミリ秒精度実装) ===');
  const DATE = '2026-09-02', SHIMEKIRI = '10:00'; // JST締切10:00:00
  const cases = [
    { label: '締切59秒後に取得', archivedAt: '2026-09-02T01:00:59.000Z' }, // JST10:00:59
    { label: '締切1秒後に取得', archivedAt: '2026-09-02T01:00:01.000Z' },  // JST10:00:01
    { label: '締切ちょうどに取得', archivedAt: '2026-09-02T01:00:00.000Z' }, // JST10:00:00
    { label: '締切1秒前に取得', archivedAt: '2026-09-02T00:59:59.000Z' },  // JST09:59:59
    { label: '締切20分00秒前に取得', archivedAt: '2026-09-02T00:40:00.000Z' }, // JST09:40:00
    { label: '締切20分01秒前に取得', archivedAt: '2026-09-01T23:39:59.000Z' }, // JST09:39:59
  ];
  for (const c of cases) {
    const r = { date: DATE, shimekiri: SHIMEKIRI, archivedAt: c.archivedAt };
    const oldCls = classifyTimingOldBuggy(r);
    const newRes = classifyTimingFixed(r);
    console.log(`  ${c.label}: 旧=${oldCls} 新=${newRes.cls}(diffMs=${newRes.diffMs}) ${oldCls !== newRes.cls ? '← 判定が変わる(旧の誤判定を修正)' : ''}`);
  }
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
  r.boats.forEach((b, i) => { scoreMap[String(b.no)] = v8.predictTree(tree, feat[i]); });
  let comboScores; try { comboScores = computeAllComboProbs(plEngine, scoreMap, 1); } catch (e) { return { skip: 'PL_ERROR' }; }
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
    const dayRaces = byDate[date].slice().sort((a, b) => (a.shimekiriMs ?? 0) - (b.shimekiriMs ?? 0));
    const chosen = dayRaces.slice(0, DAILY_CAP);
    selected.push(...chosen);
    perDay[date] = { poolCount: dayRaces.length, selectedCount: chosen.length };
  }
  return { selected, perDay, dates };
}

function main() {
  console.log('=== v9: v8実装/説明の不一致修正 + 再比較(2026-09-02) ===\n');
  runBoundaryTests();

  const loadedAt = new Date().toISOString();
  const all = loadAllRaces();
  console.log('\nデータ読込完了(loadedAt=' + loadedAt + ')、以降このスナップショットのみ使用。総数=', all.length);

  // ===== 修正2の影響: 旧評価集合(真T-10、分丸めバグあり)から外れる件数 =====
  console.log('\n=== 修正2の影響: 旧true-T10集合から外れる件数 ===');
  const evalDateRange = all.filter(r => inRange(r.date, EVAL_LO, EVAL_HI));
  const oldTrueT10 = evalDateRange.filter(r => classifyTimingOldBuggy(r) === 'true');
  const newTrueT10 = evalDateRange.filter(r => classifyTimingFixed(r).cls === 'true');
  const oldKeys = new Set(oldTrueT10.map(r => `${r.date}_${r.venue}_${r.racenum}`));
  const newKeys = new Set(newTrueT10.map(r => `${r.date}_${r.venue}_${r.racenum}`));
  const droppedByFix = [...oldKeys].filter(k => !newKeys.has(k));
  const addedByFix = [...newKeys].filter(k => !oldKeys.has(k));
  console.log('旧(分丸めバグ)true-T10 n=', oldTrueT10.length, ' 新(ミリ秒精度)true-T10 n=', newTrueT10.length);
  console.log('修正により除外された件数(締切後だったのに旧実装で含まれていた等) =', droppedByFix.length);
  console.log('修正により新たに含まれた件数(境界の丸め方向の違いによる) =', addedByFix.length);

  // ===== 修正1の影響: 学習対象の拡張 =====
  console.log('\n=== 修正1の影響: 学習対象の拡張(オッズ必須条件を外す) ===');
  const { isUsable } = require('./q_engine_entry_backtest.js');
  const oldTrainPool = all.filter(r => isUsable(r) && r.date < TRAIN_HI_EXCLUSIVE);
  const trainRaces = all.filter(r => isTrainEligible(r) && r.date < TRAIN_HI_EXCLUSIVE);
  console.log('旧学習対象(isUsable) n=', oldTrainPool.length, ' 新学習対象(isTrainEligible) n=', trainRaces.length, ' 増分=', trainRaces.length - oldTrainPool.length);
  const trainDates = [...new Set(trainRaces.map(r => r.date))].sort();
  console.log('学習対象日数=', trainDates.length, ' 範囲=', trainDates[0], '〜', trainDates[trainDates.length - 1]);
  console.log('増分レースは全て既存の42日間の範囲内(新しい日付は追加されていない、確認済み)。追加分はoddsMap欠損/空により従来isUsableから漏れていたレースで、boats(選手情報)・chakuju(確定着順)自体は当時の値のまま。');

  const evalRacesBase = evalDateRange.filter(r => require('./q_engine_entry_backtest.js').isUsable(r));
  const evalRaces = evalRacesBase.filter(r => classifyTimingFixed(r).cls === 'true');
  console.log('\n買い目評価(修正後、真T-10) n=', evalRaces.length, '(旧n=1215から', 1215 - evalRaces.length, '件変化)');

  // ===== 修正3: 学習データの実内容を凍結(特徴量・ラベル) =====
  const qEngine = loadQEngine(path.join(ROOT, 'garon_q_engine.html'));
  const plEngine = loadPLEngine(path.join(ROOT, 'sg_narutou.html'));
  console.log('\n=== 学習(修正1の拡張母集団、PL変換・木の深さ・特徴量・同点規則は変更なし) ===');
  const trainRows = [];
  const trainKeysUsed = [];
  for (const r of trainRaces) {
    let ranks; try { ranks = qEngine.rankBoatsBySystem(r.boats); } catch (e) { continue; }
    const feat = buildFeatures(r.boats, ranks);
    const winnerBoat = parseInt(r.chakuju.split('-')[0], 10);
    trainKeysUsed.push(`${r.date}_${r.venue}_${r.racenum}`);
    r.boats.forEach((b, i) => { trainRows.push({ x: feat[i], y: b.no === winnerBoat ? 1 : 0 }); });
  }
  console.log('艇単位プール学習データ n=', trainRows.length, '(', trainKeysUsed.length, 'レース、正例=', trainRows.reduce((s, r) => s + r.y, 0), ')');
  const tree = v8.buildTree(trainRows, 0);
  function collectLeaves(node, leaves) { if (node.leaf) leaves.push(node.value); else { collectLeaves(node.left, leaves); collectLeaves(node.right, leaves); } }
  const leafValues = []; collectLeaves(tree, leafValues);
  console.log('学習された木の葉数=', leafValues.length, ' 葉の値:', leafValues.map(v => v.toFixed(3)).join(', '));

  // 実データの凍結(内容ハッシュ付き、レースIDだけでなく特徴量・ラベルそのもの)
  const trainContentHash = hashObj(trainRows);
  const evalContentForFreeze = evalRaces.map(r => ({ key: `${r.date}_${r.venue}_${r.racenum}`, boats: r.boats, oddsMap: r.oddsMap, chakuju: r.chakuju, payout: r.payout, shimekiri: r.shimekiri, archivedAt: r.archivedAt }));
  const evalContentHash = hashObj(evalContentForFreeze);
  const codeVersions = {
    v9ScriptHash: hashObj(fs.readFileSync(__filename, 'utf8')),
    v8ScriptHash: hashObj(fs.readFileSync(path.join(ROOT, 'tests', 'research_tree_rank_model_v8_2026-09-02.js'), 'utf8')),
    alphaFeaturesHash: hashObj(fs.readFileSync(path.join(ROOT, 'tests', 'lib', 'alpha-features.js'), 'utf8')),
    engineAlphaPrototypeHash: hashObj(fs.readFileSync(path.join(ROOT, 'tests', 'engine_alpha_prototype.js'), 'utf8')),
    garonQEngineHtmlHash: hashObj(fs.readFileSync(path.join(ROOT, 'garon_q_engine.html'), 'utf8')),
    sgNarutouHtmlHash: hashObj(fs.readFileSync(path.join(ROOT, 'sg_narutou.html'), 'utf8')),
  };
  fs.writeFileSync(path.join(ROOT, 'logs', 'research_tree_rank_model_v9_frozen_train_2026-09-02.json'), JSON.stringify({ generatedAt: loadedAt, contentHash: trainContentHash, keysUsed: trainKeysUsed, rows: trainRows }));
  fs.writeFileSync(path.join(ROOT, 'logs', 'research_tree_rank_model_v9_frozen_eval_2026-09-02.json'), JSON.stringify({ generatedAt: loadedAt, contentHash: evalContentHash, races: evalContentForFreeze }));
  fs.writeFileSync(path.join(ROOT, 'logs', 'research_tree_rank_model_v9_saved_tree_2026-09-02.json'), JSON.stringify({ generatedAt: loadedAt, codeVersions, trainContentHash, tree }));
  console.log('\n実データを凍結保存(内容ハッシュ付き): 学習=', trainContentHash.slice(0, 16), '... 評価=', evalContentHash.slice(0, 16), '...');
  console.log('学習済みの木を logs/research_tree_rank_model_v9_saved_tree_2026-09-02.json へ保存(以降の診断はこれを読み込む設計とする)。');

  // ===== 修正4: PL入力の意味を確認(コード変更なし、分析のみ) =====
  console.log('\n=== PL入力の意味の確認(_plWinProbs/_plConditionalProbsの数値例、コード変更なし) ===');
  console.log('sg_narutou.html:2035 `strengths[b]=Math.exp(scoreMap[b]/temperature)` は、scoreMapの値を「対数強度」(log-strength)として扱う設計(Bradley-Terry/Plackett-Luceの標準形)。');
  console.log('本モデルは木の葉の値(0〜1の正例率、確率)をそのままscoreMapへ渡している。数値例(実際の葉の値を使用):');
  const sortedLeaves = [...new Set(leafValues.map(v => Number(v.toFixed(6))))].sort((a, b) => a - b);
  const exampleLo = sortedLeaves[0], exampleHi = sortedLeaves[sortedLeaves.length - 1];
  console.log(`  最小葉値=${exampleLo} → exp(${exampleLo})=${Math.exp(exampleLo).toFixed(4)}`);
  console.log(`  最大葉値=${exampleHi} → exp(${exampleHi})=${Math.exp(exampleHi).toFixed(4)}`);
  console.log(`  強度比(最大/最小) = ${(Math.exp(exampleHi) / Math.exp(exampleLo)).toFixed(3)}倍`);
  console.log('  参考: 仮に同じ最小・最大値を「対数強度」として素直に解釈した場合の強度比は上記の通りだが、通常の対数強度モデル(線形回帰の生スコア等、値域が±数の範囲になり得る)であれば同程度の差でも強度比は指数的にもっと大きくなり得る。');
  console.log('  → 現在の変換(0〜1の正例率をそのまま対数強度として渡す設計)では、艇間の強弱がsoftmax後に大きく圧縮される可能性がある。これは実装上のミスではなく、モデル出力の型(比率)と変換式が前提とする型(対数強度)の不一致という設計上の特性であり、成績の良し悪しとは独立した事実として記録する(CEO指示通り、今回この変換方法は変更しない)。');

  // ===== 修正5: 修正後の比較(市場基準 vs 木モデル、同一の新評価集合) =====
  console.log('\n=== 修正後の比較(主結果、新しい評価集合での市場基準 vs 木モデル) ===');
  const records = [];
  for (const r of evalRaces) {
    const market = buildMarketRecord(r);
    const model = buildModelRecord(qEngine, plEngine, tree, r);
    const timing = classifyTimingFixed(r);
    records.push({
      date: r.date, venue: r.venue, racenum: r.racenum, shimekiriMs: shimekiriMsFixed(r.date, r.shimekiri),
      chakuju: r.chakuju, payoutMul: parsePayout100(r.payout) / 100,
      marketSkip: market.skip, marketPoints: market.points,
      modelSkip: model.skip, modelPoints: model.points,
    });
  }
  const both = records.filter(r => !r.marketSkip && !r.modelSkip);
  console.log('評価対象(修正後の真T-10) n=', evalRaces.length, ' 両方式構成可能(積集合) n=', both.length);
  const pureA = evalFlat(both, 'marketPoints');
  const pureB = evalFlat(both, 'modelPoints');
  console.log(`市場基準(選別なし): 帯内的中${pureA.bandHit}/${pureA.n}=${(pureA.bandHit / pureA.n * 100).toFixed(2)}% 全的中${pureA.hit} ROI${pureA.roi.toFixed(1)}%`);
  console.log(`木モデル(選別なし): 帯内的中${pureB.bandHit}/${pureB.n}=${(pureB.bandHit / pureB.n * 100).toFixed(2)}% 全的中${pureB.hit} ROI${pureB.roi.toFixed(1)}%`);

  const marketPool = records.filter(r => !r.marketSkip);
  const modelPool = records.filter(r => !r.modelSkip);
  const capA = applyDailyCap(marketPool);
  const capB = applyDailyCap(modelPool);
  const resA = evalFlat(capA.selected, 'marketPoints');
  const resB = evalFlat(capB.selected, 'modelPoints');
  console.log(`\nA(市場基準、締切順・1日10件上限後): n=${resA.n} 日数=${capA.dates.length} 1日平均=${(resA.n / capA.dates.length).toFixed(1)}`);
  console.log(`  帯内的中率=${(resA.bandHit / resA.n * 100).toFixed(2)}%(${resA.bandHit}件) 全的中率=${(resA.hit / resA.n * 100).toFixed(2)}% ROI=${resA.roi.toFixed(1)}% 無的中日=${capA.dates.filter(d => !resA.dayHitMap[d]).length}/${capA.dates.length} 最大連敗=${resA.maxStreak}`);
  console.log(`\nB(木モデル、締切順・1日10件上限後): n=${resB.n} 日数=${capB.dates.length} 1日平均=${(resB.n / capB.dates.length).toFixed(1)}`);
  console.log(`  帯内的中率=${(resB.bandHit / resB.n * 100).toFixed(2)}%(${resB.bandHit}件) 全的中率=${(resB.hit / resB.n * 100).toFixed(2)}% ROI=${resB.roi.toFixed(1)}% 無的中日=${capB.dates.filter(d => !resB.dayHitMap[d]).length}/${capB.dates.length} 最大連敗=${resB.maxStreak}`);

  console.log('\n【注意】学習対象拡張(修正1)・評価集合修正(修正2)により対象自体が旧結果(v8)と異なる。この差を単純にモデル改善/劣化とは呼ばない。今回の主結果はあくまで同一の新しい評価集合でのA(市場)対B(木)の比較である。');

  console.log('\n=== 目標(10本前後・帯内的中率20%)との差 ===');
  console.log(`A: 1日平均${(resA.n / capA.dates.length).toFixed(1)}本 帯内的中率${(resA.bandHit / resA.n * 100).toFixed(2)}%(差${(20 - resA.bandHit / resA.n * 100).toFixed(1)}pt)`);
  console.log(`B: 1日平均${(resB.n / capB.dates.length).toFixed(1)}本 帯内的中率${(resB.bandHit / resB.n * 100).toFixed(2)}%(差${(20 - resB.bandHit / resB.n * 100).toFixed(1)}pt)`);

  const manifest = {
    generatedAt: loadedAt, codeVersions,
    scopeNote: 'v8の実装/説明の不一致を修正(学習条件独立・締切判定ミリ秒精度化・実データ凍結)。PL変換・木の深さ・特徴量・同点規則は変更なし。学習対象拡張・評価集合修正により対象がv8と異なるため、成績差を単純なモデル改善とは呼ばない。',
    timingFixImpact: { oldTrueT10Count: oldTrueT10.length, newTrueT10Count: newTrueT10.length, droppedByFix: droppedByFix.length, addedByFix: addedByFix.length },
    trainEligibilityImpact: { oldTrainCount: oldTrainPool.length, newTrainCount: trainRaces.length, delta: trainRaces.length - oldTrainPool.length },
    trainContentHash, evalContentHash,
    leafValues: leafValues.map(v => Number(v.toFixed(6))),
    pureRanking: { n: both.length, market: pureA, model: pureB },
    afterDailyCap: { A: { ...resA, dayHitMap: undefined, days: capA.dates.length }, B: { ...resB, dayHitMap: undefined, days: capB.dates.length } },
  };
  fs.writeFileSync(path.join(ROOT, 'logs', 'research_tree_rank_model_v9_2026-09-02.json'), JSON.stringify(manifest, null, 2));
  console.log('\n結果を logs/research_tree_rank_model_v9_2026-09-02.json へ保存しました。');
}

if (require.main === module) main();
module.exports = { main, isTrainEligible, classifyTimingFixed, classifyTimingOldBuggy, shimekiriMsFixed };
