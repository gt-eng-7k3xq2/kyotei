'use strict';
// 参入判定(直前最終チェック)の診断ツール。
// sg_narutou.htmlのrunYoso()内にある「参戦/見送り」判定ロジックをその場で抜き出して実行し、
// daikibo_archiveの実データ(2026-07-01〜08-03、33日分)で
//   ① 全レース対象
//   ② 参入基準を満たしたレースのみ
//   ③ 見送りと判定されたレースのみ(理由別内訳つき)
// の的中率・ROIを比較する。「参入基準を満たす」ことが実際に良い結果の担保になっているかを検証する。
//
// ロジックは一切変更しない(診断専用)。ROIは既存コード(MODE_ROI_BASE等のコメント)と同じ
// 「1点100円均等」の慣習に合わせて計算する(実際の3,000円加重配分ではない。これは別課題)。
//
// 使い方: node tests/entry_criteria_diagnosis.js

const fs = require('fs');
const path = require('path');
const os = require('os');
const { extractFunctionSource, extractConstSource, extractScoreEngineVersion } = require('./lib/extract-score-engine');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'sg_narutou.html');

const FUNCTION_NAMES = [
  'calcAreScore', 'calcNigeRate', 'calcAreIndex', 'judgeMode',
  'decideProbabilisticPts', '_plWinProbs', '_plConditionalProbs', '_selectWithPairCap',
  'buildBetsProbabilistic', 'calcStdev', 'estimateROI', 'estimateHitRate',
  'stdevROIDelta', 'stdevHitDelta',
];
const CONST_NAMES = [
  'GOOD_VENUES', 'VENUE_ROI', 'MODE_ROI_BASE', 'VENUE_HITRATE', 'MODE_HITRATE_BASE',
  'OVERALL_AVG_ROI', 'OVERALL_AVG_HITRATE',
];

function loadEngine(htmlPath) {
  const source = fs.readFileSync(htmlPath, 'utf8');
  const version = extractScoreEngineVersion(source);
  const funcSources = FUNCTION_NAMES.map(name => extractFunctionSource(source, name));
  const constSources = CONST_NAMES.map(name => extractConstSource(source, name));

  const moduleSource = [
    "'use strict';",
    "let selectedRaceType = 'ippan';",
    ...constSources.map((s, i) => `const ${CONST_NAMES[i]} = ${s.replace(/^const\s+\w+\s*=\s*/, '')}`),
    ...funcSources,
    'module.exports = {',
    '  setRaceType(v) { selectedRaceType = v; },',
    ...FUNCTION_NAMES.map(name => `  ${name},`),
    '};',
  ].join('\n\n');

  const tmpDir = path.join(os.tmpdir(), 'garon-entry-criteria-extract');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `entry_criteria.${Date.now()}.js`);
  fs.writeFileSync(tmpFile, moduleSource);
  const engine = require(tmpFile);
  engine.version = version;
  return engine;
}

// 依頼範囲(2026-07-01〜08-03)に明示的に限定する。以降の日付はPlaywright収集分で
// 現時点ではresulted未入力(=集計には混ざらない)だが、将来結果が入力された場合に
// 意図せず範囲外データが混入しないよう、日付でハードに絞る。
const ARCHIVE_DATE_MIN = '2026-07-01';
const ARCHIVE_DATE_MAX = '2026-08-03';

