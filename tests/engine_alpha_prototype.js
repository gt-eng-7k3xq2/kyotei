'use strict';
// エンジンα(高配当ターゲットエンジン、2026-08-27 CEO指示で新規着手)のプロトタイプ・バックテスト。
//
// 設計方針:
//   - スコアリングはQエンジン(garon_q_engine.html)のevaluateBoatSupport(ST・決まり手・連対率・
//     機力・展示の5系統評価、rawScore)をそのまま流用する。今日の一連の検証で「evaluateBoatSupport
//     自体は①の実勝率と大まかに整合しており大きくは崩れていない、崩れているのは軸+紐のテンプレート型
//     買い目構成(攻め手候補の無条件優先等)の方」と判明したため、スコアリングの土台は再利用する。
//   - 買い目選定はQの「軸を決めて紐を広げる」テンプレート方式をやめ、sg_narutou.htmlの確率推定機構
//     (_plWinProbs/_plConditionalProbs、Plackett-Luce方式)を使って120通り全ての3連単comboの
//     的中確率P(combo)を計算し、EV(combo)=P(combo)×オッズ で期待値を出し、指定したオッズ帯
//     (中穴〜穴)に絞った上でEV上位を機械的に選ぶ。
//   - 「アーカイブは良いが実践はダメ」を繰り返さないため、温度パラメータT・オッズ帯・点数は
//     全て感覚値で決め打ちせず、前半(calibration)でグリッドサーチして選び、後半(held-out)で
//     素通しの成績を見る2段階検証にする(tests/weighted_optimization_search.jsと同じ方式)。
//
// 既知の限界(このまま鵜呑みにしないこと):
//   - Qエンジンのスコアリング(evaluateBoatSupport)がwakuStats.niren2に依存するため、対象は
//     データが揃っている2026-07-01〜04・08-11のみ(n=458)。暦日が実質4〜5日しか無く、
//     反証部隊(GARON-20260827-001)から「日付に紐づく未知の交絡因子を排除できていない」と
//     既に指摘されている。この限界はエンジンαにもそのまま当てはまる。
//
// 使い方:
//   node tests/engine_alpha_prototype.js            # グリッドサーチ+held-out検証を実行

const fs = require('fs');
const path = require('path');
const { loadQEngine } = require('./lib/extract-q-engine.js');
const { loadPLEngine } = require('./lib/extract-pl-engine.js');
const { allocateStakesEqualRet, isUsable, hasFullData, loadAllRaces } = require('./q_engine_entry_backtest.js');

const ROOT = path.join(__dirname, '..');
const SHIKIN = 3000;

