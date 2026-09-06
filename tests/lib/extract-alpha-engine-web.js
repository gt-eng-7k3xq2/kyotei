'use strict';
// garon_alpha_engine.html から<script>全体を抜き出し、Node.jsから直接requireできる
// モジュールにする(tests/lib/extract-q-engine.jsと同じ「本体を毎回読みに行く」方式)。
// document/window が無い環境でも読み込めるよう、本体側で typeof document チェック済み。

const fs = require('fs');
const path = require('path');
const os = require('os');

function loadAlphaEngineWeb(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const m = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  if (m.length !== 1) throw new Error(`<script>タグの数が想定外(${m.length}個、1個を想定): ${htmlPath}`);
  const scriptSource = m[0][1];

  const moduleSource = [
    scriptSource,
    '',
    'module.exports = { AlphaEngineWeb, parseData, extractOddsMap, buildDeadlineIso, checkSufficiency, isStructuralFailure, NORMAL_SKIP_REASONS, SKIP_REASON_LABELS, renderResult };',
  ].join('\n');

  const tmpDir = path.join(os.tmpdir(), 'garon-alpha-engine-web-extract');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `alpha_engine_web.${Date.now()}.js`);
  fs.writeFileSync(tmpFile, moduleSource);

  const engine = require(tmpFile);
  engine._generatedFile = tmpFile;
  return engine;
}

module.exports = { loadAlphaEngineWeb };
