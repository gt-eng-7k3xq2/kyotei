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
  // 2026-09-07追加(GARON-20260907-003、Q v2統合): qv2*ヘルパー群はgenerateQBetsから呼ばれる
  // ため、generateQBetsより前に配列へ入れる必要はない(関数宣言はホイスティングされるため実行順は
  // 問題ないが、可読性のためヘルパー→本体の順で記載する)。
  'qv2GetPath',
  'qv2BaseFeatures',
  'qv2Onehot',
  'qv2Concat',
  'qv2WalkTree',
  'qv2PredictRaw',
  'qv2SoftmaxTemp',
  'qv2PredictProbaTemp',
  'qv2ComputeRaceProbabilities',
  'qv2SelectPoints',
  'qv2GenerateBets',
  'generateQBetsLegacyV1',
  'generateQBets',
  // 2026-09-08追加(展開コメント用「確定事実」抽出、CEO指示): 予測確率・買い目選定には
  // 一切触れず、result._dbg(選択済み買い目・確率map)とevaluateBoatSupport/
  // identifyAttackCandidates/identifyBenefitBoatの出力だけを加工する追加関数群。
  'buildBetOrderFacts',
  'buildSecondCandidateRanking',
  'buildBetBranches',
  'reconstructBetsFromBranches',
  'buildBetCommentFacts',
  'buildRoleCandidates',
  'garonSurname',
  'garonBoatLabel',
  // parseData/extractOddsMap/compressBetsSGはBM生テキストからの一連の再現テスト
  // (verify_races.js方式)用。抽出情報の検証自体はboats/oddsMap経由でも可能。
  'parseData',
  'extractOddsMap',
  'compressBetsSG',
];

// identifyAttackCandidates()の外側(トップレベル)で定義されたconst。関数抽出には含まれないため
// 別途抜き出す必要がある(2026-08-27、研究部隊GARON-20260827-001が発見したバグの修正。
// tests/q_engine_entry_backtest.jsが全件ReferenceErrorで機能停止していた)。
// Q_ENGINE_VERSIONは2026-08-30追加(generateQBets内のgap<0見送りルール導入に伴う版数)。
// Q_V2_TREESは2026-09-07追加(GARON-20260907-003、Q v2の木構造モデルデータ、約700KB)。
// GARON_*は2026-09-08追加(buildBetCommentFacts/buildRoleCandidatesがgaronBoatLabel経由で必要とする)。
const CONST_NAMES = ['ATTACK_MIN_GAP', 'Q_ENGINE_VERSION', 'Q_V2_TREES', 'COMMENT_FACTS_VERSION', 'GARON_COURSE_KIMARITE', 'GARON_LABEL_CIRCLED', 'GARON_ONE_CHAR_SURNAMES', 'GARON_THREE_CHAR_SURNAMES', 'GARON_NAME_OVERRIDES'];

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
