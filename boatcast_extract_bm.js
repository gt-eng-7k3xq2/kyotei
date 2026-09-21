(async () => {
  'use strict';

  const VERSION = 'garon-boatcast-bm/0.1.0';
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

  function parseOdds3t(text) {
    const ls = lines(text);
    let i = ls.findIndex(x => x === '3連単');
    if (i < 0) return {};
    i += 1;
    const out = {};
    for (let first = 1; first <= 6; first++) {
      while (i < ls.length && !new RegExp(`^${first}\\s+`).test(ls[i])) i++;
      if (i >= ls.length) break;
      i++;
      for (const second of [1,2,3,4,5,6].filter(x => x !== first)) {
        while (i < ls.length && ls[i] !== String(second)) i++;
        if (i >= ls.length) break;
        i++;
        for (const third of [1,2,3,4,5,6].filter(x => x !== first && x !== second)) {
          if (ls[i] !== String(third)) break;
          const price = Number((ls[i + 1] || '').replace(/,/g, ''));
          if (Number.isFinite(price)) out[`${first}-${second}-${third}`] = price;
          i += 2;
        }
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

  const jobs = [
    ['出走表', '選手成績', '選手成績'],
    ['出走表', '節間成績', '節間成績'],
    ['出走表', 'モーター履歴', 'モーター履歴'],
    ['出走表', '全国成績過去3節', '全国成績過去3節'],
    ['出走表', '当地成績過去3節', '当地成績過去3節'],
    [null, '枠番別過去10走', '枠番別過去10走'],
    [null, '得点率早見', '得点率早見'],
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
      if (!loadState.loaded) payload.warnings.push(`${sectionName}: データ待機が解消しませんでした`);
    } catch (error) {
      payload.warnings.push(`${sectionName}: ${error.message}`);
    }
  }

  try {
    await open('オッズ', 500);
    const three = button('3連単');
    if (three) {
      three.click();
      await waitForSection(6000, false);
    }
    const oddsText = document.querySelector('main')?.innerText || '';
    payload.sections['オッズ3連単'] = { tables: visibleTables(), profiles: visibleProfiles(), text: clean(oddsText) };
    payload.odds3t = parseOdds3t(oddsText);
    if (Object.keys(payload.odds3t).length !== 120) {
      payload.warnings.push(`3連単オッズは${Object.keys(payload.odds3t).length}/120通りです`);
    } else {
      const overround = Object.values(payload.odds3t).reduce((sum, v) => sum + 1 / v, 0);
      if (!(overround > 1.15 && overround < 1.6)) payload.warnings.push(`3連単オッズの逆数合計が異常です(${overround.toFixed(3)}、通常は約1.3)`);
    }
  } catch (error) {
    payload.warnings.push(`オッズ: ${error.message}`);
  }

  try {
    await open('票数', 500);
    const vote3t = button('3連単');
    if (vote3t) {
      vote3t.click();
      await waitForSection(6000, false);
    }
    payload.sections['票数3連単'] = {
      tables: visibleTables(),
      profiles: visibleProfiles(),
      text: clean(document.querySelector('main')?.innerText || '')
    };
  } catch (error) {
    payload.warnings.push(`票数3連単（任意）: ${error.message}`);
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
  const panel = document.createElement('div');
  panel.id = 'garon-boatcast-export';
  panel.style.cssText = 'position:fixed;z-index:2147483647;top:12px;right:12px;width:min(92vw,520px);max-height:88vh;overflow:auto;background:#fff;color:#111;border:3px solid #075985;border-radius:10px;padding:12px;font:14px/1.45 sans-serif;box-shadow:0 8px 30px #0008';
  const title = document.createElement('b');
  title.textContent = `GARON BOATCAST抽出完了（オッズ ${Object.keys(payload.odds3t).length}/120）`;
  const info = document.createElement('div');
  info.textContent = payload.warnings.length ? payload.warnings.join(' / ') : '警告なし';
  info.style.cssText = 'margin:8px 0;color:#b91c1c';
  const copy = document.createElement('button');
  copy.textContent = 'JSONをコピー';
  copy.onclick = async () => { await navigator.clipboard.writeText(json); copy.textContent = 'コピー済み'; };
  const download = document.createElement('button');
  download.textContent = 'JSONを保存';
  download.style.marginLeft = '8px';
  download.onclick = () => {
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `garon_boatcast_${payload.meta.raceDate || 'date'}_${payload.meta.stadiumCode || 'jo'}_${payload.meta.raceNo || 'R'}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const close = document.createElement('button');
  close.textContent = '閉じる';
  close.style.marginLeft = '8px';
  close.onclick = () => panel.remove();
  const share = document.createElement('button');
  share.textContent = 'iPhoneで共有';
  share.style.marginLeft = '8px';
  share.onclick = async () => {
    if (!navigator.share) return alert('このブラウザは共有に対応していません。コピーまたは保存を使ってください。');
    const file = new File([json], `garon_boatcast_${payload.meta.raceDate || 'date'}_${payload.meta.stadiumCode || 'jo'}_${payload.meta.raceNo || 'R'}.json`, { type: 'application/json' });
    await navigator.share({ title: 'GARON BOATCAST抽出', files: [file] });
  };
  panel.append(title, info, copy, download, share, close);
  document.body.appendChild(panel);
})().catch(error => alert('GARON BOATCAST抽出失敗: ' + error.message));
