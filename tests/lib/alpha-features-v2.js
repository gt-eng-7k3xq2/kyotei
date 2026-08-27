'use strict';
// エンジンα v2特徴量: v1(alpha-features.js)は各系統を「艇内順位(1〜6位)」に変換していたため、
// 差の大きさ(magnitude)を捨てていた(例: 機力60% vs 25%も、45% vs 44%も、順位差としては同じ扱い)。
// v2はレース内でz-score化(平均との差÷標準偏差)することで、実際の強さの差を特徴量にする。
// 生データの取得ロジックはgaron_q_engine.htmlのrankBoatsBySystem()内のクロージャと同じ定義を
// 踏襲する(単純なフィールド参照なので複製リスクは低い。乖離時はrankBoatsBySystem側を正とする)。

function zscore(vals) {
  const valid = vals.filter(v => v != null && !isNaN(v));
  if (valid.length < 2) return vals.map(() => 0);
  const mean = valid.reduce((s, v) => s + v, 0) / valid.length;
  const variance = valid.reduce((s, v) => s + (v - mean) ** 2, 0) / valid.length;
  const std = Math.sqrt(variance) || 1;
  return vals.map(v => (v == null || isNaN(v)) ? 0 : (v - mean) / std);
}

// qEngine.calcAvgST(b)を外から渡してもらう(garon_q_engine.htmlから抽出済みのものをそのまま使う)。
function buildFeaturesV2(boats, calcAvgST) {
  const stRaw = boats.map(b => { const v = calcAvgST(b); return v == null ? null : -v; }); // 速い(小さい)ほど良い→符号反転
  const kimariteRaw = boats.map((b, idx) => idx === 0 ? (b.kimariteNige6m || null) : Math.max(b.sashi6m || 0, b.makuri6m || 0, b.makurisashi6m || 0));
  const renRaw = boats.map(b => {
    const periods = ['今期', '直近 6ヶ月', '直近 3ヶ月', '一般戦'];
    const rates = periods.map(p => b.wakuStats && b.wakuStats.niren2 && b.wakuStats.niren2[p]).filter(v => v && v.n >= 8);
    return rates.length ? rates.reduce((s, v) => s + v.rate, 0) / rates.length : null;
  });
  const motorRaw = boats.map(b => b.motor2ren || null);
  // 展示4指標(単位が違うため、指標ごとにz-score化してから平均する)
  const exhibitMetrics = [
    boats.map(b => b.tenji != null ? -b.tenji : null),       // タイム系は小さいほど良い→符号反転
    boats.map(b => b.syukai != null ? -b.syukai : null),
    boats.map(b => b.syukaiFoot != null ? -b.syukaiFoot : null),
    boats.map(b => b.chokusen != null ? -b.chokusen : null),
  ];
  const exhibitZs = exhibitMetrics.map(zscore);
  const exhibitCombined = boats.map((_, i) => {
    const vs = exhibitZs.map(z => z[i]).filter(v => v !== 0); // 0は「データ無し」の可能性もあるが簡易的に除外はしない方針に統一
    return exhibitZs.reduce((s, z) => s + z[i], 0) / exhibitZs.length;
  });

  const stZ = zscore(stRaw);
  const kimariteZ = zscore(kimariteRaw);
  const renZ = zscore(renRaw);
  const motorZ = zscore(motorRaw);

  return boats.map((b, i) => {
    const course = b.no;
    const courseDummies = [2, 3, 4, 5, 6].map(c => (course === c ? 1 : 0));
    return [...courseDummies, stZ[i], kimariteZ[i], renZ[i], motorZ[i], exhibitCombined[i]];
  });
}

const FEATURE_NAMES_V2 = ['course2', 'course3', 'course4', 'course5', 'course6', 'st_z', 'kimarite_z', 'ren_z', 'motor_z', 'exhibit_z'];

module.exports = { buildFeaturesV2, FEATURE_NAMES_V2, zscore };
