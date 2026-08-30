'use strict';
// garon_q_engine.html から、Qエンジンの脳みそ(買い目生成)に使う「純粋関数」だけを
// 実体スクリプトから直接抜き出して実行可能なモジュールにする。
// tests/lib/extract-score-engine.js(sg_narutou.html用)と同じ方式(本体を毎回読みに行く)。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { extractFunctionSource, extractConstSource } = require('./extract-score-engine.js');

const FUNCTION_NAMES = [
  'calcAvgST',
  'identifyAttackCandidates',
  'identifyBenefitBoat',
  'rankBoatsBySystem',
  'evaluateBoatSupport',
  'generateQBets',
];

// identifyAttackCandidates()の外側(トップレベル)で定義されたconst。関数抽出には含まれないため
// 別途抜き出す必要がある(2026-08-27、研究部隊GARON-20260827-001が発見したバグの修正。
// tests/q_engine_entry_backtest.jsが全件ReferenceErrorで機能停止していた)。
// Q_ENGINE_VERSIONは2026-08-30追加(generateQBets内のgap<0見送りルール導入に伴う版数)。
const CONST_NAMES = ['ATTACK_MIN_GAP', 'Q_ENGINE_VERSION'];

function loadQEngine(htmlPath) {
  const source = fs.readFileSync(htmlPath, 'utf8');
  const funcSources = FUNCTION_NAMES.map(name => extractFunctionSource(source, name));
  const constSources = CONST_NAMES.map(name => extractConstSource(source, name));

  const moduleSource = [
    "'use strict';",
    ...constSources,
    ...funcSources,
    'module.exports = {',
    ...FUNCTION_NAMES.map(name => `  ${name},`),
    ...CONST_NAMES.map(name => `  ${name},`),
    '};',
  ].join('\n\n');

  const tmpDir = path.join(os.tmpdir(), 'garon-q-engine-extract');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `q_engine.${Date.now()}.js`);
  fs.writeFileSync(tmpFile, moduleSource);

  const engine = require(tmpFile);
  engine._generatedFile = tmpFile;
  return engine;
}

module.exports = { loadQEngine, FUNCTION_NAMES };
