'use strict';
// GARON-20260901-003 継続、CEO指示(2026-09-02): v8が三連単の順位をどう作ったかの構造診断。
// 新モデル学習・特徴量探索・閾値変更は一切行わない。凍結済み入力(logs/research_tree_rank_model_v8_
// frozen_inputs_2026-09-02.json)の対象IDから、v8と全く同じ決定論的アルゴリズムで木を再構築する
// (ハイパーパラメータ・アルゴリズムに一切変更なし。乱数を含まないため、同じ入力からは常に同じ木に
// なる。これは「再学習」ではなく「保存済み設計図からの再構築」として扱う)。結果情報(的中・ROI)は
// 使わず、構造(葉数・スコア種類数・同点発生数・列挙順依存性)だけを診断する。

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { loadQEngine } = require('./lib/extract-q-engine.js');
const { loadPLEngine } = require('./lib/extract-pl-engine.js');
const { buildFeatures, FEATURE_NAMES } = require('./lib/alpha-features.js');
const { isUsable, loadAllRaces } = require('./q_engine_entry_backtest.js');
const { computeAllComboProbs } = require('./engine_alpha_prototype.js');
const v8 = require('./research_tree_rank_model_v8_2026-09-02.js');

const ROOT = path.join(__dirname, '..');
function hashObj(obj) { return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex'); }
function validOdds(r) { return Object.entries(r.oddsMap || {}).filter(([, v]) => parseFloat(v) > 0); }

console.log('=== v8構造診断(2026-09-02): 三連単の順位をどう作ったか ===\n');
console.log('【明記】新モデル学習・特徴量探索・閾値変更なし。凍結済み対象IDから同一の決定論的アルゴリズムで再構築するのみ。\n');

// ===== 凍結入力の検証(同じ対象IDが現在も再現できるか確認) =====
const frozen = JSON.parse(fs.readFileSync(path.join(ROOT, 'logs', 'research_tree_rank_model_v8_frozen_inputs_2026-09-02.json'), 'utf8'));
const all = loadAllRaces();
const usable = all.filter(isUsable);
const byKey = new Map(usable.map(r => [`${r.date}_${r.venue}_${r.racenum}`, r]));

const trainRaces = frozen.trainKeys.map(k => byKey.get(k)).filter(Boolean);
const evalRaces = frozen.evalKeys.map(k => byKey.get(k)).filter(Boolean);
console.log('凍結対象IDの再取得: 学習', trainRaces.length, '/', frozen.trainKeys.length, ' 評価', evalRaces.length, '/', frozen.evalKeys.length);
const trainKeysNow = trainRaces.map(r => `${r.date}_${r.venue}_${r.racenum}`).sort();
const evalKeysNow = evalRaces.map(r => `${r.date}_${r.venue}_${r.racenum}`).sort();
console.log('学習対象IDハッシュ一致:', hashObj(trainKeysNow) === frozen.trainKeysHash, ' 評価対象IDハッシュ一致:', hashObj(evalKeysNow) === frozen.evalKeysHash);
console.log('(注: 艇データ自体〈ST・機力等〉が凍結後に書き換わっていないかまでは検証していない。対象レースの特定〈IDリスト〉のみを検証している)\n');

const qEngine = loadQEngine(path.join(ROOT, 'garon_q_engine.html'));
const plEngine = loadPLEngine(path.join(ROOT, 'sg_narutou.html'));

// ===== 1. 学習対象と120通りへの変換 =====
console.log('=== 1. 学習対象と120通りへの変換 ===');
console.log('正解ラベル: r.chakuju.split("-")[0]と艇番が一致するか(1着かどうかの二値)。3着以内等ではない。実装箇所: research_tree_rank_model_v8_2026-09-02.js main()内 `const winnerBoat = parseInt(r.chakuju.split(\'-\')[0], 10); ... y: b.no === winnerBoat ? 1 : 0`');
console.log('入力特徴量:', FEATURE_NAMES.join(', '), '(tests/lib/alpha-features.js buildFeatures()。コース位置ダミー5+ST/決まり手/連対率/機力/展示の系統別順位5、(7-順位)/6で正規化、情報なしは0.5)');
console.log('特徴量自体はrankBoatsBySystem()〈garon_q_engine.html〉が6艇内の相対順位として計算するため、木への入力時点で既に「レース内の相対比較」が反映されている(木自体は他艇のデータを直接参照しない、艇ごと独立予測)。');

// 三連単スコア生成式のサンプル確認(実装箇所: buildModelRecord() @ research_tree_rank_model_v8_2026-09-02.js)
console.log('\n三連単(i,j,k)の順位スコア生成式: score(i,j,k) = P_win(i) × P(j|i 1着確定) × P(k|i,j 1・2着確定)');
console.log('  P_win: _plWinProbs(scoreMap,1) @ sg_narutou.html:2032-2040(6艇のtreeスコアをsoftmax)');
console.log('  P(2着|1着) と P(3着|1・2着): _plConditionalProbs(scoreMap,head,1) @ sg_narutou.html:2042-2059(headを除いた5艇→4艇で逐次softmax)');
console.log('  結合: computeAllComboProbs() @ tests/engine_alpha_prototype.js:42-55 (p = pHead * cond.p)');
console.log('  木のスコア自体: predictTree(tree, feat[i]) @ research_tree_rank_model_v8_2026-09-02.js(艇ごと独立、他艇を見ない)');

console.log('\n(着順入れ替えの評価差については、本レポート末尾の実測データで示す)');

console.log('\n2着/3着の学習方法: 学習で使った正解ラベルは「1着かどうか」のみ(艇単位プール二値分類)。2着・3着を実際の2着・3着結果から直接学習するステップは無い。2着/3着確率は_plConditionalProbsという固定の数式規則(Plackett-Luce逐次消去)によって、1着スコアと同じ木の出力を繰り返し・残り艇で再正規化して機械的に構成している。**したがって本モデルが実際にデータから学習したのは「1着になりやすさ」のみであり、2着・3着の並び方は学習済みの経験則ではなく、1着スコアに対する数式上の仮定(Plackett-Luceの選択公理)である。**');

// ===== 2. 同点が買い目を決めていないか(保存済み設計図から再構築、再学習ではない) =====
console.log('\n=== 2. 同点が買い目を決めていないか(結果情報は使わない構造診断) ===');
const trainRows = [];
for (const r of trainRaces) {
  let ranks; try { ranks = qEngine.rankBoatsBySystem(r.boats); } catch (e) { continue; }
  const feat = buildFeatures(r.boats, ranks);
  const winnerBoat = parseInt(r.chakuju.split('-')[0], 10);
  r.boats.forEach((b, i) => { trainRows.push({ x: feat[i], y: b.no === winnerBoat ? 1 : 0 }); });
}
const tree = v8.buildTree(trainRows, 0);

function collectLeaves(node, leaves) { if (node.leaf) { leaves.push(node.value); } else { collectLeaves(node.left, leaves); collectLeaves(node.right, leaves); } }
const leafValues = []; collectLeaves(tree, leafValues);
const distinctScores = [...new Set(leafValues.map(v => v.toFixed(10)))];
console.log('実際の葉数 =', leafValues.length, ' 艇スコアの種類数(重複除く) =', distinctScores.length);
console.log('葉の値一覧:', leafValues.map(v => v.toFixed(3)).join(', '));

let tie8_9Count = 0, totalBandRaces = 0;
const reversalDiffs = [];
for (const r of evalRaces) {
  const entries = validOdds(r);
  if (entries.length !== 120) continue;
  let ranks; try { ranks = qEngine.rankBoatsBySystem(r.boats); } catch (e) { continue; }
  const feat = buildFeatures(r.boats, ranks);
  const scoreMap = {};
  r.boats.forEach((b, i) => { scoreMap[String(b.no)] = v8.predictTree(tree, feat[i]); });
  let comboScores; try { comboScores = computeAllComboProbs(plEngine, scoreMap, 1); } catch (e) { continue; }
  const oddsOf = {}; entries.forEach(([val, v]) => { oddsOf[val] = v; });
  const band = comboScores.filter(c => oddsOf[c.val] != null && oddsOf[c.val] >= 50 && oddsOf[c.val] <= 150);
  if (band.length < 8) continue;
  totalBandRaces++;

  const sortFn = (a, b) => (b.p - a.p) || (a.val < b.val ? -1 : a.val > b.val ? 1 : 0);
  const sortedNormal = band.slice().sort(sortFn);
  // 8点目・9点目のスコア(p値)が完全一致するか(浮動小数点誤差を考慮し許容差1e-12)
  if (band.length >= 9) {
    const p8 = sortedNormal[7].p, p9 = sortedNormal[8].p;
    if (Math.abs(p8 - p9) < 1e-12) tie8_9Count++;
  }

  // 列挙順を逆にしてソートし直した場合、選択8点(集合として)が変わるか
  const reversedInput = band.slice().reverse();
  const sortedReversed = reversedInput.slice().sort(sortFn);
  const setNormal = new Set(sortedNormal.slice(0, 8).map(c => c.val));
  const setReversed = new Set(sortedReversed.slice(0, 8).map(c => c.val));
  const same = setNormal.size === setReversed.size && [...setNormal].every(v => setReversed.has(v));
  if (!same) reversalDiffs.push({ date: r.date, venue: r.venue, racenum: r.racenum });
}
console.log('\n帯内候補8点以上ある評価対象レース =', totalBandRaces);
console.log('帯内候補が9点以上あり、8点目/9点目のスコアが完全同点のレース数 =', tie8_9Count, '(', totalBandRaces ? (tie8_9Count / totalBandRaces * 100).toFixed(1) : 0, '%)');
console.log('同点時の選択規則: score降順、同点は買い目の文字列(例"1-2-3")の昇順という結果と無関係な固定規則。実装箇所: buildModelRecord()内 `(b.p - a.p) || (a.val < b.val ? -1 : a.val > b.val ? 1 : 0)`');
console.log('候補列挙順だけを逆にした場合に選択8点(集合)が変わるレース数 =', reversalDiffs.length, '/', totalBandRaces);
if (reversalDiffs.length) console.log('  該当例:', reversalDiffs.slice(0, 5).map(r => `${r.date}_${r.venue}_${r.racenum}`).join(', '));

// 着順入れ替えで評価が変わるかの実測(同点でない典型例で確認)
console.log('\n=== 着順入れ替えでスコアが変わるかの実測確認 ===');
{
  const sample = evalRaces.find(r => { const e = validOdds(r); return e.length === 120; });
  let ranks = qEngine.rankBoatsBySystem(sample.boats);
  let feat = buildFeatures(sample.boats, ranks);
  let scoreMap = {};
  sample.boats.forEach((b, i) => { scoreMap[String(b.no)] = v8.predictTree(tree, feat[i]); });
  const combos = computeAllComboProbs(plEngine, scoreMap, 1);
  const c123 = combos.find(c => c.val === '1-2-3');
  const c213 = combos.find(c => c.val === '2-1-3');
  const c132 = combos.find(c => c.val === '1-3-2');
  console.log(`サンプルレース(${sample.date}_${sample.venue}_${sample.racenum}): score(1-2-3)=${c123 ? c123.p.toFixed(6) : 'N/A'} score(2-1-3)=${c213 ? c213.p.toFixed(6) : 'N/A'} score(1-3-2)=${c132 ? c132.p.toFixed(6) : 'N/A'}`);
  console.log('  同じ3艇でも着順(1-2-3 vs 2-1-3 vs 1-3-2)を入れ替えるとスコアが変わる:', !(c123 && c213 && Math.abs(c123.p - c213.p) < 1e-12));
}

const manifest = {
  generatedAt: new Date().toISOString(),
  scopeNote: '新モデル学習・特徴量探索・閾値変更なし。凍結済み対象IDから同一の決定論的アルゴリズムで木を再構築(乱数不使用のため常に同一結果)。結果情報は選択規則の診断に一切使っていない。',
  frozenInputVerification: { trainKeysHashMatch: hashObj(trainKeysNow) === frozen.trainKeysHash, evalKeysHashMatch: hashObj(evalKeysNow) === frozen.evalKeysHash },
  leafCount: leafValues.length, distinctScoreCount: distinctScores.length, leafValues: leafValues.map(v => Number(v.toFixed(6))),
  tie8_9: { totalBandRaces, tieCount: tie8_9Count },
  reversalTest: { totalBandRaces, differCount: reversalDiffs.length },
};
fs.writeFileSync(path.join(ROOT, 'logs', 'research_v8_structure_audit_2026-09-02.json'), JSON.stringify(manifest, null, 2));
console.log('\n結果を logs/research_v8_structure_audit_2026-09-02.json へ保存しました。');