function parsePayout100(payoutStr) {
  if (!payoutStr) return 0;
  const n = parseInt(String(payoutStr).replace(/[^\d]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

// 全120通りの3連単comboについて P(combo) を計算する(Plackett-Luce、_plWinProbs+_plConditionalProbs)。
function computeAllComboProbs(plEngine, scoreMap, T) {
  const boats = Object.keys(scoreMap);
  const wp = plEngine._plWinProbs(scoreMap, T);
  const results = [];
  boats.forEach(head => {
    const pHead = wp[head] || 0;
    if (pHead <= 0) return;
    const cond = plEngine._plConditionalProbs(scoreMap, head, T);
    cond.forEach(c => {
      results.push({ val: c.combo.join('-'), p: pHead * c.p });
    });
  });
  return results;
}

// 1レース分の買い目を、EV(=P×オッズ)上位・オッズ帯フィルタ付きで選ぶ。
function pickBetsByEV(comboProbs, oddsMap, oddsMin, oddsMax, pointCount) {
  const candidates = comboProbs
    .map(c => {
      const o = (oddsMap && oddsMap[c.val]) || 0;
      return { val: c.val, p: c.p, odds: o, ev: c.p * o };
    })
    .filter(c => c.odds >= oddsMin && c.odds < oddsMax);
  candidates.sort((a, b) => b.ev - a.ev);
  return candidates.slice(0, pointCount).map(c => c.val);
}

// 2026-08-27追加(雄大さん指摘: 「アーカイブは良いが実践はダメ」の原因は市場に対する優位性の欠如):
// 単純なEV(=自分の確率×オッズ)ではなく、「市場が織り込んでいる確率(オッズから逆算)」との
// 乖離(エッジ)が大きいcomboを選ぶ。市場と同じ情報で予想しているだけならROIはテラ銭分
// (今回の試作で確認した約75〜78%)に収束するのが自然で、それを超えるには市場が気づいていない
// 情報(エッジ)が要る、という考え方。
function marketImpliedProbs(comboProbs, oddsMap) {
  const withOdds = comboProbs.map(c => ({ val: c.val, odds: (oddsMap && oddsMap[c.val]) || 0 }))
    .filter(c => c.odds > 0);
  const totalInv = withOdds.reduce((s, c) => s + 1 / c.odds, 0);
  const marketP = {};
  withOdds.forEach(c => { marketP[c.val] = totalInv > 0 ? (1 / c.odds) / totalInv : 0; });
  return marketP;
}
function pickBetsByEdge(comboProbs, oddsMap, oddsMin, oddsMax, pointCount) {
  const marketP = marketImpliedProbs(comboProbs, oddsMap);
  const candidates = comboProbs
    .map(c => {
      const o = (oddsMap && oddsMap[c.val]) || 0;
      const mp = marketP[c.val] || 0;
      return { val: c.val, p: c.p, odds: o, edge: c.p - mp };
    })
    .filter(c => c.odds >= oddsMin && c.odds < oddsMax && c.edge > 0);
  candidates.sort((a, b) => b.edge - a.edge);
  return candidates.slice(0, pointCount).map(c => c.val);
}

function analyzeRace(qEngine, plEngine, r, T, oddsMin, oddsMax, pointCount, method) {
  const support = qEngine.evaluateBoatSupport(r.boats);
  const scoreMap = {};
  support.forEach(s => { scoreMap[String(s.no)] = s.rawScore; });

  const comboProbs = computeAllComboProbs(plEngine, scoreMap, T);
  const betVals = method === 'edge'
    ? pickBetsByEdge(comboProbs, r.oddsMap, oddsMin, oddsMax, pointCount)
    : pickBetsByEV(comboProbs, r.oddsMap, oddsMin, oddsMax, pointCount);
  if (!betVals.length) return { hit: false, stake: 0, payout: 0, betCount: 0 };

  const amounts = allocateStakesEqualRet(betVals, r.oddsMap, SHIKIN);
  const hitIdx = betVals.indexOf(r.chakuju);
  const hit = hitIdx >= 0;
  const stake = amounts.reduce((s, a) => s + a, 0);
  const payout = hit ? Math.round(amounts[hitIdx] / 100 * parsePayout100(r.payout)) : 0;
  return { hit, stake, payout, betCount: betVals.length };
}

function summarize(rows) {
  const n = rows.length;
  if (!n) return { n: 0, hitRate: null, roi: null, profit: 0 };
  const hits = rows.filter(r => r.hit).length;
  const stake = rows.reduce((s, r) => s + r.stake, 0);
  const payout = rows.reduce((s, r) => s + r.payout, 0);
  return { n, hits, hitRate: hits / n * 100, roi: stake ? payout / stake * 100 : null, stake, payout, profit: payout - stake };
}

function fmt(s) {
  if (!s.n) return 'n=0';
  return `n=${s.n}\t的中率${s.hitRate.toFixed(1)}%\tROI${s.roi.toFixed(1)}%\t純損益${s.profit >= 0 ? '+' : ''}¥${s.profit.toLocaleString()}`;
}

function main() {
  const qEngine = loadQEngine(path.join(ROOT, 'garon_q_engine.html'));
  const plEngine = loadPLEngine(path.join(ROOT, 'sg_narutou.html'));

  // 2026-08-27追加: wakuStats.niren2(連対率系統)が無いレースは、evaluateBoatSupport内で
  // 全艇に同じ中立値3.5点が入るだけ(艇ごとに偏ることはない、確認済み: 7,073レース中
  // 艇ごとに有無がバラついたケースは0件)。Plackett-Luceは全艇へ均等な定数シフトに対して
  // 不変(softmax正規化で相殺される)ため、wakuStatsの有無は勝率計算の結果を一切変えない。
  // つまりhasFullData()で絞る必要は無く、全期間データ(n=6,000超)で検証できる。
  // --limited を付けた場合のみ、比較用に従来のn=464(wakuStats完全データのみ)に絞る。
  const useFullData = !process.argv.includes('--limited');
  const allRaces = loadAllRaces();
  const races = (useFullData ? allRaces.filter(isUsable) : allRaces.filter(isUsable).filter(hasFullData));
  races.sort((a, b) => (a.date + a.venue + a.racenum).localeCompare(b.date + b.venue + b.racenum));

  console.log(`対象n=${races.length}(${useFullData ? '全期間データ、連対率系統は無い場合中立値だが確率計算には影響しない' : '個人×コース連対率データが完全なもののみ(--limited)'})`);

  const mid = Math.floor(races.length / 2);
  const calib = races.slice(0, mid);
  const heldout = races.slice(mid);
  console.log(`前半(calibration) n=${calib.length} / 後半(held-out) n=${heldout.length}\n`);

  const T_GRID = [3, 6, 10, 15, 20];
  const ODDS_BANDS = [
    { label: '全帯(フィルタ無し)', min: 0, max: 100000 },
    { label: '5倍以上', min: 5, max: 100000 },
    { label: '10倍以上', min: 10, max: 100000 },
    { label: '20倍以上', min: 20, max: 100000 },
    { label: '10-100倍(中穴)', min: 10, max: 100 },
  ];
  const POINT_COUNTS = [4, 8, 13];

  // 2026-08-27修正: 前半ROI最大化だけで設定を選ぶと、的中率0.4%(1レースの大当たり依存)のような
  // 統計的に無意味な設定が「最良」に選ばれてしまい、後半で崩壊することを確認した(まさに
  // 「アーカイブは良いが実践はダメ」の再現)。最低的中件数(calib側でhits>=5)を必須条件に加え、
  // 前半・後半の両方で結果を出してから、両方で安定している設定を探す方式に変更する。
  const MIN_HITS = 5;
  const METHODS = ['ev', 'edge'];
  const allResults = [];
  for (const method of METHODS) {
    for (const T of T_GRID) {
      for (const band of ODDS_BANDS) {
        for (const pointCount of POINT_COUNTS) {
          const calibRows = calib.map(r => {
            try { return analyzeRace(qEngine, plEngine, r, T, band.min, band.max, pointCount, method); }
            catch (e) { return null; }
          }).filter(Boolean);
          const calibS = summarize(calibRows);
          if (calibS.n < 30 || (calibS.hits || 0) < MIN_HITS) continue;

          const heldoutRows = heldout.map(r => {
            try { return analyzeRace(qEngine, plEngine, r, T, band.min, band.max, pointCount, method); }
            catch (e) { return null; }
          }).filter(Boolean);
          const heldoutS = summarize(heldoutRows);

          allResults.push({ method, T, band: band.label, pointCount, calib: calibS, heldout: heldoutS });
        }
      }
    }
  }

  console.log(`=== グリッドサーチ結果(前半hits>=${MIN_HITS}のみ採用、前半ROI上位15件を前半/後半併記) ===`);
  allResults.sort((a, b) => (b.calib.roi || 0) - (a.calib.roi || 0)).slice(0, 15).forEach(r => {
    console.log(`[${r.method}] T=${r.T}\t${r.band}\t点数=${r.pointCount}`);
    console.log(`  前半: ${fmt(r.calib)}`);
    console.log(`  後半: ${fmt(r.heldout)}`);
  });

  console.log(`\n=== 前半・後半ともROI100%超(黒字)の設定 ===`);
  const bothProfitable = allResults.filter(r => (r.calib.roi || 0) >= 100 && (r.heldout.roi || 0) >= 100 && (r.heldout.hits || 0) >= MIN_HITS);
  if (!bothProfitable.length) {
    console.log('該当なし。');
  } else {
    bothProfitable.forEach(r => {
      console.log(`[${r.method}] T=${r.T}\t${r.band}\t点数=${r.pointCount}`);
      console.log(`  前半: ${fmt(r.calib)}`);
      console.log(`  後半: ${fmt(r.heldout)}`);
    });
  }
}

if (require.main === module) main();
module.exports = { computeAllComboProbs, pickBetsByEV, pickBetsByEdge, analyzeRace, summarize };
