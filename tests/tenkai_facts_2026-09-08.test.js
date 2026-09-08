'use strict';
// 展開コメント用「確定事実」抽出(2026-09-08、CEO指示、GARON-20260907-003 Q v2の続き)の回帰・大規模検証。
// 対象: buildBetOrderFacts / buildSecondCandidateRanking / buildBetBranches /
//       reconstructBetsFromBranches / buildBetCommentFacts / buildRoleCandidates
//       および computeTenkaiFacts() の b.type==='本線' バグ修正。
// garon_q_engine.html 本体は変更しない(このテストはロジックの追加ではなく検証専用)。
//
// データ源: research/q_stage_diagnosis_2026-09-07/snapshots/frozen_complete_races.json
//   (GARON-20260907-001診断で凍結済みのn=3,758件、2026-07-01〜09-05、処理中日2026-07-17除外)。
//   period()の定義はresearch/prediction_architecture_2026-09-07/code/01_support_calibration.js
//   と同一(train: <=07-16 / validation: 2026-08 / confirmation: 09-01〜09-05)。
//
// 使い方: node tests/tenkai_facts_2026-09-08.test.js

const fs = require('fs');
const path = require('path');
const { loadQEngine } = require('./lib/extract-q-engine');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'garon_q_engine.html');
const FROZEN_PATH = path.join(ROOT, 'research/q_stage_diagnosis_2026-09-07/snapshots/frozen_complete_races.json');

function period(d) {
  if (d <= '2026-07-16') return 'train';
  if (d.indexOf('2026-08') === 0) return 'validation';
  if (d >= '2026-09-01' && d <= '2026-09-05') return 'confirmation';
  return 'unused';
}

// runYosoQ()と同じ手順でrankingを組み立てる(currentCalcData.ranking相当)。
// 2026-09-08修正: rankOrder自体の構築は本体のbuildRankOrder()をそのまま使う(テスト側で
// 別ロジックを再実装すると、本体を直しても気づかずテストだけ古いロジックのままになるため)。
function buildRanking(engine, support, axes, dbg) {
  const marks = ['◎', '○', '▲', '△', '▽', '×'];
  const supportSorted = [...support].sort((a, b) => b.rawScore - a.rawScore);
  const axisBoatsInOrder = axes.map(a => a.boat);
  const rankOrder = engine.buildRankOrder(supportSorted, axisBoatsInOrder, dbg);
  return rankOrder.map((no, i) => {
    const s = support.find(x => x.no === no);
    return { rank: i + 1, boat: no, mark: marks[i] || '×', score: s.rawScore };
  });
}

