const $ = id => document.getElementById(id);
const load = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(null)) });
const store = o => chrome.storage.local.set(o);
let s = { ...DEFAULTS };
let account = { state: 'checking' }; // checking | ok | none | noTab | reload
const locale = () => (s.lang === 'uk' ? 'uk-UA' : 'ru-RU');
const day = ts => new Date(ts).toLocaleDateString(locale(), { day: 'numeric', month: 'long' });
// Status params carry raw timestamps in `date`; they are formatted here, in the popup's language.
const tr = (k, p) => t(s.lang, k, p && typeof p.date === 'number' ? { ...p, date: day(p.date) } : p);
const RANKS = ['E', 'D', 'C', 'B', 'A']; // only these ranks can be bought with shards
const FRESH_MS = 30 * 60e3;      // cached card data younger than this is shown without asking the site
const KEEP_MS = 30 * 864e5;      // cache entries unused this long are dropped

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter(k => k != null && k !== false));
  return e;
}
function icon(name, cls = 'i') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}
const cover = (src, cls = 'cover') => (src ? el('img', { className: cls, src, alt: '' }) : el('span', { className: cls }));
const track = pct => el('div', { className: 'track' }, el('i', { style: `width:${Math.max(0, Math.min(100, pct))}%` }));
const fmt = n => Number(n || 0).toLocaleString(locale());
const dur = sec => formatDuration(s.lang, sec);
function progressOf(q) {
  const st = titleState(q);
  if (st === 'complete' || st === 'enough') return 100;
  return q.need ? (100 * (q.balance || 0)) / q.need : 0;
}

// --- talking to the site through a MangaLib tab (only a page has the user's login) ---
async function siteTab() {
  const tabs = await chrome.tabs.query({ url: 'https://mangalib.me/*' });
  return tabs.find(x => x.id === s.farmTabId) || tabs.find(x => x.status === 'complete') || tabs[0];
}
async function proxy(msg) {
  const tab = await siteTab();
  if (!tab) throw Object.assign(new Error('noTab'), { code: 'noTab' });
  try { return await chrome.tabs.sendMessage(tab.id, msg); }
  catch {
    // Tab opened before the extension was installed or reloaded: inject the scripts once.
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['shared.js', 'content.js'] }); }
    catch { throw Object.assign(new Error('reload'), { code: 'reload' }); }
    return chrome.tabs.sendMessage(tab.id, msg);
  }
}
async function checkAccount() {
  try {
    const me = await proxy({ type: 'auth' });
    if (me?.loggedIn || !me?.error) {
      // A definite answer (logged in, or logged out): the service worker swaps per-account data if it changed.
      await chrome.runtime.sendMessage({ type: 'account', account: me?.loggedIn ? { id: me.id, name: me.name } : null });
      account = me?.loggedIn ? { state: 'ok', name: me.name, id: me.id } : { state: 'none' };
    } else if (account.state === 'checking') account = { state: 'reload' }; // site didn't answer and nothing is known yet
    if (account.state === 'ok') proxy({ type: 'weekly' }).catch(() => null); // stored by the content script
  } catch (e) { account = { state: e.code || 'reload' }; }
  renderAccount();
  renderHero();
  if (!$('add').hidden && folderId == null) loadFolders(); // the Add tab was opened while the check ran
}
// The account the extension last saw, shown at once while the real check runs.
function accountFromStorage() {
  if (!['checking', 'ok', 'none'].includes(account.state) || !s.account) return;
  account = s.account.id ? { state: 'ok', id: s.account.id, name: s.account.name } : { state: 'none' };
}

// --- cache: card data per title and folder lists survive between popup openings ---
// Lists render instantly from the cache; only missing or stale titles are asked from the site, in the background.
let cache = { titles: {}, folders: {} }, cacheTimer;
const cacheReady = chrome.storage.local.get('cache').then(r => {
  cache = { titles: {}, folders: {}, ...r.cache };
  const old = Date.now() - KEEP_MS;
  for (const [k, v] of Object.entries(cache.titles)) if (v.at < old) delete cache.titles[k];
});
function saveCache() { clearTimeout(cacheTimer); cacheTimer = setTimeout(() => store({ cache }), 300); }
const hasCards = e => (e?.raw?.exchange_options || []).some(o => o.total_cards_count > 0);
// Summary for the ranks selected right now, so changing ranks needs no new requests.
const view = e => (e?.raw ? { ...titleSummary(e.raw, s.ranks), chapters: e.chapters, pagesPerCh: e.pagesPerCh } : null);
const cachedView = slug => view(cache.titles[slug]);
const isStale = slug => {
  const e = cache.titles[slug];
  return !e?.raw || Date.now() - e.at >= FRESH_MS || (hasCards(e) && e.chapters == null);
};
function putRaw(slug, raw) {
  cache.titles[slug] = { ...cache.titles[slug], raw, at: Date.now() };
  saveCache();
}
async function cardInfo(slug, { withPages = false } = {}) {
  await cacheReady;
  const hit = cache.titles[slug];
  if (!isStale(slug) && (!withPages || hit.pagesPerCh || !hasCards(hit))) return view(hit);
  const r = await proxy({ type: 'titleInfo', slug, withPages }).catch(() => null);
  if (!r?.ok) return view(hit);
  cache.titles[slug] = { ...hit, ...r.data, at: Date.now() };
  saveCache();
  return view(cache.titles[slug]);
}
async function refreshTitle(slug) {
  const info = await cardInfo(slug, { withPages: true });
  if (!info) return;
  const { queue } = await load();
  await store({ queue: queue.map(q => (q.slug === slug ? { ...q, ...info, done: ['complete', 'enough', 'noCards'].includes(titleState(info)) } : q)) });
}

