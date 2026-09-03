'use strict';
// GARON-20260902-001継続(CEO承認、2026-09-03): 手貼り予想画面(garon_alpha_engine.html)の
// α計算ロジックが、自動巡回側(scripts/lib/alpha_engine/alpha.js)と完全に一致するかを検証する。
// ネットワーク送信は一切行わない(モデルfetchはローカルファイルを返すモックに差し替える)。

const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
function check(name, cond) { if (cond) { console.log(`  PASS: ${name}`); pass++; } else { console.log(`  FAIL: ${name}`); fail++; } }

// --- fetch()をローカルファイル読み込みにモック(実ネットワーク送信なし) ---
const origFetch = global.fetch;
global.fetch = async (url) => {
  if (String(url).includes('garon_alpha_engine_model/form_model.json.gz')) {
    const buf = fs.readFileSync(path.join(ROOT, 'garon_alpha_engine_model', 'form_model.json.gz'));
    return new Response(buf, { status: 200 });
  }
  throw new Error('未対応のURLへのfetch: ' + url);
};

async function run() {
  const { loadAlphaEngineWeb } = require('./lib/extract-alpha-engine-web.js');
  const web = loadAlphaEngineWeb(path.join(ROOT, 'garon_alpha_engine.html'));

  console.log('=== A. モデル読み込み(ブラウザ版アダプター) ===');
  const loadState = await web.AlphaEngineWeb.ensureModelLoaded();
  check('モデルが正常に読み込める(ハッシュ一致・gunzip成功・arm=form確認)', loadState.ok === true);
  check('MODEL_IDが自動巡回側と同一', web.AlphaEngineWeb.MODEL_ID === 'garon_alpha_form_market05_band50_150_8pt_candidate_v1');
  check('ENTRY_THRESHOLDが自動巡回側と同一(丸めなし)', web.AlphaEngineWeb.ENTRY_THRESHOLD === 1.440209615716716);

  console.log('\n=== A2. モデル読み込み失敗パス(ハッシュ不一致を模擬) ===');
  {
    // loadAlphaEngineWeb()は毎回新しい一時ファイルへ書き出してrequire()するため、
    // model/modelLoadPromiseのモジュールスコープ状態は毎回まっさらになる。
    global.fetch = async (url) => {
      if (String(url).includes('garon_alpha_engine_model/form_model.json.gz')) {
        return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }); // 意図的に破損データ
      }
      throw new Error('未対応のURLへのfetch: ' + url);
    };
    const webBroken = require('./lib/extract-alpha-engine-web.js').loadAlphaEngineWeb(path.join(ROOT, 'garon_alpha_engine.html'));
    const brokenState = await webBroken.AlphaEngineWeb.ensureModelLoaded();
    check('破損モデルの読み込みは失敗として検知される(クラッシュしない)', brokenState.ok === false);
    check('失敗理由がハッシュ不一致(PACKAGE_HASH_MISMATCH)として分類される', brokenState.reason === 'PACKAGE_HASH_MISMATCH');
    const allCombos120 = [];
    for (let i = 1; i <= 6; i++) for (let j = 1; j <= 6; j++) for (let k = 1; k <= 6; k++) if (i !== j && j !== k && i !== k) allCombos120.push(`${i}-${j}-${k}`);
    const predictAfterFail = webBroken.AlphaEngineWeb.predict({
      boats: Array.from({ length: 6 }, (_, i) => ({ no: i + 1, isJogai: false })),
      oddsMap: Object.fromEntries(allCombos120.map(c => [c, 60])),
      oddsCapturedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 300000).toISOString(),
    }, Date.now());
    check('読み込み失敗後にpredict()を呼んでも例外を投げず、見送り(entered:false)を返す', predictAfterFail.entered === false);
    check('その見送り理由は継続的障害として分類される(自動巡回側のisStructuralFailure相当ロジックと同じ判定)', webBroken.isStructuralFailure(predictAfterFail.reason));
    // 元のモックへ戻す
    global.fetch = async (url) => {
      if (String(url).includes('garon_alpha_engine_model/form_model.json.gz')) {
        const buf = fs.readFileSync(path.join(ROOT, 'garon_alpha_engine_model', 'form_model.json.gz'));
        return new Response(buf, { status: 200 });
      }
      throw new Error('未対応のURLへのfetch: ' + url);
    };
  }

  console.log('\n=== B. 固定評価データ(実在1,195件)での全件突合(既知の参入80件を再現できるか) ===');
  const snapPath = path.join(ROOT, 'logs', 'research_alpha_review_snapshot_2026-09-02.json');
  const reconPath = path.join(ROOT, 'logs', 'research_alpha_reconciliation_2026-09-02.json');
  if (!fs.existsSync(snapPath) || !fs.existsSync(reconPath)) {
    console.log('  スキップ: 前段のスナップショット/照合結果ファイルが無い');
  } else {
    const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    const recon = JSON.parse(fs.readFileSync(reconPath, 'utf8'));
    const { predict: nodePredict } = require(path.join(ROOT, 'scripts', 'lib', 'alpha_engine', 'alpha.js'));

    let exceptions = 0, mismatchVsNode = 0, checkedCount = 0;
    const webEntered = [];
    for (const r of snap.races) {
      const nowMs = Date.parse(r.archivedAt);
      const m = String(r.shimekiri || '').match(/(\d{1,2}):(\d{2})/);
      if (!m) continue;
      const deadlineAt = new Date(Date.parse(`${r.date}T${m[1].padStart(2, '0')}:${m[2]}:00.000+09:00`)).toISOString();
      const input = { boats: r.boats, oddsMap: r.oddsMap, oddsCapturedAt: r.archivedAt, deadlineAt };
      let webResult, nodeResult;
      try {
        webResult = web.AlphaEngineWeb.predict(input, nowMs);
        nodeResult = nodePredict(input, nowMs);
      } catch (e) {
        exceptions++;
        continue;
      }
      checkedCount++;
      // ブラウザ版と自動巡回側(Node)が、同一入力・同一評価時刻で完全一致するか(reason/entered/points/estimatedReturn)
      const webPts = (webResult.points || []).map(p => p.combination).slice().sort();
      const nodePts = (nodeResult.points || []).map(p => p.combination).slice().sort();
      const sameEntered = webResult.entered === nodeResult.entered;
      const sameReason = webResult.reason === nodeResult.reason;
      const samePoints = JSON.stringify(webPts) === JSON.stringify(nodePts);
      const sameEstimate = (webResult.estimatedReturn === undefined && nodeResult.estimatedReturn === undefined)
        || Math.abs((webResult.estimatedReturn || 0) - (nodeResult.estimatedReturn || 0)) < 1e-9;
      if (!sameEntered || !sameReason || !samePoints || !sameEstimate) mismatchVsNode++;
      if (webResult.entered) webEntered.push({ key: r.key, points: webPts, estimate: webResult.estimatedReturn });
    }
    check(`全${snap.races.length}件の評価で例外が0件`, exceptions === 0);
    check(`ブラウザ版とNode版(自動巡回側)が全${checkedCount}件で完全一致(entered/reason/points/estimatedReturn)`, mismatchVsNode === 0);
    check(`ブラウザ版の参入件数が既確定の80件と一致(実際=${webEntered.length})`, webEntered.length === recon.myRecalculation.n);

    // Codex保存結果とも突合(自動巡回側の既存照合と同じ基準)
    const codexEntryPath = 'C:\\Users\\ymyin\\AppData\\Local\\Temp\\claude\\C--garon\\a809d265-9097-49b2-b095-410462e81f12\\scratchpad\\alpha_candidate_review\\raw_candidate\\qa_entry_results\\total_alpha_50_ev0_uniform.json';
    if (fs.existsSync(codexEntryPath)) {
      const codexAll = JSON.parse(fs.readFileSync(codexEntryPath, 'utf8'));
      const codexEntered = codexAll.filter(r => r.estimate >= web.AlphaEngineWeb.ENTRY_THRESHOLD);
      const codexByKey = new Map(codexEntered.map(r => [r.key, r]));
      const webKeys = new Set(webEntered.map(r => r.key));
      let onlyWeb = 0, onlyCodex = 0, pointsMismatch = 0;
      for (const w of webEntered) {
        const cx = codexByKey.get(w.key);
        if (!cx) { onlyWeb++; continue; }
        if (JSON.stringify(w.points) !== JSON.stringify(cx.points.slice().sort())) pointsMismatch++;
      }
      for (const k of codexByKey.keys()) if (!webKeys.has(k)) onlyCodex++;
      check('ブラウザ版の参入レース集合がCodex保存結果と完全一致(差集合0件)', onlyWeb === 0 && onlyCodex === 0);
      check('共通レースで買い目(points)の不一致が0件', pointsMismatch === 0);
    } else {
      console.log('  (Codex保存結果ファイルが見つからないためスキップ。Node版との全件一致で代替確認済み)');
    }
  }

  console.log('\n=== C. parseData()/extractOddsMap()の健全性(合成データでのスモークテスト) ===');
  {
    // 実際の競艇日和ページの貼り付けデータは手元に無いため、parseData()が期待する
    // 各正規表現パターンに一致する最小限の合成テキストで、パーサー自体が例外なく動作し、
    // αが要求するフィールド(艇6件・全120通りオッズ・日付・締切)を生成できることを確認する。
    // 実機(iPhone実データ)での確認は別途ブラウザ操作テストで行う。
    // extractOddsMap()の実際の構造(1着の見出し行→1行目でsecOrderと1行分〈5組〉を確定→
    // 以降の行はsecOrder列固定でthird digitだけ変わる行を追加)に正確に合わせて、
    // 1着ごとに5(2着)×4(3着)=20通り、6×20=120通りを合成する。
    const oddsLines = [];
    for (let f = 1; f <= 6; f++) {
      oddsLines.push(`${f}\t着順予想`);
      const secOrder = [1, 2, 3, 4, 5, 6].filter(x => x !== f);
      const thirdsFor = s => [1, 2, 3, 4, 5, 6].filter(x => x !== f && x !== s);
      // 1行目: secOrderを確定させつつ、各列の1組目(third=thirdsFor(s)[0])を与える
      oddsLines.push(secOrder.map(s => `${s}\t${thirdsFor(s)[0]}\t60.0`).join('\t'));
      // 2〜4行目: secOrder列固定、各列のthird候補2〜4組目
      for (let row = 1; row <= 3; row++) {
        oddsLines.push(secOrder.map(s => `${thirdsFor(s)[row]}\t60.0`).join('\t'));
      }
    }
    const synthText = [
      '=== レース情報 ===',
      '福岡\t1R\t20260903\t締切10:30\t初日\t予選',
      '=== 枠別勝率 ===',
      '1着率',
      '今期\t50.0%(10)\t40.0%(10)\t30.0%(10)\t20.0%(10)\t10.0%(10)\t5.0%(10)',
      '2連対率',
      '今期\t60.0%(10)\t50.0%(10)\t40.0%(10)\t30.0%(10)\t20.0%(10)\t10.0%(10)',
      '3連対率',
      '今期\t70.0%(10)\t60.0%(10)\t50.0%(10)\t40.0%(10)\t30.0%(10)\t20.0%(10)',
      '基本情報',
      '平均ST',
      '今期\t0.15\t0.16\t0.17\t0.18\t0.19\t0.20',
      'SG/G1\t0.15\t0.16\t0.17\t0.18\t0.19\t0.20',
      '当地\t0.15\t0.16\t0.17\t0.18\t0.19\t0.20',
      'ST順位',
      '得点率\t6.5\t6.0\t5.5\t5.0\t4.5\t4.0',
      '減点\t0\t0\t0\t0\t0\t0',
      '今節成績',
      '平均ST\t0.15\t0.16\t0.17\t0.18\t0.19\t0.20',
      'モーター\n2連対率\t35.0%\t33.0%\t31.0%\t29.0%\t27.0%\t25.0%',
      '展示\t6.70\t6.71\t6.72\t6.73\t6.74\t6.75',
      '周り足\t6.00\t6.01\t6.02\t6.03\t6.04\t6.05',
      '直線\t6.50\t6.51\t6.52\t6.53\t6.54\t6.55',
      '周回\t35.00\t35.10\t35.20\t35.30\t35.40\t35.50',
      '=== オッズ ===',
      ...oddsLines,
    ].join('\n');

    let threw = false, d, oddsMap;
    try {
      d = web.parseData(synthText);
      oddsMap = web.extractOddsMap(synthText);
    } catch (e) { threw = true; console.log('    (例外内容: ' + e.message + ')'); }
    check('合成データでparseData()/extractOddsMap()が例外を投げない', !threw);
    if (!threw) {
      check('venue/raceNum/hiduke/shimekiriを正しく抽出', d.venue === '福岡' && d.raceNum === '1R' && d.hiduke === '20260903' && d.shimekiri === '10:30');
      check('6艇分のboatsが生成される', d.boats.length === 6);
      check('sessonAvgST/konkiAvgST/motor2ren/tenji等の必要フィールドが数値化される', d.boats[0].sessonAvgST === 0.15 && d.boats[0].konkiAvgST === 0.15 && d.boats[0].motor2ren === 35.0 && d.boats[0].tenji === 6.70);
      const oddsCount = Object.keys(oddsMap).length;
      check(`extractOddsMap()が120通り抽出できる(実際=${oddsCount})`, oddsCount === 120);
      const deadlineIso = web.buildDeadlineIso(d.hiduke, d.shimekiri);
      check('buildDeadlineIso()がJST基準の正しいISO時刻を組み立てる', deadlineIso === new Date(Date.parse('2026-09-03T10:30:00.000+09:00')).toISOString());
      const missing = web.checkSufficiency(d, oddsMap);
      check('十分なデータでは不足項目が検出されない', missing.length === 0);

      // 欠損ケース: オッズが不足している場合に不足項目として検出されるか
      const shortOddsMap = Object.fromEntries(Object.entries(oddsMap).slice(0, 100));
      const missing2 = web.checkSufficiency(d, shortOddsMap);
      check('オッズ不足(100/120)を不足項目として検出する', missing2.some(m => m.includes('100/120')));

      // 欠場艇ケース
      const dJogai = JSON.parse(JSON.stringify(d));
      dJogai.boats[0].isJogai = true;
      const missing3 = web.checkSufficiency(dJogai, oddsMap);
      check('欠場艇を不足項目(参入見送り対象)として検出する', missing3.some(m => m.includes('欠場艇')));
    }
  }

  console.log(`\n=== 結果: PASS=${pass} FAIL=${fail} ===`);
  if (fail > 0) process.exitCode = 1;
}

run().finally(() => { global.fetch = origFetch; });
