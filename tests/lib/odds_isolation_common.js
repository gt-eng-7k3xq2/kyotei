'use strict';
/**
 * GARON 共通 オッズ隔離テストヘルパー (GARON-20260906-004 / A)
 *
 * 目的:
 *   GARON-20260906-001 (code/06_run_pipeline.js:51) と GARON-20260906-003
 *   (scenario_v2 code/t6_odds_isolation.js の runAll(mutateOdds) が引数を使わない)
 *   で、「破壊した値を実際には使っていない死んだテスト」が2回続けて発生した。
 *   本ヘルパーは「ハッシュが同じだった」ではなく
 *   「オッズ由来のキーを読んだ瞬間に例外が飛ぶ」ことで隔離を能動的に証明する。
 *
 * 提供するもの:
 *   1. DEFAULT_FORBIDDEN    … 予想層が触れてはならないキー名
 *   2. makeFailOnReadProxy  … 該当キーへの get/has/ownKeys アクセスで即例外を投げる深いProxy
 *   3. runIsolationSuite    … 任意の予想関数群 × 任意の入力群に対して一括実行し
 *                             実行件数・例外捕捉数・対象関数一覧を返す
 *   4. runMutationTest      … 「わざとオッズを読む不正実装」を通し、
 *                             上記スイートが必ずFAILを返すことを確認する
 *   5. scanSourceForOddsTokens … 予想エンジンのソース静的走査(補助証拠)
 *
 * 重要な設計:
 *   - テストが「実際に何件走ったか」を必ず返す。0件でPASSにならないよう
 *     runIsolationSuite は executedCalls===0 のとき ok:false を返す。
 *   - 例外はProxyが投げる専用クラス OddsAccessError のみを隔離違反として数える。
 *     それ以外の例外はテスト不成立(engineError)として別カウントし、PASSにしない。
 */

const DEFAULT_FORBIDDEN = [
  'odds', 'oddsmap', 'market', 'payout', 'haraimodoshi',
  'harai', 'haitou', 'haito', 'trueodds',
  'oddstiming', 'dividend', 'refund', 'ninki', 'popularity',
  'expectedvalue', 'roi'
];

class OddsAccessError extends Error {
  constructor(pathStr, key) {
    super('ODDS_ACCESS: forbidden key read at ' + pathStr + ' -> "' + key + '"');
    this.name = 'OddsAccessError';
    this.accessPath = pathStr;
    this.accessKey = String(key);
  }
}

function normKey(k) { return String(k).toLowerCase().replace(/[_\-\s]/g, ''); }

function makeMatcher(forbidden) {
  const set = new Set(forbidden.map(normKey));
  return function (key) {
    if (typeof key !== 'string') return false;
    const n = normKey(key);
    if (set.has(n)) return true;
    for (const f of set) {
      if (f.length >= 4 && n.indexOf(f) >= 0) return true;
    }
    return false;
  };
}

/**
 * オッズ関連キーを読んだ瞬間に OddsAccessError を投げる深いProxyを作る。
 */
function makeFailOnReadProxy(obj, opts) {
  opts = opts || {};
  const forbidden = opts.forbidden || DEFAULT_FORBIDDEN;
  const isBad = opts._matcher || makeMatcher(forbidden);
  const log = opts.log || [];
  const seen = opts._seen || new WeakMap();

  function wrap(target, pathStr) {
    if (target === null || typeof target !== 'object') return target;
    if (seen.has(target)) return seen.get(target);
    const handler = {
      get: function (t, key, recv) {
        if (isBad(key)) { log.push({ path: pathStr, key: String(key) }); throw new OddsAccessError(pathStr, key); }
        const v = Reflect.get(t, key, recv);
        if (typeof v === 'function') return v.bind(t);
        if (v !== null && typeof v === 'object') return wrap(v, pathStr + '.' + String(key));
        return v;
      },
      has: function (t, key) {
        if (isBad(key)) { log.push({ path: pathStr, key: String(key) }); throw new OddsAccessError(pathStr, key); }
        return Reflect.has(t, key);
      },
      ownKeys: function (t) {
        const ks = Reflect.ownKeys(t);
        for (const k of ks) if (isBad(k)) { log.push({ path: pathStr, key: String(k) }); throw new OddsAccessError(pathStr, k); }
        return ks;
      },
      getOwnPropertyDescriptor: function (t, key) {
        if (isBad(key)) { log.push({ path: pathStr, key: String(key) }); throw new OddsAccessError(pathStr, key); }
        return Reflect.getOwnPropertyDescriptor(t, key);
      }
    };
    const p = new Proxy(target, handler);
    seen.set(target, p);
    return p;
  }
  return wrap(obj, opts.pathStr || 'input');
}

/** 入力から許可キー以外を物理的に除外した新しいオブジェクトを作る */
function sanitizeInput(src, allowedKeys) {
  const out = {};
  for (const k of allowedKeys) if (Object.prototype.hasOwnProperty.call(src, k)) out[k] = src[k];
  return out;
}