// --- rendering ---
function applyStatic() {
  document.documentElement.lang = s.lang === 'uk' ? 'uk' : 'ru';
  for (const e of document.querySelectorAll('[data-i18n]')) e.textContent = tr(e.dataset.i18n);
  $('search').placeholder = tr('search');
}

function renderAccount() {
  const a = $('account');
  a.className = 'who' + (account.state === 'ok' || account.state === 'checking' ? '' : ' off');
  if (account.state === 'checking') return a.replaceChildren(el('span', { className: 'sk sk-pill', ariaLabel: tr('checkingAccount') }));
  if (account.state === 'ok') {
    return a.replaceChildren(el('span', { className: 'ava', textContent: (account.name || '?')[0].toUpperCase(), ariaHidden: 'true' }), el('span', { textContent: account.name, title: tr('loggedAs', { name: account.name }) }));
  }
  const open = el('a', { href: '#', textContent: account.state === 'none' ? tr('login') : tr('openSite') });
  open.onclick = e => { e.preventDefault(); chrome.tabs.create({ url: 'https://mangalib.me/ru' }); };
  a.replaceChildren(account.state === 'reload' ? el('span', { textContent: tr('reloadTab') }) : open);
}

function blockReason() {
  if (account.state === 'none') return tr('notLogged');
  if (account.state === 'noTab') return tr('noTab');
  if (account.state === 'reload') return tr('reloadTab');
  return null;
}

const liveOf = q => (s.running && s.live?.slug === q.slug && s.live.total ? s.live : null);

function renderHero() {
  const hero = $('hero');
  const left = s.queue.filter(q => !q.done);
  if (!s.queue.length) {
    const go = el('button', { className: 'cta', onclick: () => $('tab-add').click() }, icon('plus'), tr('addTitles'));
    const event = ['st_account_switched', 'st_logged_out'].includes(s.status?.k) && Date.now() - s.status.at < 5 * 60e3;
    return hero.replaceChildren(el('p', { className: 'lead', textContent: tr('emptyHero') }), go,
      event ? el('div', { className: 'note status', role: 'status', textContent: tr(s.status.k, s.status.p) }) : null);
  }

  const item = (s.running && s.queue.find(q => q.slug === s.current)) || left[0];
  const pace = paceOf(s);
  const total = etaSeconds(s, left);
  const live = item && liveOf(item);

  const top = item
    ? el('div', { className: 'now' },
        cover(item.cover),
        el('div', { className: 'now-meta' },
          el('div', { className: 'eyebrow' + (s.running ? ' live' : ''), textContent: s.running ? tr('nowReading') : tr('nextUp') }),
          el('div', { className: 'now-name', textContent: item.name, title: item.name }),
          live && el('div', { className: 'eyebrow num', textContent: tr('liveLine', { ch: live.chapter, p: live.page, n: live.total }) }),
          el('div', { className: 'shards num' }, icon('shard', 'i shard'),
            el('strong', { textContent: item.balance == null ? '…' : fmt(item.balance) }), ` / ${item.need == null ? '…' : fmt(item.need)}`,
            item.total ? el('span', { className: 'dim', textContent: ` · ${tr('cards', { c: item.collected, t: item.total })}` }) : null)))
    : el('div', { className: 'now' }, el('div', { className: 'now-meta' }, el('div', { className: 'now-name', textContent: tr('allDone') })));

  // Pace of the current title: its own chapter length times the measured seconds per page.
  const pages = item?.pagesPerCh || s.stats?.pagesPerCh || AVG_PAGES;
  const chPerHour = 3600 / (pages * pace.secPerPage + CH_OVERHEAD_SEC + pace.breakPerCh);
  const fact = (label, value) => el('div', {}, el('dt', { textContent: label }), el('dd', { className: 'num', textContent: value }));
  const facts = el('dl', { className: 'facts' },
    fact(tr('remaining'), !left.length ? '—' : total == null ? '…' : dur(total)),
    fact(tr('paceLabel'), tr('chPerHour', { n: chPerHour.toFixed(1) })),
    fact(tr('weekLabel'), s.weekly ? `${fmt(s.weekly.remaining)} / ${fmt(s.weekly.limit)}` : `— / ${WEEKLY_READ_LIMIT}`));

  const cta = el('button', { id: 'toggle', className: 'cta' + (s.running ? ' stop' : '') });
  if (s.running) cta.append(icon('pause'), tr('stopFarm'));
  else if (account.state === 'checking') cta.append(el('span', { className: 'spin', ariaHidden: 'true' }), tr('checkingAccount'));
  else cta.append(icon('play'), tr('startFarm'), el('small', { className: 'num', textContent: `· ${tr('titles', { n: left.length })}` }));
  const reason = !s.running && blockReason();
  cta.disabled = !s.running && (account.state !== 'ok' || !left.length);
  cta.onclick = toggle;

  const accountEvent = ['st_account_switched', 'st_logged_out'].includes(s.status?.k) && Date.now() - s.status.at < 5 * 60e3;
  const note = (s.running || accountEvent) && s.status
    ? el('div', { className: 'note status', role: 'status', textContent: `${new Date(s.status.at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })} · ${tr(s.status.k, s.status.p)}` })
    : el('div', { className: 'note', textContent: reason || tr('windowNote') });
  const cycles = cyclesLeft(s, left);
  const laterNote = cycles > 0 && el('div', { className: 'note warn', textContent: tr('laterNote', { n: cycles, d: Math.round((s.cooldownSec || COOLDOWN_SEC) / 86400) }) });

  hero.replaceChildren(...[top, item ? track(progressOf(item)) : null, facts, laterNote, cta, note].filter(Boolean));
}

