'use strict';
// sg_narutou.htmlから、Plackett-Luce方式の着順確率推定機構だけを抜き出す。
// エンジンα(garon_alpha_engine想定)のプロトタイプ用。tests/lib/extract-score-engine.jsと
// 同じ「本体を毎回読みに行く」方式(コピー複製しない)を踏襲する。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { extractFunctionSource } = require('./extract-score-engine.js');

const FUNCTION_NAMES = ['_plWinProbs', '_plConditionalProbs'];

function loadPLEngine(htmlPath) {
  const source = fs.readFileSync(htmlPath, 'utf8');
  const funcSources = FUNCTION_NAMES.map(name => extractFunctionSource(source, name));

  const moduleSource = [
    "'use strict';",
    ...funcSources,
    'module.exports = {',
    ...FUNCTION_NAMES.map(name => `  ${name},`),
    '};',
  ].join('\n\n');

  const tmpDir = path.join(os.tmpdir(), 'garon-pl-engine-extract');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `pl_engine.${Date.now()}.js`);
  fs.writeFileSync(tmpFile, moduleSource);

  const engine = require(tmpFile);
  engine._generatedFile = tmpFile;
  return engine;
}

module.exports = { loadPLEngine, FUNCTION_NAMES };
