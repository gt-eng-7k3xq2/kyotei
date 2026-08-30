'use strict';
// 回帰テスト: 鳴門1R(2026-08-27,gap8参戦)・徳山1R(2026-08-27,gap1参戦・境界近傍)・
// 三国1R(2026-08-27,gap-5見送り)の実データ(daikibo_archiveより抽出)を使い、
// garon_q_engine.htmlのgenerateQBets()が「以前実行した時と同じ結果」を返すことを確認する
// (characterization test)。tests/score_engine.regression.test.jsと同じ方式・同じ思想。
//
// 既存のtests/fixtures/(sg_narutou用)はwakuStatsを含まないためQエンジンでは使えず、
// tests/fixtures/q_engine/ に新規のfixtureを用意した(2026-08-30、wakuStats/oddsMap完備の
// 2026-08-27アーカイブから抽出)。参戦2件・見送り1件を含め、gap<0見送りルールの両分岐を
// 回帰対象にしている。
//
// テスト対象外: parseData()
//   score_engine.regression.test.jsと同じ理由(daikibo_archiveは構造化済みJSONのみ保存、
//   生のBM抽出テキストは残っていない)。
//
// 「正しさ」の意味:
//   ここでの golden 値は「外部の正解データと突き合わせた正しさ」ではなく、
//   「このテストを最初に実行した時点でのgaron_q_engine.htmlの出力」を凍結したもの。
//   ロジックを意図的に変更した後は `node tests/q_engine.regression.test.js --update-golden`
//   で golden を更新し、Q_ENGINE_VERSIONもインクリメントすること(CLAUDE.md参照)。
//
// 使い方:
//   node tests/q_engine.regression.test.js              … 既存goldenと比較
//   node tests/q_engine.regression.test.js --update-golden … golden値を再記録

const fs = require('fs');
const path = require('path');
const { loadQEngine } = require('./lib/extract-q-engine');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'garon_q_engine.html');
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'q_engine');
const GOLDEN_DIR = path.join(__dirname, 'golden', 'q_engine');
const UPDATE_GOLDEN = process.argv.includes('--update-golden');

const FIXTURES = [
  'naruto_1r_2026-08-27.json',
  'tokuyama_1r_2026-08-27.json',
  'mikuni_1r_2026-08-27.json',
];

// garon_q_engine.html の runYosoQ() (2026-08-25〜、行2870付近)を、DOM表示部分を除いて再現する。
// runYosoQ()自体はgenerateQBets(d.boats, d.oddsMap)を直接呼ぶだけなので、sg_narutou版の
// runPipeline()のような追加のグルーコードは不要。
function runPipeline(engine, d) {
  const result = engine.generateQBets(d.boats, d.oddsMap);
  return {
    gap: round1(result.gap),
    judge: result.judge,
    axes: result.axes.map(a => ({ boat: a.boat, weight: round1(a.weight), narrow: a.narrow, reason: a.reason })),
    formations: result.formations.map(f => ({ axis: f.axis, weight: round1(f.weight), type: f.type, points: f.points })),
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
  console.log(`garon_q_engine.html からQエンジン関数を抽出中... (${HTML_PATH})`);
  const engine = loadQEngine(HTML_PATH);
  console.log(`Q_ENGINE_VERSION = ${engine.Q_ENGINE_VERSION}`);

  fs.mkdirSync(GOLDEN_DIR, { recursive: true });

  let failCount = 0;
  let recordedCount = 0;

  for (const fixtureName of FIXTURES) {
    const fixturePath = path.join(FIXTURES_DIR, fixtureName);
    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const d = { boats: fixture.boats, oddsMap: fixture.oddsMap };

    const result = runPipeline(engine, d);
    const resultWithMeta = {
      _qEngineVersion: engine.Q_ENGINE_VERSION,
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
      console.log(`  gap=${result.gap} judge=${result.judge.text}`);
      const totalPoints = result.formations.reduce((s, f) => s + f.points.length, 0);
      console.log(`  買い目(${totalPoints}点/${result.formations.length}軸): ${result.formations.map(f => f.points.join(',')).join(' | ')}`);
      recordedCount++;
      continue;
    }

    const golden = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
    const diffs = deepDiff(golden, resultWithMeta);
    const meaningfulDiffs = diffs.filter(d => !d.startsWith('_'));

    if (meaningfulDiffs.length === 0) {
      console.log(`\n[PASS] ${fixtureName} (${fixture._fixtureLabel})`);
      if (golden._qEngineVersion !== engine.Q_ENGINE_VERSION) {
        console.log(`  ⚠️ Q_ENGINE_VERSIONがgolden記録時(${golden._qEngineVersion})と異なる(現在${engine.Q_ENGINE_VERSION})。意図した変更なら --update-golden で再記録すること。`);
      }
    } else {
      failCount++;
      console.log(`\n[FAIL] ${fixtureName} (${fixture._fixtureLabel})`);
      meaningfulDiffs.forEach(d => console.log('  ' + d));
    }
  }

  console.log('\n' + '='.repeat(60));
  if (recordedCount > 0) {
    console.log(`${recordedCount}件のgolden値を新規記録しました。tests/golden/q_engine/ をコミットしてください。`);
  }
  if (failCount > 0) {
    console.log(`結果: ${failCount}件のFAIL`);
    process.exit(1);
  } else if (recordedCount === 0) {
    console.log(`結果: 全${FIXTURES.length}件PASS`);
  }
}

main();
