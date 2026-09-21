(async () => {
  'use strict';

  const VERSION = 'garon-boatcast-bm/0.2.0';
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const clean = value => String(value ?? '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
  const lines = value => String(value ?? '').split(/\r?\n/).map(clean).filter(Boolean);

  if (location.hostname !== 'race.boatcast.jp') {
    alert('BOATCASTのレース画面（race.boatcast.jp）で実行してください。');
    return;
  }

  const button = name => [...document.querySelectorAll('button')]
    .find(el => clean(el.innerText) === name && el.offsetParent !== null);

  async function open(name, settleMs = 900) {
    const el = button(name);
    if (!el) throw new Error('ボタンが見つかりません: ' + name);
    el.click();
    await wait(settleMs);
  }

  async function waitForSection(maxMs = 6000, needTable = true) {
    const started = Date.now();
    let previous = '';
    let stableCount = 0;
    while (Date.now() - started < maxMs) {
      const main = document.querySelector('main');
      const current = clean(main?.innerText || '');
      const waiting = /お待ちください|更新までしばらくお待ちください/.test(current);
      const hasTable = [...(main?.querySelectorAll('table') || [])].some(table => table.offsetParent !== null && table.querySelectorAll('tr').length > 1);
      stableCount = current === previous ? stableCount + 1 : 0;
      if (!waiting && (hasTable || (!needTable && stableCount >= 2))) return { loaded: true, waiting: false, hasTable };
      previous = current;
      await wait(350);
    }
    const finalText = clean(document.querySelector('main')?.innerText || '');
    return { loaded: false, waiting: /お待ちください|更新までしばらくお待ちください/.test(finalText), hasTable: false };
  }

  function tableMatrix(table) {
    return [...table.querySelectorAll('tr')].map(row =>
      [...row.querySelectorAll('th,td')].map(cell => {
        const text = clean(cell.innerText);
        const alts = [...cell.querySelectorAll('img[alt]')].map(img => clean(img.alt)).filter(Boolean);
        return clean([text, ...alts].filter(Boolean).join(' '));
      })
    ).filter(row => row.some(Boolean));
  }

  function visibleTables() {
    return [...document.querySelectorAll('main table')]
      .filter(el => el.offsetParent !== null)
      .map(tableMatrix);
  }

  function visibleProfiles() {
    const seen = new Set();
    return [...document.querySelectorAll('main a[href*="toban="]')].map(link => {
      const registrationNo = new URL(link.href).searchParams.get('toban');
      return { registrationNo, name: clean(link.innerText), href: link.href };
    }).filter(item => item.registrationNo && !seen.has(item.registrationNo) && seen.add(item.registrationNo));
  }

  function pageMeta() {
    const text = document.querySelector('main')?.innerText || document.body.innerText;
    const race = text.match(/(?:^|\n)([1-9]|1[0-2])R\s*締切時刻\s*\n?([0-2]?\d:[0-5]\d)/m);
    const heading = [...document.querySelectorAll('main h1')].map(x => clean(x.innerText)).find(Boolean) || '';
    const event = [...document.querySelectorAll('main h2')].map(x => clean(x.innerText)).find(Boolean) || '';
    const sub = [...document.querySelectorAll('main p')].map(x => clean(x.innerText))
      .find(x => /^\d{2}\/\d{2}/.test(x)) || '';
    const jo = new URL(location.href).searchParams.get('jo') || '';
    const dateMatch = sub.match(/^(\d{2})\/(\d{2})/);
    const nowJst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const year = nowJst.getUTCFullYear();
    let raceDate = null;
    if (dateMatch) {
      const month = Number(dateMatch[1]);
      const day = Number(dateMatch[2]);
      const today = Date.UTC(year, nowJst.getUTCMonth(), nowJst.getUTCDate());
      const candidates = [year - 1, year, year + 1].map(y => ({ y, time: Date.UTC(y, month - 1, day) }));
      const nearest = candidates.sort((a, b) => Math.abs(a.time - today) - Math.abs(b.time - today))[0];
      raceDate = `${nearest.y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
    return {
      stadiumCode: jo.padStart(2, '0'),
      stadiumName: heading,
      raceNo: race ? Number(race[1]) : null,
      deadline: race ? race[2] : null,
      eventName: event,
      dayLabel: sub,
      raceDate,
      url: location.href
    };
  }

  // 実画面(2026-09-21確認): 3連単は table.odds3Tan が1着艇ごとに6個。先頭行=[1着艇番, 選手名(colspan2)]、
  // 以降の行=[2着艇番(rowspan), 3着艇番, オッズ] または [3着艇番, オッズ]。
  function parseOdds3tFromDom() {
    const out = {};
    for (const table of document.querySelectorAll('main table.odds3Tan')) {
      if (table.offsetParent === null) continue;
      const rows = [...table.querySelectorAll('tr')];
      const first = Number(clean(rows[0]?.children[0]?.innerText));
      if (!(first >= 1 && first <= 6)) continue;
      let second = null;
      for (const row of rows.slice(1)) {
        const cells = [...row.children].map(c => clean(c.innerText));
        let third, price;
        if (cells.length >= 3) { second = Number(cells[0]); third = Number(cells[1]); price = cells[2]; }
        else { third = Number(cells[0]); price = cells[1]; }
        const odds = Number(String(price ?? '').replace(/,/g, ''));
        if (second >= 1 && second <= 6 && third >= 1 && third <= 6 && Number.isFinite(odds) && odds > 0) out[`${first}-${second}-${third}`] = odds;
      }
    }
    return out;
  }

  const payload = {
    schema: 'garon.boatcast.race.v1',
    extractorVersion: VERSION,
    capturedAt: new Date().toISOString(),
    source: 'BOATCAST',
    meta: pageMeta(),
    sections: {},
    odds3t: {},
    warnings: []
  };

  // BOATCASTから取るのは「当日にしか分からない情報」だけ。過去成績(枠番別過去10走・得点率早見・モーター履歴・全国/当地3節・票数)は
  // GARONデータバンク側で賄うので取らない。
  const jobs = [
    ['出走表', '選手成績', '選手成績'],
    ['出走表', '節間成績', '節間成績'],
    ['直前情報', null, '直前情報'],
    ['直前情報', 'スタート展示', 'スタート展示'],
    ['直前情報', 'オリジナル展示データ', 'オリジナル展示データ']
  ];

  for (const [parent, child, sectionName] of jobs) {
    try {
      if (parent) await open(parent, 350);
      if (child) await open(child, child === 'オリジナル展示データ' ? 1800 : 700);
      const loadState = await waitForSection();
      payload.sections[sectionName] = {
        tables: visibleTables(),
        profiles: visibleProfiles(),
        loadState,
        text: clean(document.querySelector('main')?.innerText || '')
      };
      if (!loadState.loaded) payload.warnings.push(loadState.waiting ? `${sectionName}: まだ公開されていません（展示が終わってからもう一度実行してください）` : `${sectionName}: データ待機が解消しませんでした`);
    } catch (error) {
      payload.warnings.push(`${sectionName}: ${error.message}`);
    }
  }

  try {
    await open('オッズ', 500);
    const three = button('3連単');
    if (three) three.click();
    let loadState = { loaded: false };
    for (let i = 0; i < 20; i++) {
      await wait(400);
      payload.odds3t = parseOdds3tFromDom();
      if (Object.keys(payload.odds3t).length === 120) { loadState = { loaded: true }; break; }
    }
    // 表の中身は odds3t に全て入るので、セクションには読み込み状態だけ残す(送信サイズ削減)
    payload.sections['オッズ3連単'] = { tables: [], profiles: [], loadState };
    const oddsCount = Object.keys(payload.odds3t).length;
    if (oddsCount !== 120) {
      payload.warnings.push(`3連単オッズは${oddsCount}/120通りです`);
    } else {
      const overround = Object.values(payload.odds3t).reduce((sum, v) => sum + 1 / v, 0);
      if (!(overround > 1.15 && overround < 1.6)) payload.warnings.push(`3連単オッズの逆数合計が異常です(${overround.toFixed(3)}、通常は約1.3)`);
    }
  } catch (error) {
    payload.warnings.push(`オッズ: ${error.message}`);
  }

  payload.meta = { ...payload.meta, ...pageMeta() };
  let json = JSON.stringify(payload, null, 2);
  try { localStorage.setItem('garon_boatcast_last_export_v1', json); }
  catch (error) {
    payload.warnings.push(`localStorage保存失敗: ${error.message}`);
    json = JSON.stringify(payload, null, 2);
  }
  const old = document.getElementById('garon-boatcast-export');
  if (old) old.remove();
  const oddsCount = Object.keys(payload.odds3t).length;
  const ok = oddsCount === 120 && !payload.warnings.length;
  const panel = document.createElement('div');
  panel.id = 'garon-boatcast-export';
  panel.style.cssText = 'position:fixed;z-index:2147483647;top:12px;right:12px;width:min(92vw,520px);max-height:88vh;overflow:auto;background:#fff;color:#111;border:3px solid ' + (ok ? '#15803d' : '#b91c1c') + ';border-radius:10px;padding:12px;font:14px/1.45 sans-serif;box-shadow:0 8px 30px #0008';
  const title = document.createElement('b');
  const info = document.createElement('div');
  info.style.cssText = 'margin:8px 0;color:#b91c1c';
  info.textContent = payload.warnings.length ? payload.warnings.join(' / ') : '';
  const copy = document.createElement('button');
  copy.style.cssText = 'font-size:18px;padding:10px 18px;margin-right:8px';
  const doCopy = async () => {
    try { await navigator.clipboard.writeText(json); return true; } catch { return false; }
  };
  const showCopied = () => { title.textContent = 'コピー済み。Q画面に貼り付けてください（オッズ ' + oddsCount + '/120）'; copy.textContent = 'もう一度コピー'; };
  title.textContent = 'GARON BOATCAST抽出完了（オッズ ' + oddsCount + '/120）';
  copy.textContent = 'コピー';
  copy.onclick = async () => { if (await doCopy()) showCopied(); else alert('コピーできませんでした。'); };
  const close = document.createElement('button');
  close.textContent = '閉じる';
  close.style.cssText = 'font-size:18px;padding:10px 18px';
  close.onclick = () => panel.remove();
  panel.append(title, info, copy, close);
  document.body.appendChild(panel);
  if (await doCopy()) showCopied();
})().catch(error => alert('GARON BOATCAST抽出失敗: ' + error.message));