/**
 * 隔離スイート本体。
 * spec.suiteName / spec.targets[{name,fn}] / spec.inputs[] / spec.allowedKeys[]
 * spec.forbidden[] / spec.expectFail(boolean)
 */
function runIsolationSuite(spec) {
  const targets = spec.targets || [];
  const inputs = spec.inputs || [];
  const forbidden = spec.forbidden || DEFAULT_FORBIDDEN;
  const allowed = spec.allowedKeys || null;
  const matcher = makeMatcher(forbidden);

  const report = {
    suiteName: spec.suiteName || 'unnamed',
    forbiddenKeys: forbidden.slice(),
    allowedInputKeys: allowed ? allowed.slice() : null,
    targetsInspected: targets.map(function (t) { return t.name; }),
    inputsCount: inputs.length,
    executedCalls: 0,
    oddsAccessExceptions: 0,
    oddsAccessSamples: [],
    engineErrors: 0,
    engineErrorSamples: [],
    inputKeyViolations: 0,
    inputKeyViolationSamples: [],
    perTarget: {},
    ok: false
  };

  for (let i = 0; i < inputs.length; i++) {
    const ks = Object.keys(inputs[i]);
    for (const k of ks) {
      if (matcher(k) || (allowed && allowed.indexOf(k) < 0)) {
        report.inputKeyViolations++;
        if (report.inputKeyViolationSamples.length < 5) report.inputKeyViolationSamples.push({ index: i, key: k });
      }
    }
  }

  for (const t of targets) {
    const pt = { executed: 0, oddsAccessExceptions: 0, engineErrors: 0, outputs: 0 };
    for (let i = 0; i < inputs.length; i++) {
      const log = [];
      const proxied = makeFailOnReadProxy(inputs[i], { forbidden: forbidden, _matcher: matcher, log: log, pathStr: 'input[' + i + ']' });
      pt.executed++; report.executedCalls++;
      try {
        const out = t.fn(proxied, i);
        if (out !== undefined) pt.outputs++;
      } catch (e) {
        if (e && e.name === 'OddsAccessError') {
          pt.oddsAccessExceptions++; report.oddsAccessExceptions++;
          if (report.oddsAccessSamples.length < 10) report.oddsAccessSamples.push({ target: t.name, index: i, path: e.accessPath, key: e.accessKey });
        } else {
          pt.engineErrors++; report.engineErrors++;
          if (report.engineErrorSamples.length < 10) report.engineErrorSamples.push({ target: t.name, index: i, message: String(e && e.message).slice(0, 300) });
        }
      }
    }
    report.perTarget[t.name] = pt;
  }

  if (spec.expectFail) {
    report.mode = 'expectFail';
    report.ok = report.executedCalls > 0 && report.oddsAccessExceptions > 0;
  } else {
    report.mode = 'expectPass';
    report.ok = report.executedCalls > 0 &&
      report.oddsAccessExceptions === 0 &&
      report.engineErrors === 0 &&
      report.inputKeyViolations === 0;
  }
  return report;
}

/** mutation test: わざとオッズを読む不正実装が必ず検知されることを確認する */
function runMutationTest(spec) {
  const mutants = spec.mutants || [];
  const results = [];
  for (const m of mutants) {
    const r = runIsolationSuite({
      suiteName: 'mutation:' + m.name,
      targets: [{ name: m.name, fn: m.fn }],
      inputs: spec.inputs, allowedKeys: spec.allowedKeys,
      forbidden: spec.forbidden, expectFail: true
    });
    results.push({
      mutantName: m.name, detected: r.ok, executedCalls: r.executedCalls,
      oddsAccessExceptions: r.oddsAccessExceptions, engineErrors: r.engineErrors,
      sample: r.oddsAccessSamples[0] || null
    });
  }
  return { mutantsTested: results.length, allDetected: results.length > 0 && results.every(function (x) { return x.detected; }), results: results };
}

/** 補助: 予想エンジンのソース静的走査 */
function scanSourceForOddsTokens(sourceText, forbidden) {
  const list = forbidden || DEFAULT_FORBIDDEN;
  const hits = {};
  for (const f of list) {
    if (!/^[a-z0-9]+$/i.test(f)) continue; // 英数字のトークンのみ対象(正規表現エスケープ不要)
    const re = new RegExp(f, 'gi');
    const m = sourceText.match(re);
    if (m && m.length) hits[f] = m.length;
  }
  return hits;
}

module.exports = {
  DEFAULT_FORBIDDEN: DEFAULT_FORBIDDEN, OddsAccessError: OddsAccessError,
  makeFailOnReadProxy: makeFailOnReadProxy, sanitizeInput: sanitizeInput,
  runIsolationSuite: runIsolationSuite, runMutationTest: runMutationTest,
  scanSourceForOddsTokens: scanSourceForOddsTokens
};