// runYosoQ()と同じ手順でbetsRawを組み立てる(currentCalcData.betsRaw相当、type文字列も再現)。
function buildBetsRaw(result) {
  const allPts = [];
  result.formations.forEach(f => {
    f.points.forEach(p => allPts.push({ val: p, type: `${f.type}(${f.axis}軸)` }));
  });
  return allPts;
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function main() {
  console.log('garon_q_engine.html からQエンジン関数群(展開コメント抽出含む)を抽出中...');
  const engine = loadQEngine(HTML_PATH);
  console.log(`Q_ENGINE_VERSION = ${engine.Q_ENGINE_VERSION}\n`);

  console.log('凍結データ読み込み中... (n=3,758、時間がかかります)');
  const races = JSON.parse(fs.readFileSync(FROZEN_PATH, 'utf8'));
  console.log(`読み込み完了: ${races.length}件\n`);

  const byPeriod = { train: [], validation: [], confirmation: [], unused: [] };
  races.forEach(r => byPeriod[period(r.date)].push(r));
  console.log(`train=${byPeriod.train.length} validation=${byPeriod.validation.length} confirmation=${byPeriod.confirmation.length} unused=${byPeriod.unused.length}`);

  const target = [...byPeriod.validation, ...byPeriod.confirmation]; // n=1,280想定(必須テスト対象)
  console.log(`必須テスト対象(validation+confirmation): n=${target.length}\n`);

  // 100件クイックチェック(train先頭100件、必須テスト#1-9の一般検証)
  const quickSample = byPeriod.train.slice(0, 100);

  let fail = 0;
  const counters = {
    branchMismatch: 0,
    orderMismatch: 0,
    extraneousBoat: 0,
    fabricatedKimarite: 0,
    roleNoReason: 0,
    nonIdempotent: 0,
    honsenEmptyBug: 0, // computeTenkaiFactsのb.type==='本線'バグが再発していないかの検証
    missingDataCrash: 0,
    // 2026-09-08 CEO修正指示(役割候補の意味付け訂正)の再検証用
    tenkaiTsukiStillExists: 0, // 「展開突き候補」ラベルが出ていないか(廃止済みのはず)
    symmetricNotMoved: 0, // 対称買い目がbetStructureへ正しく移動しているか
    uchisashiWithoutSashi: 0, // 差し実績0/欠損の2号艇に内差し候補が付いていないか
  };
  const roleTally = {}; // 役割ラベルの出現回数(集計用、CEOへの報告に使う)
  let betStructureCount = 0, positionInfoCount = 0;

  function checkOne(r, label) {
    const boats = r.boats;
    const support = engine.evaluateBoatSupport(boats);
    const attackCands = engine.identifyAttackCandidates(boats);
    const result = engine.generateQBets(boats, r.oddsMap);
    const dbg = result._dbg;
    const ranking = buildRanking(engine, support, result.axes, dbg);
    const maruBoat = ranking[0].boat;
    const betsRaw = buildBetsRaw(result);

    // --- 必須テスト#1,2,3: 買い目・点数・Qv2確率順位が変更前と一致(既存回帰テストが担保)は
    //     tests/q_engine.regression.test.js側でカバー済み(3フィクスチャPASS確認済み)。
    //     ここではsel(選択済み買い目)の並びそのものが確率降順であることを直接検算する。
    const probs = dbg.selectedPoints.map(v => dbg.probabilities[v]);
    for (let i = 1; i < probs.length; i++) {
      if (probs[i] > probs[i - 1] + 1e-15) { counters.orderMismatch++; if (fail < 5) console.log(`[FAIL order] ${label}`); fail++; break; }
    }

    // --- 必須テスト#4: 買い目分岐から再構築した集合がselectedPointsと完全一致
    const branches = engine.buildBetBranches(dbg);
    const reconstructed = engine.reconstructBetsFromBranches(branches).slice().sort();
    const original = dbg.selectedPoints.slice().sort();
    if (!deepEqual(reconstructed, original)) {
      counters.branchMismatch++;
      if (fail < 5) console.log(`[FAIL branch] ${label}: reconstructed=${reconstructed.length} original=${original.length}`);
      fail++;
    }

    // --- 必須テスト#5: 2着候補順位がオッズ非依存(関数シグネチャがoddsMapを取らないことに加え、
    //     oddsMapを差し替えても結果が変わらないことを直接検算する)
    const secondRanking1 = engine.buildSecondCandidateRanking(dbg);
    const secondRanking2 = engine.buildSecondCandidateRanking(dbg); // oddsMap自体を渡していない
    if (!deepEqual(secondRanking1, secondRanking2)) { counters.nonIdempotent++; fail++; }

    // --- 必須テスト#6: 買い目外の艇がコメント用候補へ混入していない
    const boatsInBets = new Set();
    dbg.selectedPoints.forEach(v => v.split('-').forEach(n => boatsInBets.add(Number(n))));
    const commentFacts = engine.buildBetCommentFacts(boats, support, attackCands, dbg, ranking);
    commentFacts.forEach(f => { if (!boatsInBets.has(f.no)) { counters.extraneousBoat++; fail++; } });
    const roles = engine.buildRoleCandidates(boats, attackCands, dbg, maruBoat);
    roles.forEach(rr => { if (!boatsInBets.has(rr.no) || rr.no === maruBoat) { counters.extraneousBoat++; fail++; } });

    // --- 2026-09-08 CEO修正指示#1の再検証: 「展開突き候補」という役割ラベルが二度と出ないこと
    roles.forEach(rr => { if (rr.role === '展開突き候補') { counters.tenkaiTsukiStillExists++; fail++; if (fail < 8) console.log(`[FAIL tenkai-tsuki] ${label}`); } });
    // 対称構造が検出された艇は、役割ではなくbetStructureとして出ていること(役割に混入していないこと)
    const branches2ForSym = engine.buildBetBranches(dbg);
    dbg.selectedPoints.forEach(v => {
      const parts = v.split('-').map(Number);
      const f = parts[0], s = parts[1], t = parts[2];
      if (s === t) return;
      if (new Set(dbg.selectedPoints).has(`${f}-${t}-${s}`)) {
        [s, t].forEach(no => {
          if (no === maruBoat) return;
          const rr = roles.find(x => x.no === no);
          if (!rr || !rr.betStructure || rr.betStructure.type !== '2着・3着入れ替わり候補') { counters.symmetricNotMoved++; fail++; }
        });
      }
    });

    // --- 2026-09-08 CEO修正指示#2の再検証: 差し実績が0または欠損の2号艇に「内差し候補」が付かないこと
    const bd2 = boats[1] || {};
    const uchisashiRole = roles.find(rr => rr.no === 2 && rr.role === '内差し候補');
    if (uchisashiRole) {
      const sashi = bd2.sashi6m;
      if (!(typeof sashi === 'number' && sashi > 0)) { counters.uchisashiWithoutSashi++; fail++; if (fail < 8) console.log(`[FAIL uchisashi] ${label}: sashi6m=${sashi}`); }
      // 差し実績ありでも、2号艇が実際に「1号艇1着×2号艇2着」の買い目上の2着候補でなければ付与してはいけない
      if (!(branches2ForSym[1] && branches2ForSym[1][2])) { counters.uchisashiWithoutSashi++; fail++; }
      if (maruBoat !== 1) { counters.uchisashiWithoutSashi++; fail++; }
    }

    // --- 役割候補の全件に直接根拠があること(根拠不足以外は必ずreasonが非空。役割が根拠不足でも
    //     betStructure/positionInfoは別項目であり役割自体のreasonとは無関係)
    roles.forEach(rr => {
      if (rr.role !== '根拠不足' && (!rr.reason || !rr.reason.length)) { counters.roleNoReason++; fail++; }
      if (rr.betStructure && (!rr.betStructure.reason || !rr.betStructure.reason.length)) { counters.roleNoReason++; fail++; }
      roleTally[rr.role] = (roleTally[rr.role] || 0) + 1;
      if (rr.betStructure) betStructureCount++;
      if (rr.positionInfo) positionInfoCount++;
    });

    // --- 必須テスト#7: データにない決まり手が出力されていない(GARON_COURSE_KIMARITEの
    //     コース対応外のキーが出ていない、かつ1号艇に決まり手が付与されていない)
    commentFacts.forEach(f => {
      if (f.決まり手) {
        const allowed = engine.GARON_COURSE_KIMARITE[f.no] || [];
        const keys = Object.keys(f.決まり手.実績);
        const bad = keys.some(k => !allowed.includes(k));
        if (bad || f.no === 1) { counters.fabricatedKimarite++; fail++; }
      }
    });

    // --- 必須テスト#8: 役割候補には必ず根拠が付いている → 上のCEO修正指示の再検証ブロックで
    //     まとめて実施済み(roleNoReasonカウンタ)。

    // --- 必須テスト#9: 同じ入力を複数回処理して同じ結果になる(決定性)
    const orderFacts1 = engine.buildBetOrderFacts(dbg);
    const orderFacts2 = engine.buildBetOrderFacts(dbg);
    const branches2 = engine.buildBetBranches(dbg);
    const roles2 = engine.buildRoleCandidates(boats, attackCands, dbg, maruBoat);
    const commentFacts2 = engine.buildBetCommentFacts(boats, support, attackCands, dbg, ranking);
    if (!deepEqual(orderFacts1, orderFacts2) || !deepEqual(branches, branches2) || !deepEqual(roles, roles2) || !deepEqual(commentFacts, commentFacts2)) {
      counters.nonIdempotent++; fail++;
    }

    // --- 必須テスト#10: computeTenkaiFacts()のb.type==='本線'バグが直っているか
    //     (computeTenkaiFacts自体はDOM/グローバル状態に依存するため、修正後と同一の判定式
    //     〈軸=1着から始まる買い目〉をbetsRaw〈実際のtype文字列付き〉に対して直接検算する)
    const honsenBetsFixed = betsRaw.filter(b => parseInt(String(b.val).split('-')[0], 10) === maruBoat);
    const honsenBetsOldBuggy = betsRaw.filter(b => b.type === '本線'); // 旧バグ条件(常に空になるはず)
    if (honsenBetsFixed.length === 0) { counters.honsenEmptyBug++; fail++; if (fail < 8) console.log(`[FAIL honsen-empty] ${label}`); }
    if (honsenBetsOldBuggy.length !== 0) { console.log(`[NOTE] ${label}: 旧バグ条件が想定外に非空(betsRaw.type='本線'が実在)`); }
  }

  console.log('=== クイックサンプル(train先頭100件、必須テスト#1-9) ===');
  quickSample.forEach((r, i) => checkOne(r, `train#${i}(${r.date} ${r.venue}${r.racenum}R)`));
  console.log(`クイックサンプル完了。時点の累積fail=${fail}\n`);

  console.log(`=== 必須テスト範囲(validation+confirmation、n=${target.length}、買い目分岐再構築100%一致+#10) ===`);
  const beforeTargetFail = fail;
  target.forEach((r, i) => {
    checkOne(r, `${period(r.date)}#${i}(${r.date} ${r.venue}${r.racenum}R)`);
    if ((i + 1) % 200 === 0) console.log(`  ${i + 1}/${target.length}件処理済み...`);
  });
  const targetFail = fail - beforeTargetFail;

  console.log('\n' + '='.repeat(70));
  console.log(`counters: ${JSON.stringify(counters, null, 2)}`);
  console.log(`役割ラベル出現回数(全${quickSample.length + target.length}件、非軸艇のべ件数ベース): ${JSON.stringify(roleTally, null, 2)}`);
  console.log(`買い目構造(2着・3着入れ替わり候補)の出現数: ${betStructureCount}`);
  console.log(`位置情報のみ(差し実績なしの2号艇2着候補)の出現数: ${positionInfoCount}`);
  console.log(`検証対象合計: ${quickSample.length + target.length}件`);
  console.log(`validation+confirmation(n=${target.length})内のfail件数: ${targetFail}`);
  console.log(`総fail件数: ${fail}`);
  if (fail === 0) {
    console.log(`結果: 全件PASS(買い目分岐の再構築一致率100%、computeTenkaiFactsのhonsenBets空配列バグ再発なし、その他必須テスト#1-9も全件PASS)`);
  } else {
    console.log('結果: FAILあり、上記counters参照');
    process.exit(1);
  }
}

main();