// One line describing where a title stands: complete, enough shards, or what is left and how long.
function titleLine(q, { withEta = true } = {}) {
  const sub = el('div', { className: 'row-sub num' });
  const st = titleState(q);
  const cards = q.total ? tr('cards', { c: q.collected, t: q.total }) : null;
  if (st === 'noCards') sub.append(tr('noCards'));
  else if (st === 'complete') sub.append(icon('check', 'i tick'), tr('stComplete'));
  else if (st === 'enough') sub.append(icon('shard', 'i shard'), `${tr('stEnough')} · ${cards}`);
  else if (st === 'unknown') sub.append('…');
  else if (st === 'cooldown') sub.append(tr('stCooldown', { date: q.cooldownUntil }), cards ? ` · ${cards}` : '');
  else {
    const live = liveOf(q);
    const eta = withEta ? etaSeconds(s, q) : null;
    sub.append(icon('shard', 'i shard'), live
      ? `${tr('liveLine', { ch: live.chapter, p: live.page, n: live.total })} · ${dur(eta)}`
      : [cards, `${fmt(q.balance)} / ${fmt(q.need)}`, eta != null && tr('titleEta', { t: dur(eta) })].filter(Boolean).join(' · '));
    if (q.eligible != null && q.chapters) sub.title = tr('payNow', { e: q.eligible, c: q.chapters - 1 });
  }
  return sub;
}

function renderQueue() {
  $('queueCount').textContent = s.queue.length || '';
  const list = $('queueList');
  if (!s.queue.length) return list.replaceChildren(el('li', { className: 'muted', textContent: tr('emptyQueue') }));
  const rows = s.queue.map((q, i) => {
    const move = async d => { const queue = [...s.queue]; [queue[i], queue[i + d]] = [queue[i + d], queue[i]]; await store({ queue }); };
    const tools = el('div', { className: 'tools' },
      el('button', { className: 'ghost', disabled: i === 0, ariaLabel: tr('up'), title: tr('up'), onclick: () => move(-1) }, icon('up')),
      el('button', { className: 'ghost', disabled: i === s.queue.length - 1, ariaLabel: tr('down'), title: tr('down'), onclick: () => move(1) }, icon('down')),
      el('button', { className: 'ghost remove', ariaLabel: tr('remove'), title: tr('remove'), onclick: () => store({ queue: s.queue.filter(x => x.slug !== q.slug) }) }, icon('x')));
    const current = s.running && s.current === q.slug;
    return el('li', { className: 'row' + (q.done ? ' done' : '') + (current ? ' current' : '') },
      cover(q.cover),
      el('div', { className: 'row-meta' }, el('div', { className: 'row-name', textContent: q.name, title: q.name }), titleLine(q), track(progressOf(q))),
      tools);
  });
  // Fastest first: finishes whole collections sooner. Finished titles go last.
  const sortable = s.queue.filter(q => !q.done).length > 1;
  const sortBtn = sortable && el('li', { className: 'list-tools' }, el('button', { className: 'soft', onclick: sortQueue }, icon('up'), tr('sortQueue')));
  list.replaceChildren(...[sortBtn, ...rows].filter(Boolean));
}
async function sortQueue() {
  const key = q => (q.done ? Infinity : etaSeconds(s, q) ?? Infinity);
  await store({ queue: [...s.queue].sort((a, b) => key(a) - key(b)) });
}

