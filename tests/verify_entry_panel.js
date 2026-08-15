'use strict';
// ブラウザを開かずに、更新後のsg_narutou.html(SCORE_ENGINE_VERSION=6)の
// 参入判定パネル相当の計算をdaikibo_archiveの実データに通して検証するツール。
// kyoteibiyori.comがブロック中でBM実機テストができない時の代替確認用。
//
// 表示する項目: 合成オッズ / 最終推定ROI(旧版・新版) / ◎参戦・✗見送りの判定 / 僅差見送りの実例
//
// 使い方: node tests/verify_entry_panel.js [対象ファイル名... 省略時はdaikibo_archive_2026-08-04.json]

const fs = require('fs');
const path = require('path');
const os = require('os');
const { extractFunctionSource, extractConstSource, extractScoreEngineVersion } = require('./lib/extract-score-engine');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'sg_narutou.html');

const FUNCTION_NAMES = [
  'calcAreScore', 'calcNigeRate', 'calcAreIndex', 'judgeMode',
  'decideProbabilisticPts', '_plWinProbs', '_plConditionalProbs', '_selectWithPairCap',
  'buildBetsProbabilistic', 'calcStdev', 'estimateROI', 'stdevROIDelta',
  'goseiOddsDelta', 'calcGoseiOdds',
];
const CONST_NAMES = ['VENUE_ROI', 'MODE_ROI_BASE', 'OVERALL_AVG_ROI'];

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
  const tmpDir = path.join(os.tmpdir(), 'garon-verify-entry-panel');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `verify_entry_panel.${Date.now()}.js`);
  fs.writeFileSync(tmpFile, moduleSource);
  const engine = require(tmpFile);
  engine.version = version;
  return engine;
}

const MARKS = ['◎', '○', '▲', '△', '▽', '×'];

// sg_narutou.html:runYoso()の参入判定ブロック(2026-08-15更新版)を再現する。
// 結果(chakuju/payout)は不要(参入判定はレース前に行う判断のため)。
function evaluatePanel(engine, entry) {
  const d = { boats: entry.boats, venue: entry.venue, raceNum: entry.racenum };
  const areScores = engine.calcAreScore(d);
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

  // 買い目を先読みして合成オッズを計算(sg_narutou.html:2339以降と同じ手順)
  const pts = engine.decideProbabilisticPts([{ score: areScores[0].raw }, { score: areScores[1].raw }]);
  const ranking = areScores.map((s, i) => ({ rank: i + 1, boat: parseInt(s.no, 10), mark: MARKS[i] || '×', score: s.raw }));
  const bets = engine.buildBetsProbabilistic(ranking, pts);
  const goseiOdds = parseFloat(engine.calcGoseiOdds(bets.map(b => b.val), entry.oddsMap || {})) || null;

  const estRoiOld = engine.estimateROI(mode, venue, stdev);              // 3引数=旧版(合成オッズ補正なし)
  const estRoiNew = engine.estimateROI(mode, venue, stdev, goseiOdds);   // 4引数=新版

  const judgeOld = isNarrowGap ? '✗見送り（僅差レース gap<10）' : (estRoiOld >= 74 ? '◎参戦' : '✗見送り');
  const judgeNew = isNarrowGap ? '✗見送り（僅差レース gap<10）' : (estRoiNew >= 82 ? '◎参戦' : '✗見送り');

  return { venue, racenum: entry.racenum, mode, gap: Math.round(gap * 10) / 10, isNarrowGap, goseiOdds, estRoiOld, estRoiNew, judgeOld, judgeNew, pts, betsN: bets.length };
}

function fmtRoi(v) { return v === null || v === undefined ? 'N/A' : v.toFixed(1) + '%'; }
function fmtGosei(v) { return v ? v.toFixed(2) + '倍' : '取得不可'; }

function main() {
  const targetFiles = process.argv.slice(2).length ? process.argv.slice(2) : ['daikibo_archive_2026-08-04.json'];
  console.log(`sg_narutou.html から参入判定ロジックを抽出中... (${HTML_PATH})`);
  const engine = loadEngine(HTML_PATH);
  console.log(`SCORE_ENGINE_VERSION = ${engine.version}\n`);
  engine.setRaceType('ippan');

  let allResults = [];
  for (const file of targetFiles) {
    const filePath = path.join(ROOT, file);
    if (!fs.existsSync(filePath)) { console.log(`⚠️ ファイルが見つかりません: ${file}`); continue; }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const entry of data) {
      if (!Array.isArray(entry.boats) || entry.boats.length !== 6) continue;
      if (!entry.oddsMap || Object.keys(entry.oddsMap).length < 100) continue; // オッズがほぼ揃っている物だけ対象
      try {
        allResults.push({ file, ...evaluatePanel(engine, entry) });
      } catch (e) { /* skip */ }
    }
  }
  console.log(`計算成功: ${allResults.length}レース(オッズがほぼ揃っている物のみ対象)\n`);

  // 表示用に多様な例を選ぶ: 僅差見送りの実例を1件、◎参戦の例、✗見送り(推定ROI不足)の例、
  // 残りは先頭から追加して合計3〜5件になるようにする
  const narrowExample = allResults.find(r => r.isNarrowGap);
  const enterExample = allResults.find(r => r.judgeNew === '◎参戦' && !r.isNarrowGap);
  const skipRoiExample = allResults.find(r => !r.isNarrowGap && r.judgeNew !== '◎参戦');

  const picked = [];
  const pushUnique = (r) => { if (r && !picked.includes(r)) picked.push(r); };
  pushUnique(narrowExample);
  pushUnique(enterExample);
  pushUnique(skipRoiExample);
  for (const r of allResults) { if (picked.length >= 5) break; pushUnique(r); }

  console.log('='.repeat(90));
  console.log('参入判定パネル 検証結果(実データ)');
  console.log('='.repeat(90));
  picked.forEach((r, i) => {
    console.log(`\n[${i + 1}] ${r.venue} ${r.racenum}R  (${r.file})`);
    console.log(`  mode=${r.mode}  gap=${r.gap}  isNarrowGap=${r.isNarrowGap}`);
    console.log(`  合成オッズ: ${fmtGosei(r.goseiOdds)}  (点数${r.pts}点、実際の買い目${r.betsN}点)`);
    console.log(`  推定ROI  旧版(閾値74): ${fmtRoi(r.estRoiOld)}  →  判定: ${r.judgeOld}`);
    console.log(`  推定ROI  新版(閾値82): ${fmtRoi(r.estRoiNew)}  →  判定: ${r.judgeNew}`);
    if (r.isNarrowGap) console.log(`  ★ 僅差見送りの実例: gap=${r.gap}<10のため、estRoiの値(${fmtRoi(r.estRoiNew)})に関わらず見送りと判定されている`);
    if (r.judgeOld !== r.judgeNew) console.log(`  ⚠️ 旧版と新版で判定が変わった例(合成オッズ補正・閾値変更の影響)`);
  });

  console.log('\n' + '='.repeat(90));
  console.log(`旧版→新版で判定が変わったレース数: ${allResults.filter(r => r.judgeOld !== r.judgeNew).length} / ${allResults.length}`);
}

main();
