'use strict';
// sg_narutou.html から、スコア計算・買い目生成に使う「純粋関数」だけを実体スクリプトから
// 直接抜き出して実行可能なモジュールにする。
//
// なぜコピペで複製しないか:
//   CLAUDE.md に書いた通り、このプロジェクトはスコアロジックを sg_narutou.html /
//   gtools.html / kyotei_backtest.html / daikibo_replay.html の4ファイルへ手動コピーする
//   運用になっている。テストのためにここへ5つ目のコピーを作ると、テストだけ古いロジックの
//   ままになり「テストは通るが実物は壊れている」という最悪の状態になりかねない。
//   そのためこのモジュールは sg_narutou.html を毎回その場で読み込み、対象関数のソースを
//   正規表現+波カッコ対応付けで切り出して実行する。sg_narutou.html 側を書き換えれば
//   次回のテスト実行時に自動で反映される。
//
// 対象範囲: calcAreScore / calcNigeRate / calcAreIndex / judgeMode / decideProbabilisticPts /
//   _plWinProbs / _plConditionalProbs / _selectWithPairCap / buildBetsProbabilistic
//   (parseData() はテスト対象外。理由は tests/score_engine.regression.test.js 冒頭のコメント参照)

const fs = require('fs');
const path = require('path');
const os = require('os');

const FUNCTION_NAMES = [
  'calcAreScore',
  'calcNigeRate',
  'calcAreIndex',
  'judgeMode',
  'decideProbabilisticPts',
  '_plWinProbs',
  '_plConditionalProbs',
  '_selectWithPairCap',
  'buildBetsProbabilistic',
];

// `function name(...) { ... }` を波カッコの対応を数えて丸ごと切り出す。
// 文字列リテラル(' " `)・行コメント・ブロックコメントの中の { } は数えない。
function extractFunctionSource(source, name) {
  const startMatch = source.match(new RegExp(`\\nfunction ${name}\\s*\\(`));
  if (!startMatch) throw new Error(`function ${name} が見つかりません(sg_narutou.htmlの構造が変わった可能性があります)`);
  const start = startMatch.index + 1; // 先頭の\nを除く

  let i = source.indexOf('{', start);
  if (i === -1) throw new Error(`function ${name} の開始波カッコが見つかりません`);
  let depth = 0;
  let state = null; // null | 'sq' | 'dq' | 'tpl' | 'line' | 'block'

  for (; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];

    if (state === 'line') {
      if (c === '\n') state = null;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && next === '/') { state = null; i++; }
      continue;
    }
    if (state === 'sq' || state === 'dq' || state === 'tpl') {
      if (c === '\\') { i++; continue; } // エスケープの次の1文字は読み飛ばす
      if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || (state === 'tpl' && c === '`')) {
        state = null;
      }
      continue;
    }
    // 通常状態
    if (c === '/' && next === '/') { state = 'line'; i++; continue; }
    if (c === '/' && next === '*') { state = 'block'; i++; continue; }
    if (c === "'") { state = 'sq'; continue; }
    if (c === '"') { state = 'dq'; continue; }
    if (c === '`') { state = 'tpl'; continue; }
    if (c === '{') { depth++; continue; }
    if (c === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
      continue;
    }
  }
  throw new Error(`function ${name} の閉じ波カッコが見つかりません(波カッコ対応が崩れています)`);
}

function extractScoreEngineVersion(source) {
  const m = source.match(/const SCORE_ENGINE_VERSION\s*=\s*(\d+)/);
  if (!m) throw new Error('SCORE_ENGINE_VERSION が見つかりません');
  return parseInt(m[1], 10);
}

// sg_narutou.html から純粋関数群を切り出し、requireできるモジュールとして返す。
// 戻り値: { version, setRaceType(v), calcAreScore, calcNigeRate, calcAreIndex, judgeMode,
//           decideProbabilisticPts, buildBetsProbabilistic }
function loadScoreEngine(htmlPath) {
  const source = fs.readFileSync(htmlPath, 'utf8');
  const version = extractScoreEngineVersion(source);

  const funcSources = FUNCTION_NAMES.map(name => extractFunctionSource(source, name));

  // calcAreScore/calcAreIndex が参照する selectedRaceType はUIのレース種別選択と連動する
  // グローバル変数(sg_narutou.html:503)。ここでは setRaceType() 経由でテスト側から設定できるようにする。
  const moduleSource = [
    "'use strict';",
    "let selectedRaceType = 'ippan';",
    ...funcSources,
    'module.exports = {',
    '  setRaceType(v) { selectedRaceType = v; },',
    ...FUNCTION_NAMES.map(name => `  ${name},`),
    '};',
  ].join('\n\n');

  // require()できるよう一時ファイルに書き出す(内容はデバッグ用に残しておく)。
  const tmpDir = path.join(os.tmpdir(), 'garon-score-engine-extract');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `score_engine.v${version}.${Date.now()}.js`);
  fs.writeFileSync(tmpFile, moduleSource);

  const engine = require(tmpFile);
  engine.version = version;
  engine._generatedFile = tmpFile;
  return engine;
}

module.exports = { loadScoreEngine, extractFunctionSource, extractScoreEngineVersion, FUNCTION_NAMES };