function chipGroup(container, options, isOn, onPick, cls = 'chip') {
  container.replaceChildren(...options.map(([value, label, extra]) => {
    const b = el('button', { className: typeof cls === 'function' ? cls(value) : cls, onclick: () => onPick(value) }, label, extra);
    b.setAttribute('aria-pressed', String(isOn(value)));
    return b;
  }));
}

function renderSettings() {
  chipGroup($('speeds'), ['slow', 'normal', 'fast', 'custom'].map(v => [v, tr(v)]), v => s.speed === v, speed =>
    store(speed === 'custom' ? { speed } : { speed, ...PRESETS[speed], ...freshPace() }));
  $('speedHint').textContent = tr('hint_' + s.speed);
  for (const k of NUMBER_FIELDS) if (document.activeElement !== $(k)) $(k).value = shown(k);
  $('paceGrid').classList.toggle('preset', s.speed !== 'custom');
  for (const [id, units] of [['pageUnit', ['ms', 's', 'min']], ['breakUnit', ['s', 'min']]]) {
    $(id).replaceChildren(...units.map(u => el('option', { value: u, textContent: tr('unit_' + u), selected: s[id] === u })));
  }
  chipGroup($('ranks'), RANKS.map(r => [r, r]), r => s.ranks.includes(r), async r => {
    const ranks = s.ranks.includes(r) ? s.ranks.filter(x => x !== r) : [...s.ranks, r];
    if (!ranks.length) return;
    await store({ ranks });
    s.ranks = ranks;
    for (const q of s.queue) await refreshTitle(q.slug); // from the cache: raw data covers every rank
    if (folderId != null) loadBookmarks();
  }, r => 'rank ' + r);
  $('ranksSL').textContent = tr('ranksSL');
  chipGroup($('autobuy'), [[true, tr('on')], [false, tr('off')]], v => !!s.autoBuy === v, autoBuy => store({ autoBuy }));
  chipGroup($('langs'), [['ru', 'Русский'], ['uk', 'Українська']], l => s.lang === l, lang => store({ lang }));
  chipGroup($('notify'), [[true, tr('on')], [false, tr('off')]], v => (s.notify !== false) === v, notify => store({ notify }));
  $('versionLine').textContent = tr('version', { v: chrome.runtime.getManifest().version });
}

// --- history: shards per day for two weeks, totals, and the cards obtained ---
const shortDay = d => d.toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
function renderHistory() {
  const h = s.history || {};
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(Date.now() - (13 - i) * 864e5);
    return { d, ...(h[d.toLocaleDateString('sv')] || { shards: 0, chapters: 0, cards: 0 }) };
  });
  const week = days.slice(-7);
  const total = (arr, k) => arr.reduce((n, x) => n + (x[k] || 0), 0);
  const fact = (label, value) => el('div', {}, el('dt', { textContent: label }), el('dd', { className: 'num', textContent: fmt(value) }));
  $('hFacts').replaceChildren(
    fact(tr('hShards7'), total(week, 'shards')),
    fact(tr('hChapters7'), total(week, 'chapters')),
    fact(tr('hCards'), total(Object.values(h), 'cards')));

  const chart = $('hChart');
  const max = Math.max(...days.map(x => x.shards));
  if (!max && !Object.keys(h).length) { chart.replaceChildren(el('p', { className: 'muted', textContent: tr('hEmpty') })); }
  else {
    // One series, one hue: bar height = shards that day; the tallest bar carries its value, the rest show on hover.
    const tip = el('div', { className: 'tip', hidden: true });
    const label = x => tr('hBar', { date: shortDay(x.d), s: x.shards, c: x.chapters });
    const bars = el('div', { className: 'bars', role: 'list', ariaLabel: tr('hChart') }, ...days.map(x => {
      const pct = max ? (100 * x.shards) / max : 0;
      const col = el('div', { className: 'col', tabIndex: 0, role: 'listitem', ariaLabel: label(x) },
        el('i', { style: `height:${pct}%` }),
        x.shards === max && max ? el('em', { className: 'peak num', style: `--h:${pct}%`, textContent: x.shards }) : null);
      const show = () => {
        tip.textContent = label(x);
        tip.hidden = false;
        // Centered on the bar, but kept inside the chart so it never runs off the popup.
        const half = tip.offsetWidth / 2, center = col.offsetLeft + col.offsetWidth / 2;
        tip.style.left = `${Math.min(Math.max(center, half), chart.clientWidth - half)}px`;
      };
      col.onmouseenter = col.onfocus = show;
      col.onmouseleave = col.onblur = () => { tip.hidden = true; };
      return col;
    }));
    chart.replaceChildren(tip, bars, el('div', { className: 'axis num' }, el('span', { textContent: shortDay(days[0].d) }), el('span', { textContent: shortDay(days[13].d) })));
  }

  const log = s.cardLog || [];
  $('hCards').replaceChildren(...(log.length ? log.map(c => el('li', { className: 'row' },
    el('span', { className: 'rankdot ' + (c.rank || ''), textContent: c.rank || '?' }),
    el('div', { className: 'row-meta' },
      el('div', { className: 'row-name', textContent: c.name || tr('hCardUnknown', { title: c.title }), title: c.name || '' }),
      el('div', { className: 'row-sub', textContent: `${c.title} · ${new Date(c.at).toLocaleDateString(locale(), { day: 'numeric', month: 'long' })}` })))) :
    [el('li', { className: 'muted', textContent: tr('hNoCards') })]));
}

