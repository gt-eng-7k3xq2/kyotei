'use strict';
// GARON P0障害対応(2026-09-06)継続: 手貼り予想画面(garon_alpha_engine.html)は
// これまでBELOW_THRESHOLD(見送り)の時、predict()が計算済みの8点を持っていても
// 画面に表示せず「見送り」の文言だけを出していた。締切直前に再計算すると
// オッズ変動で見送りに変わることがあり、その都度何も出せず運用できないという
// CEO指摘を受け、BELOW_THRESHOLD時のみ「参考情報」として8点を表示するよう修正した。
// 本テストはrenderResult()のDOM出力を直接検証する(document.getElementById()を
// スタブ化するのみで、実ブラウザ・ネットワークは使わない)。

const path = require('path');
const assert = require('assert/strict');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function check(name, cond) { if (cond) { console.log(`  PASS: ${name}`); pass++; } else { console.log(`  FAIL: ${name}`); fail++; } }

function makeDomStub() {
  const els = { 'yoso-result': { innerHTML: '' } };
  global.document = { getElementById: (id) => els[id] };
  return els;
}

function run() {
  const { loadAlphaEngineWeb } = require('./lib/extract-alpha-engine-web.js');
  const web = loadAlphaEngineWeb(path.join(ROOT, 'garon_alpha_engine.html'));
  const nowMs = Date.parse('2026-09-06T08:26:00+09:00');
  const deadlineAt = new Date('2026-09-06T08:32:00+09:00').toISOString();

  console.log('=== D. BELOW_THRESHOLDの参考買い目表示(2026-09-06修正) ===');
  {
    const els = makeDomStub();
    const points = [
      { combination: '1-2-6', odds: 81.8, amount: 100 },
      { combination: '1-4-6', odds: 63.2, amount: 100 },
      { combination: '1-6-3', odds: 129.8, amount: 100 },
      { combination: '1-5-6', odds: 98.2, amount: 100 },
      { combination: '1-6-4', odds: 139.7, amount: 100 },
      { combination: '3-1-2', odds: 103.5, amount: 100 },
      { combination: '3-1-6', odds: 140.8, amount: 100 },
      { combination: '3-1-5', odds: 98.5, amount: 100 },
    ];
    const result = { modelId: web.AlphaEngineWeb.MODEL_ID, entered: false, reason: 'BELOW_THRESHOLD', points, estimatedReturn: 1.39, entryThreshold: web.AlphaEngineWeb.ENTRY_THRESHOLD };
    web.renderResult(result, {}, deadlineAt, nowMs);
    const html = els['yoso-result'].innerHTML;
    check('見送り(閾値未満)の警告文言が出る', html.includes('見送り') && html.includes('参入閾値未満'));
    check('8点すべてが買い目表として表示される', points.every(p => html.includes(p.combination) && html.includes(String(p.odds))));
    check('参考情報である旨(自動巡回では通知されない)が明記される', html.includes('自動巡回からntfy通知はされません') || html.includes('通知はされません'));
    check('推定値と閾値が表示される', html.includes('1.390') && html.includes(String(web.AlphaEngineWeb.ENTRY_THRESHOLD)));
  }

  console.log('\n=== E. 他の見送り理由(データ不足系)は従来通り買い目を出さない ===');
  for (const reason of ['INVALID_BOATS', 'INVALID_TIMESTAMP', 'INVALID_ODDS', 'INSUFFICIENT_BAND_CANDIDATES']) {
    const els = makeDomStub();
    const result = { modelId: web.AlphaEngineWeb.MODEL_ID, entered: false, reason, points: [] };
    web.renderResult(result, {}, deadlineAt, nowMs);
    const html = els['yoso-result'].innerHTML;
    check(`${reason}: 買い目テーブルを表示しない(bet-tableが無い)`, !html.includes('bet-table'));
    check(`${reason}: 見送り理由が表示される`, html.includes(web.SKIP_REASON_LABELS[reason]));
  }

  console.log('\n=== F. entered=true(参入)の従来表示は変更されない ===');
  {
    const els = makeDomStub();
    const points = [{ combination: '1-2-3', odds: 60, amount: 100 }];
    const result = { modelId: web.AlphaEngineWeb.MODEL_ID, entered: true, reason: 'CANDIDATE_ENTRY', points, estimatedReturn: 1.50, entryThreshold: web.AlphaEngineWeb.ENTRY_THRESHOLD };
    web.renderResult(result, {}, deadlineAt, nowMs);
    const html = els['yoso-result'].innerHTML;
    check('参入バナーが表示される', html.includes('α判定: 参入'));
    check('買い目テーブルが表示される', html.includes('1-2-3') && html.includes('bet-table'));
  }

  console.log(`\n=== 結果: PASS=${pass} FAIL=${fail} ===`);
  process.exitCode = fail > 0 ? 1 : 0;
}

run();