function listArchiveFiles() {
  return fs.readdirSync(ROOT)
    .filter(f => /^daikibo_archive_\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .filter(f => {
      const d = f.match(/(\d{4}-\d{2}-\d{2})/)[1];
      return d >= ARCHIVE_DATE_MIN && d <= ARCHIVE_DATE_MAX;
    })
    .sort();
}

function loadRaces(file) {
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  return data.filter(e => e.resulted && e.chakuju && Array.isArray(e.boats) && e.boats.length === 6);
}

function parsePayout(payoutStr) {
  if (!payoutStr) return 0;
  const n = parseInt(String(payoutStr).replace(/[^\d]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

const MARKS = ['◎', '○', '▲', '△', '▽', '×'];

// runYoso()(sg_narutou.html:2260〜2340付近)の参入判定ロジックを再現する。
function evaluateRace(engine, entry) {
  const d = { boats: entry.boats, venue: entry.venue, raceNum: entry.racenum };
  const areScores = engine.calcAreScore(d);

  // sg_narutou.html:2280-2286 相当(1号艇のgap<9昇格)
  const b1RankBeforeFix = areScores.findIndex(s => String(s.no) === '1');
  if (b1RankBeforeFix === 1) {
    const promoGap = areScores[0].raw - areScores[1].raw;
    if (promoGap < 9) { const tmp = areScores[0]; areScores[0] = areScores[1]; areScores[1] = tmp; }
  }

  const { areIndex, nigeRate } = engine.calcAreIndex(d);
  let mode = engine.judgeMode(areIndex, nigeRate);

  const boat1Rank = areScores.findIndex(s => String(s.no) === '1');
  if (nigeRate < 30 && boat1Rank > 0 && boat1Rank < 5) mode = 'nigenashi';

  const isAxisBoat1 = String(areScores[0].no) === '1';
  const autoNige = (isAxisBoat1 && nigeRate >= 85) ? 'high' : (isAxisBoat1 && nigeRate >= 50) ? 'mid' : 'low';
  const gap = areScores[0].raw - areScores[1].raw;
  const isNarrowGap = (mode === 'normal' && autoNige !== 'high' && gap < 10);

  const stdev = engine.calcStdev(areScores);
  const venue = entry.venue || '不明';
  const estRoi = engine.estimateROI(mode, venue, stdev);

  let judge;
  if (isNarrowGap) judge = 'skip_narrowgap';
  else if (estRoi >= 74) judge = 'enter';
  else judge = 'skip_lowroi';

  const pts = engine.decideProbabilisticPts([{ score: areScores[0].raw }, { score: areScores[1].raw }]);
  const ranking = areScores.map((s, i) => ({ rank: i + 1, boat: parseInt(s.no, 10), mark: MARKS[i] || '×', score: s.raw }));
  const bets = engine.buildBetsProbabilistic(ranking, pts);

  const hit = bets.some(b => b.val === entry.chakuju);
  const stake = bets.length * 100;
  const payout = hit ? parsePayout(entry.payout) : 0;

  return { judge, hit, stake, payout, mode, gap: Math.round(gap * 10) / 10, estRoi: Math.round(estRoi * 10) / 10 };
}

function newBucket() { return { n: 0, hits: 0, stake: 0, payout: 0 }; }
function addTo(bucket, r) { bucket.n++; if (r.hit) bucket.hits++; bucket.stake += r.stake; bucket.payout += r.payout; }
function summarize(b) {
  return {
    n: b.n,
    hitRate: b.n ? (b.hits / b.n * 100) : null,
    roi: b.stake ? (b.payout / b.stake * 100) : null,
    hits: b.hits, stake: b.stake, payout: b.payout,
  };
}
function proportionDiffZ(x1, n1, x2, n2) {
  if (!n1 || !n2) return null;
  const p1 = x1 / n1, p2 = x2 / n2;
  const pPool = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pPool * (1 - pPool) * (1 / n1 + 1 / n2));
  if (se === 0) return null;
  return (p1 - p2) / se;
}
function fmt(s) {
  return `n=${s.n}\t的中率=${s.hitRate !== null ? s.hitRate.toFixed(1) + '%' : 'N/A'}\tROI=${s.roi !== null ? s.roi.toFixed(1) + '%' : 'N/A'}\t(的中${s.hits}件, 投資¥${s.stake.toLocaleString()}, 回収¥${s.payout.toLocaleString()})`;
}

function main() {
  console.log(`sg_narutou.html から参入判定ロジックを抽出中... (${HTML_PATH})`);
  const engine = loadEngine(HTML_PATH);
  console.log(`SCORE_ENGINE_VERSION = ${engine.version}`);
  engine.setRaceType('ippan');

  console.log('\n' + '='.repeat(70));
  console.log('1. 参入判定の物差し(現状のsg_narutou.htmlのロジック)');
  console.log('='.repeat(70));
  console.log(`
[判定の流れ]
  areScores = calcAreScore(d)                      … 各艇の生スコア(降順)
  areIndex, nigeRate = calcAreIndex(d)
  mode = judgeMode(areIndex, nigeRate)              … normal / are_weak / are_strong
  nigeRate<30 && ◎が2〜5位評価なら mode='nigenashi'
  gap = ◎(1位)のraw - ○(2位)のraw
  autoNige = ◎が1号艇 && nigeRate>=85 ? 'high' : (同&&nigeRate>=50 ? 'mid' : 'low')
  isNarrowGap = (mode==='normal' && autoNige!=='high' && gap<10)
  stdev = calcStdev(areScores)                      … 全艇スコアの標準偏差(団子度)
  estRoi = estimateROI(mode, venue, stdev)
         = MODE_ROI_BASE[mode] + (VENUE_ROI[venue]-77.4)*0.3 + stdevROIDelta(stdev)
           stdevROIDelta: <20.3→+9.8 / <24.5→-0.8 / <27.9→-3.3 / <31.9→-4.2 / それ以上→-1.9

  [最終判定]
    isNarrowGap === true                → ✗見送り(僅差レース gap<10。理由問わず最優先)
    else estRoi >= 74                   → ◎参戦
    else                                 → ✗見送り(推定ROI74%未満)

  ※ GOOD_VENUES(優良会場バッジ)・団子度バッジ(🎯拮抗/💥1艇突出/△中間帯)・
    getEngineConfidence(🔥本線/◎通常等)は全て表示専用の補足情報で、上記の
    参戦/見送り判定そのものには使われていない(venueは既にestRoi計算に織り込み済み)。
`);

  const files = listArchiveFiles();
  const dates = files.map(f => f.match(/(\d{4}-\d{2}-\d{2})/)[1]);
  console.log(`対象データ: ${files.length}日分 (${dates[0]} 〜 ${dates[dates.length - 1]})`);

  const bAll = newBucket(), bEnter = newBucket(), bSkip = newBucket();
  const bSkipNarrow = newBucket(), bSkipLowRoi = newBucket();
  let nRaces = 0;

  for (const file of files) {
    for (const entry of loadRaces(file)) {
      const parts = String(entry.chakuju).split('-');
      if (parts.length !== 3) continue;
      let r;
      try { r = evaluateRace(engine, entry); } catch (e) { continue; }
      nRaces++;
      addTo(bAll, r);
      if (r.judge === 'enter') addTo(bEnter, r);
      else {
        addTo(bSkip, r);
        if (r.judge === 'skip_narrowgap') addTo(bSkipNarrow, r);
        else addTo(bSkipLowRoi, r);
      }
    }
  }

  console.log('\n' + '='.repeat(70));
  console.log('2. 的中率・ROI比較(1点100円換算。実際の加重配分ROIとは別集計)');
  console.log('='.repeat(70));
  const sAll = summarize(bAll), sEnter = summarize(bEnter), sSkip = summarize(bSkip);
  const sSkipNarrow = summarize(bSkipNarrow), sSkipLowRoi = summarize(bSkipLowRoi);
  console.log(`全レース対象         : ${fmt(sAll)}`);
  console.log(`参入(◎参戦)のみ      : ${fmt(sEnter)}`);
  console.log(`見送り全体           : ${fmt(sSkip)}`);
  console.log(`  内訳: 僅差見送り    : ${fmt(sSkipNarrow)}`);
  console.log(`  内訳: 推定ROI不足   : ${fmt(sSkipLowRoi)}`);

  console.log('\n' + '='.repeat(70));
  console.log('3. 参入基準は実際に機能しているか(参入 vs 見送りの差の検定)');
  console.log('='.repeat(70));
  const zHit = proportionDiffZ(bEnter.hits, bEnter.n, bSkip.hits, bSkip.n);
  console.log(`的中率の差: 参入${sEnter.hitRate.toFixed(1)}% − 見送り${sSkip.hitRate.toFixed(1)}% = ${(sEnter.hitRate - sSkip.hitRate).toFixed(1)}pt`);
  if (zHit !== null) console.log(`  2標本比率検定: z=${zHit.toFixed(2)} (|z|>=1.96で有意水準5%)`);
  console.log(`ROIの差: 参入${sEnter.roi.toFixed(1)}% − 見送り${sSkip.roi.toFixed(1)}% = ${(sEnter.roi - sSkip.roi).toFixed(1)}pt`);
  console.log(`  (ROIは比率の比のため簡易な検定は行っていない。n・投資額とあわせて実額で判断すること)`);

  console.log('\n判定:');
  if (sSkip.roi > sEnter.roi) {
    console.log(`⚠️ 見送りレース(ROI${sSkip.roi.toFixed(1)}%)の方が参入レース(ROI${sEnter.roi.toFixed(1)}%)よりROIが高い。`);
    console.log('  参入基準が高ROIレースを弾いてしまっている可能性がある。要詳細調査。');
  } else {
    console.log(`✅ 参入レース(ROI${sEnter.roi.toFixed(1)}%)の方が見送りレース(ROI${sSkip.roi.toFixed(1)}%)よりROIが高く、基準の方向性自体は妥当。`);
  }
  if (zHit !== null && Math.abs(zHit) < 1.96) {
    console.log(`⚠️ ただし的中率の差は統計的に有意ではない(|z|=${Math.abs(zHit).toFixed(2)}<1.96)。n=${sEnter.n}/${sSkip.n}で確認すること。`);
  }
}

main();
