'use strict';
// 回帰テスト: 三国9R(2026-07-27)・平和島12R(2026-07-20)・平和島12R(2026-07-02)の
// 実データ(daikibo_archiveより抽出)を使い、sg_narutou.htmlのスコア計算〜買い目生成が
// 「以前実行した時と同じ結果」を返すことを確認する(characterization test)。
//
// テスト対象外: parseData()
//   daikibo_archive.htmlが保存しているのは貼り付け生テキストではなく、parseData()実行後の
//   構造化済みJSON(boats配列)。生のBM抽出テキストはアーカイブに残っていないため、
//   「生テキスト→parseData()→構造化データ」の変換自体はこのテストでは検証できない。
//   検証できるのは「構造化データ→calcAreScore/calcAreIndex/judgeMode/buildBetsProbabilistic
//   →買い目」の部分のみ(daikibo_replay.htmlが実際にやっているのと同じ範囲)。
//
// 「正しさ」の意味:
//   ここでの golden 値は「外部の正解データと突き合わせた正しさ」ではなく、
//   「このテストを最初に実行した時点でのsg_narutou.htmlの出力」を凍結したもの。
//   ロジックを意図的に変更した後は `node tests/score_engine.regression.test.js --update-golden`
//   で golden を更新し、SCORE_ENGINE_VERSIONもインクリメントすること(CLAUDE.md参照)。
//
// 使い方:
//   node tests/score_engine.regression.test.js              … 既存goldenと比較
//   node tests/score_engine.regression.test.js --update-golden … golden値を再記録

const fs = require('fs');
const path = require('path');
const { loadScoreEngine } = require('./lib/extract-score-engine');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'sg_narutou.html');
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const GOLDEN_DIR = path.join(__dirname, 'golden');
const UPDATE_GOLDEN = process.argv.includes('--update-golden');

const FIXTURES = [
  'mikuni_9r_2026-07-27.json',
  'heiwajima_12r_2026-07-20.json',
  'heiwajima_12r_2026-07-02.json',
];

const MARKS = ['◎', '○', '▲', '△', '▽', '×'];