// --- update notice: latest GitHub release vs the installed version, checked twice a day ---
const RELEASES_API = 'https://api.github.com/repos/dtecx/shardy/releases/latest';
const RELEASE_URL = /^https:\/\/github\.com\/dtecx\/shardy\/releases\//;
async function checkUpdate() {
  const { update } = await chrome.storage.local.get('update');
  if (update && Date.now() - update.checkedAt < 12 * 3600e3) return;
  const r = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } }).then(x => (x.ok ? x.json() : null)).catch(() => null);
  await store({ update: { checkedAt: Date.now(), tag: r?.tag_name || update?.tag || null, url: r?.html_url || update?.url || null } });
}
function renderUpdate() {
  const u = s.update, a = $('update');
  const newer = u?.tag && RELEASE_URL.test(u.url || '') && compareVersions(u.tag, chrome.runtime.getManifest().version) > 0;
  a.hidden = !newer;
  if (!newer) return;
  a.href = u.url;
  a.replaceChildren(el('span', { textContent: tr('update', { v: u.tag.replace(/^v/, '') }) }), el('b', { textContent: `${tr('updateGet')} →` }));
}

// --- queue backup: export to a JSON file, import from one ---
$('exportQueue').onclick = () => {
  const data = { app: 'shardy', version: chrome.runtime.getManifest().version, exportedAt: new Date().toISOString(), ranks: s.ranks, queue: s.queue.map(({ slug, name, cover }) => ({ slug, name, cover })) };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = el('a', { href: url, download: `shardy-queue-${new Date().toLocaleDateString('sv')}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
// A file picker closes the popup, so importing happens in a full tab of the same page.
const isPopup = () => chrome.extension.getViews({ type: 'popup' }).includes(window);
$('importQueue').onclick = () => {
  if (!isPopup()) return $('importFile').click();
  chrome.tabs.create({ url: chrome.runtime.getURL('popup.html#import') });
  window.close();
};
// The file comes from outside: keep only well-formed titles from MangaLib, with known cover hosts.
function parseQueueFile(text) {
  let d;
  try { d = JSON.parse(text); } catch { return null; }
  if (d?.app !== 'shardy' || !Array.isArray(d.queue)) return null;
  const ok = [];
  for (const x of d.queue.slice(0, 500)) {
    if (typeof x?.slug !== 'string' || !/^\d+--[a-z0-9-]{1,200}$/i.test(x.slug)) continue;
    ok.push({
      slug: x.slug,
      name: typeof x.name === 'string' && x.name.trim() ? x.name.trim().slice(0, 200) : x.slug,
      cover: typeof x.cover === 'string' && x.cover.startsWith('https://cover.imglib.info/') ? x.cover : '',
    });
  }
  return { ok, skipped: d.queue.length - ok.length };
}
$('importFile').onchange = async () => {
  const file = $('importFile').files[0];
  $('importFile').value = '';
  if (!file) return;
  const parsed = file.size < 2e6 ? parseQueueFile(await file.text()) : null;
  if (!parsed) { $('importMsg').textContent = tr('importBad'); return; }
  const fresh = parsed.ok.filter(x => !inQueue(x.slug));
  $('importMsg').textContent = tr('importDone', { n: fresh.length, m: parsed.skipped + parsed.ok.length - fresh.length });
  await addTitles(fresh);
};

async function render() {
  s = await load();
  accountFromStorage();
  applyStatic();
  renderAccount();
  renderHero();
  renderQueue();
  renderSettings();
  renderHistory();
  renderUpdate();
}

// A new pace makes the measured page time stale; the ETA falls back to the estimate until re-measured.
const freshPace = () => ({ stats: { ...s.stats, secPerPage: null } });
// Page pause is stored in seconds and break length in minutes; the popup shows them in the unit the user picked.
const PER_SECOND = { ms: 1000, s: 1, min: 1 / 60 };
const TIMED = { pageMin: ['pageUnit', 1], pageMax: ['pageUnit', 1], breakMin: ['breakUnit', 60], breakMax: ['breakUnit', 60] };
const PAIRS = { pageMin: 'pageMax', breakEveryMin: 'breakEveryMax', breakMin: 'breakMax' };
const FLOOR = { pageMin: 0.1, pageMax: 0.1, breakEveryMin: 1, breakEveryMax: 1 }; // never below 100 ms per page
function shown(k) {
  const t = TIMED[k];
  if (!t) return s[k];
  const unit = s[t[0]] || 's';
  return +(s[k] * t[1] * PER_SECOND[unit]).toFixed(unit === 'ms' ? 0 : 2);
}
function stored(k, v) {
  const t = TIMED[k];
  return Math.max(FLOOR[k] || 0, t ? v / PER_SECOND[s[t[0]] || 's'] / t[1] : Math.round(v));
}
for (const k of NUMBER_FIELDS) $(k).onchange = () => {
  const v = stored(k, Math.max(0, +$(k).value || 0));
  const patch = { [k]: v, speed: 'custom', ...freshPace() };
  // Keep each range valid: raising the minimum above the maximum moves the maximum up, and the other way round.
  const max = PAIRS[k], min = Object.keys(PAIRS).find(m => PAIRS[m] === k);
  if (max && v > s[max]) patch[max] = v;
  if (min && v < s[min]) patch[min] = v;
  store(patch);
};
$('pageUnit').onchange = () => store({ pageUnit: $('pageUnit').value });
$('breakUnit').onchange = () => store({ breakUnit: $('breakUnit').value });

// --- adding titles ---
const titleFrom = m => ({ slug: m.slug_url, name: m.rus_name || m.name, cover: m.cover?.thumbnail || m.cover?.default || '' });
const inQueue = slug => s.queue.some(q => q.slug === slug);
async function addTitles(titles) {
  const { queue } = await load();
  const fresh = titles.filter(x => x.slug && !queue.some(q => q.slug === x.slug));
  $('msg').textContent = fresh.length ? tr('added', { n: fresh.length }) : tr('already');
  if (!fresh.length) return;
  await store({ queue: [...queue, ...fresh.map(x => ({ ...x, done: ['complete', 'enough', 'noCards'].includes(titleState(x)) }))] });
  for (const x of fresh) await refreshTitle(x.slug); // real page counts for the ETA
}

function slugFromUrl(url) {
  const u = new URL(url);
  if (u.host !== 'mangalib.me') return null;
  const m = u.pathname.match(/^\/\w{2}\/manga\/(\d+--[^/]+)/) || u.pathname.match(/^\/\w{2}\/(\d+--[^/]+)\/read\//);
  return m && m[1];
}
$('addCurrent').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const slug = tab?.url && slugFromUrl(tab.url);
  if (!slug) { $('msg').textContent = tr('notTitlePage'); return; }
  const r = await fetch(`https://api.imglib.info/api/manga/${slug}`, { headers: { 'Site-Id': '1', Accept: 'application/json' } }).then(x => x.json()).catch(() => null);
  addTitles([r?.data ? titleFrom(r.data) : { slug, name: slug }]);
};

function resultRow(title, control, sub) {
  return el('li', { className: 'row' + (['farm', 'unknown', 'cooldown'].includes(titleState(title)) ? '' : ' done') }, cover(title.cover),
    el('div', { className: 'row-meta' }, el('div', { className: 'row-name', textContent: title.name, title: title.name }), sub), control);
}
function addButton(title) {
  const b = el('button', { className: 'soft', disabled: inQueue(title.slug) }, icon(inQueue(title.slug) ? 'check' : 'plus'), tr('add'));
  b.onclick = async () => { b.disabled = true; await addTitles([title]); b.replaceChildren(icon('check'), tr('add')); };
  return b;
}

let searchTimer;
$('search').oninput = () => {
  clearTimeout(searchTimer);
  const q = $('search').value.trim();
  if (q.length < 2) return $('searchResults').replaceChildren();
  searchTimer = setTimeout(async () => {
    const r = await fetch(`https://api.imglib.info/api/manga?q=${encodeURIComponent(q)}&site_id[]=1`, { headers: { 'Site-Id': '1', Accept: 'application/json' } })
      .then(x => x.json()).catch(() => ({ data: [] }));
    const items = (r.data || []).slice(0, 10).map(titleFrom);
    $('searchResults').replaceChildren(...(items.length ? items.map(x => resultRow(x, addButton(x))) : [el('li', { className: 'muted', textContent: tr('nothing') })]));
  }, 350);
};

// --- smart bookmark import: every title in the folder is checked for cards before you pick ---
let folderId = null, bookmarkItems = [], bookmarkSort = 'fast', loadSeq = 0;
async function loadFolders() {
  if (account.state === 'checking') return $('folders').replaceChildren(...[0, 1, 2].map(() => el('span', { className: 'sk sk-chip' }))); // loads when the check ends
  if (account.state !== 'ok') { $('folders').replaceChildren(el('div', { className: 'hint', textContent: blockReason() || '' })); return; }
  await cacheReady;
  let folders = cache.folders._list || [];
  if (!folders.length) $('folders').replaceChildren(...[0, 1, 2].map(() => el('span', { className: 'sk sk-chip' })));
  const draw = () => chipGroup($('folders'), [{ id: 'shards', name: tr('myShards'), count: '' }, ...folders].map(f => [f.id, f.name, f.count !== '' && el('sup', { className: 'num', textContent: f.count })]), id => id === folderId, id => { folderId = id; draw(); loadBookmarks(); });
  chipGroup($('bmSort'), [['fast', tr('sortFast')], ['progress', tr('sortProgress')], ['name', tr('sortName')]], v => v === bookmarkSort, v => { bookmarkSort = v; renderBookmarks(); }, 'chip');
  $('bmSort').hidden = false;
  if (folders.length) { folderId = folders[0].id; draw(); loadBookmarks(); } // instant from cache
  const r = await proxy({ type: 'api', path: `bookmarks/folder/${account.id}` }).catch(() => null);
  if (!r?.data) return;
  folders = r.data.filter(f => f.count > 0).map(f => ({ id: f.id, name: f.name, count: f.count }));
  cache.folders._list = folders;
  saveCache();
  const first = folderId == null;
  if (first) folderId = folders[0]?.id ?? 'shards';
  draw();
  if (first) loadBookmarks();
}

// Titles of a folder: shown from the cache at once, then the list and stale card data are refreshed.
async function loadBookmarks() {
  const seq = ++loadSeq; // a newer folder click wins
  await cacheReady;
  const key = String(folderId);
  const show = titles => {
    bookmarkItems = titles.map(x => ({ ...x, ...(cachedView(x.slug) || {}) }));
    renderBookmarks();
  };
  if (cache.folders[key]) show(cache.folders[key].titles);
  else $('bookmarkList').replaceChildren(...[0, 1, 2].map(() => el('li', { className: 'row' }, el('span', { className: 'cover sk' }), el('div', { className: 'row-meta' }, el('span', { className: 'sk sk-line', style: 'width:55%' }), el('span', { className: 'sk sk-line', style: 'width:80%' })))));

  const titles = [];
  if (folderId === 'shards') {
    // Albums you already have shards in: card data comes with the list, so it fills the cache directly.
    for (let page = 1; page <= 10; page++) {
      const r = await proxy({ type: 'api', path: `profile/cards/shards?page=${page}&per_page=50&sort_by=new&sort_type=desc` }).catch(() => null);
      const data = r?.data || [];
      for (const a of data) {
        if (a.title?.model !== 'manga' || String(a.title?.site) !== '1') continue;
        const slug = a.title.slug_url || `${a.title.id}--${a.title.slug}`;
        putRaw(slug, { balance: { amount: a.balance?.amount ?? 0 }, exchange_options: a.exchange_options.map(o => ({ rank: o.rank, cost: o.cost, missing_cards_count: o.missing_cards_count, total_cards_count: o.total_cards_count })) });
        titles.push({ slug, name: a.title.rus_name || a.title.name, cover: a.title.cover?.thumbnail || a.title.cover?.default || '' });
      }
      if (data.length < 50) break;
    }
  } else {
    for (let page = 1; page <= 20; page++) {
      const r = await proxy({ type: 'api', path: `bookmarks?user_id=${account.id}&status=${folderId}&page=${page}` }).catch(() => null);
      const data = r?.data || [];
      titles.push(...data.filter(b => String(b.media?.site) === '1' && b.media?.slug_url).map(b => titleFrom(b.media)));
      if (data.length < 24) break;
    }
  }
  if (seq !== loadSeq) return;
  cache.folders[key] = { titles, at: Date.now() };
  saveCache();
  show(titles);

  // Only titles never checked or checked more than 30 minutes ago; never-checked ones first.
  const todo = bookmarkItems.filter(x => isStale(x.slug)).sort((a, b) => !!cache.titles[a.slug]?.raw - !!cache.titles[b.slug]?.raw);
  let done = 0;
  const status = () => { $('bmStatus').textContent = done < todo.length ? tr('checking', { d: done, n: todo.length }) : ''; };
  status();
  const worker = async () => {
    for (let x; (x = todo.shift()) && seq === loadSeq;) {
      Object.assign(x, (await cardInfo(x.slug)) || {});
      done++;
      status();
      renderBookmarks();
    }
  };
  const total = todo.length;
  await Promise.all([worker(), worker(), worker()]); // 3 at a time, gentle on the site
  if (seq === loadSeq && total) $('bmStatus').textContent = '';
}

function renderBookmarks() {
  const farmable = bookmarkItems.filter(x => ['farm', 'unknown', 'cooldown'].includes(titleState(x)));
  const ready = bookmarkItems.filter(x => !farmable.includes(x));
  const key = {
    fast: x => etaSeconds(s, x) ?? Infinity,
    progress: x => -(x.total ? x.collected / x.total : 0) - (x.need ? (x.balance || 0) / x.need : 0) / 100,
    name: null,
  }[bookmarkSort];
  farmable.sort(key ? (a, b) => key(a) - key(b) : (a, b) => a.name.localeCompare(b.name));

  const picked = new Set([...$('bookmarkList').querySelectorAll('input:checked')].map(b => b.value));
  const row = x => {
    const queued = inQueue(x.slug);
    const control = queued
      ? el('span', { className: 'badge', textContent: tr('inQueue') })
      : el('input', { type: 'checkbox', className: 'pick', value: x.slug, ariaLabel: x.name, checked: picked.has(x.slug), onchange: updateBookmarkButtons });
    return resultRow(x, control, titleLine(x));
  };
  const list = farmable.map(row);
  if (ready.length) {
    const details = el('details', { className: 'ready' }, el('summary', { textContent: tr('readyGroup', { n: ready.length }) }), el('ul', {}, ...ready.map(x => resultRow(x, null, titleLine(x)))));
    list.push(el('li', {}, details));
  }
  if (!bookmarkItems.length) list.push(el('li', { className: 'muted', textContent: tr('nothing') }));
  $('bookmarkList').replaceChildren(...list);
  updateBookmarkButtons();
}
const addableBookmarks = () => bookmarkItems.filter(x => ['farm', 'cooldown'].includes(titleState(x)) && !inQueue(x.slug));
function updateBookmarkButtons() {
  const n = $('bookmarkList').querySelectorAll('input:checked').length;
  $('addSelected').hidden = !n;
  $('addSelected').textContent = `${tr('addSelected')} · ${n}`;
  const all = addableBookmarks().length;
  $('addAll').hidden = !all;
  $('addAll').textContent = tr('addAllNeeded', { n: all });
}
const bySlug = slug => bookmarkItems.find(x => x.slug === slug);
$('addSelected').onclick = async () => { await addTitles([...$('bookmarkList').querySelectorAll('input:checked')].map(b => bySlug(b.value))); renderBookmarks(); };
$('addAll').onclick = async () => {
  // In the order shown, so "fastest first" also sets the queue order.
  const order = [...$('bookmarkList').querySelectorAll('input.pick')].map(b => b.value);
  await addTitles(addableBookmarks().sort((a, b) => order.indexOf(a.slug) - order.indexOf(b.slug)));
  renderBookmarks();
};

// --- tabs, start/stop ---
for (const tab of document.querySelectorAll('[role=tab]')) {
  tab.onclick = () => {
    for (const x of document.querySelectorAll('[role=tab]')) {
      x.setAttribute('aria-selected', String(x === tab));
      $(x.getAttribute('aria-controls')).hidden = x !== tab;
    }
    document.body.classList.toggle('compact', tab.id !== 'tab-queue');
    if (tab.id === 'tab-add' && !$('folders').children.length) loadFolders();
  };
}

async function toggle() {
  if (s.running) return store({ running: false, status: { k: 'st_stopped', at: Date.now() } });
  await checkAccount();
  if (account.state !== 'ok') return;
  $('toggle').disabled = true;
  for (const q of s.queue.filter(x => !x.done)) await refreshTitle(q.slug); // fresh numbers for the ETA
  if (!(await load()).queue.some(q => !q.done)) return render();
  await chrome.runtime.sendMessage({ type: 'start' });
}

chrome.storage.onChanged.addListener(async changes => {
  if (Object.keys(changes).every(k => k === 'cache')) return; // cache writes don't change the view
  if (changes.ownerId) {
    cache = { titles: {}, folders: {}, ...(await chrome.storage.local.get('cache')).cache };
    folderId = null;
    bookmarkItems = [];
    $('folders').replaceChildren();
    $('bookmarkList').replaceChildren();
  }
  render();
});
setInterval(() => { renderHero(); renderQueue(); }, 15000); // keeps the time left moving between page turns
if (location.hash === '#import') {
  document.documentElement.classList.add('page');
  $('tab-settings').click();
  setTimeout(() => { $('importMsg').textContent = tr('importTab'); $('importQueue').focus(); }, 300);
}
render().then(checkAccount).then(checkUpdate);
