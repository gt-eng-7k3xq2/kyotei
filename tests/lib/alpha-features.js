'use strict';
// エンジンα用の特徴量抽出。Qエンジン(garon_q_engine.html)のrankBoatsBySystem()が出す
// 系統別順位(ST・決まり手・連対率・機力・展示、1〜6位)を素材として流用するが、
// 「ST×2倍で単純合計」という決め打ちの重み付けはしない。重みはalpha_train_model.jsが
// 実際の過去の勝敗データから学習する。

// rankBoatsBySystem(boats) -> {st, kimarite, ren, motor, exhibit} (それぞれ艇index順の1〜6位配列)
// を受け取り、6艇分の特徴量ベクトル(各艇: [course2..course6, st, kimarite, ren, motor, exhibit])を返す。
// 順位は(7-rank)/6で0〜1(1位→1.0、6位→0.166...)に正規化し、情報なし(null)は0.5(中立)とする。
function buildFeatures(boats, ranks) {
  const norm = (r) => (r == null ? 0.5 : (7 - r) / 6);
  return boats.map((b, i) => {
    const course = b.no; // 1〜6
    const courseDummies = [2, 3, 4, 5, 6].map(c => (course === c ? 1 : 0));
    return [
      ...courseDummies,
      norm(ranks.st[i]),
      norm(ranks.kimarite[i]),
      norm(ranks.ren[i]),
      norm(ranks.motor[i]),
      norm(ranks.exhibit[i]),
    ];
  });
}

const FEATURE_NAMES = ['course2', 'course3', 'course4', 'course5', 'course6', 'st', 'kimarite', 'ren', 'motor', 'exhibit'];

module.exports = { buildFeatures, FEATURE_NAMES };