// sg_narutou.html の runYoso() (行2270〜2414付近)を、DOM表示部分を除いて再現する。
// ロジックを変更した場合は、この関数もあわせて見直すこと。
function runPipeline(engine, d) {
  const areScores = engine.calcAreScore(d);

  // sg_narutou.html:2280-2286 「1号艇がスコア2位の時、gap<9なら軸に昇格」
  const b1RankBeforeFix = areScores.findIndex(s => String(s.no) === '1');
  if (b1RankBeforeFix === 1) {
    const promoGap = areScores[0].raw - areScores[1].raw;
    if (promoGap < 9) {
      const tmp = areScores[0];
      areScores[0] = areScores[1];
      areScores[1] = tmp;
    }
  }

  // sg_narutou.html:2289-2290
  const { areIndex, nigeRate } = engine.calcAreIndex(d);
  let mode = engine.judgeMode(areIndex, nigeRate);

  // sg_narutou.html:2298-2301 「1号艇の逃げ率<30%かつ2〜5位評価なら逃げなしモード」
  const boat1Rank = areScores.findIndex(s => String(s.no) === '1');
  if (nigeRate < 30 && boat1Rank > 0 && boat1Rank < 5) {
    mode = 'nigenashi';
  }

  // sg_narutou.html:2310-2313 「軸(1位評価)が1号艇の時、逃げ率でnigeMode表示を決める」
  const isAxisBoat1 = String(areScores[0].no) === '1';
  const autoNige = (isAxisBoat1 && nigeRate >= 85) ? 'high' : (isAxisBoat1 && nigeRate >= 50) ? 'mid' : 'low';

  // sg_narutou.html:2398-2401 「通常モードの内訳を2艇頭/逃げ固定へ昇格表示」
  if (mode === 'normal') {
    if (autoNige === 'mid') mode = 'nito';
    else if (autoNige === 'high') mode = 'nigekotei';
  }

  // sg_narutou.html:2365 自動点数決定(gapベース)
  const autoPts = engine.decideProbabilisticPts([{ score: areScores[0].raw }, { score: areScores[1].raw }]);

  // sg_narutou.html:2413-2414 ランキング化 → 買い目生成(sg_narutou.html:967)
  const ranking = areScores.map((s, i) => ({ rank: i + 1, boat: parseInt(s.no, 10), mark: MARKS[i] || '×', score: s.raw }));
  const bets = engine.buildBetsProbabilistic(ranking, autoPts);

  return {
    areIndex,
    nigeRate: round1(nigeRate),
    mode,
    autoPts,
    ranking: ranking.map(r => ({ rank: r.rank, boat: r.boat, mark: r.mark, score: round1(r.score) })),
    bets: bets.map(b => ({ val: b.val, type: b.type })),
  };
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function deepDiff(expected, actual, pathPrefix = '') {
  const diffs = [];
  if (typeof expected !== typeof actual) {
    diffs.push(`${pathPrefix}: 型が違う (expected ${typeof expected}, actual ${typeof actual})`);
    return diffs;
  }
  if (expected === null || actual === null || typeof expected !== 'object') {
    if (expected !== actual) diffs.push(`${pathPrefix}: expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
    return diffs;
  }
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const k of keys) {
    diffs.push(...deepDiff(expected[k], actual[k], pathPrefix ? `${pathPrefix}.${k}` : k));
  }
  return diffs;
}

function main() {
  console.log(`sg_narutou.html からスコア計算関数を抽出中... (${HTML_PATH})`);
  const engine = loadScoreEngine(HTML_PATH);
  console.log(`SCORE_ENGINE_VERSION = ${engine.version}`);
  engine.setRaceType('ippan'); // アーカイブにレース種別が保存されていないため既定値(一般戦)を使用

  fs.mkdirSync(GOLDEN_DIR, { recursive: true });

  let failCount = 0;
  let recordedCount = 0;

  for (const fixtureName of FIXTURES) {
    const fixturePath = path.join(FIXTURES_DIR, fixtureName);
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const d = { boats: fixture.boats, venue: fixture.venue, raceNum: fixture.racenum };

    const result = runPipeline(engine, d);
    const resultWithMeta = {
      _scoreEngineVersion: engine.version,
      _fixture: fixtureName,
      _label: fixture._fixtureLabel,
      _actualResult: { chakuju: fixture.chakuju, payout: fixture.payout },
      ...result,
    };

    const goldenPath = path.join(GOLDEN_DIR, fixtureName.replace('.json', '.golden.json'));
    const goldenExists = fs.existsSync(goldenPath);

    if (UPDATE_GOLDEN || !goldenExists) {
      fs.writeFileSync(goldenPath, JSON.stringify(resultWithMeta, null, 2) + '\n');
      console.log(`\n[RECORDED] ${fixtureName} (${fixture._fixtureLabel})`);
      console.log(`  実際の結果: ${fixture.chakuju} (配当${fixture.payout})`);
      console.log(`  モード=${result.mode} 荒れ指数=${result.areIndex} 逃げ率=${result.nigeRate}% 点数=${result.autoPts}`);
      console.log(`  ◎=${result.ranking[0].boat}号艇 ○=${result.ranking[1].boat}号艇`);
      console.log(`  買い目(${result.bets.length}点): ${result.bets.map(b => b.val).join(', ')}`);
      recordedCount++;
      continue;
    }

    const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
    const diffs = deepDiff(golden, resultWithMeta);
    // メタ情報(バージョン・fixture名・実際の結果参考値)は比較対象から除く
    const meaningfulDiffs = diffs.filter(d => !d.startsWith('_'));

    if (meaningfulDiffs.length === 0) {
      console.log(`\n[PASS] ${fixtureName} (${fixture._fixtureLabel})`);
      if (golden._scoreEngineVersion !== engine.version) {
        console.log(`  ⚠️ SCORE_ENGINE_VERSIONがgolden記録時(${golden._scoreEngineVersion})と異なる(現在${engine.version})。意図した変更なら --update-golden で再記録すること。`);
      }
    } else {
      failCount++;
      console.log(`\n[FAIL] ${fixtureName} (${fixture._fixtureLabel})`);
      meaningfulDiffs.forEach(d => console.log('  ' + d));
    }
  }

  console.log('\n' + '='.repeat(60));
  if (recordedCount > 0) {
    console.log(`${recordedCount}件のgolden値を新規記録しました。tests/golden/ をコミットしてください。`);
  }
  if (failCount > 0) {
    console.log(`結果: ${failCount}件のFAIL`);
    process.exit(1);
  } else if (recordedCount === 0) {
    console.log(`結果: 全${FIXTURES.length}件PASS`);
  }
}

main();
