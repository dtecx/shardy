// Shardy content script (shared.js is loaded before this file).
// Reads chapters of queued titles in a loop, page by page, at a human pace. Shards are credited by
// the site when the reader moves to the next chapter (POST /api/manga/{id}/chapters/{chapterId}/view),
// so the script only turns pages like a person would.

if (!window.__shardy) {
window.__shardy = true;

const API = 'https://api.imglib.info/api/';
const rnd = (a, b) => a + Math.random() * (b - a);
const today = () => new Date().toLocaleDateString('sv');
const load = async () => ({ ...DEFAULTS, ...(await chrome.storage.local.get(null)) });
const save = o => chrome.storage.local.set(o);
const status = (k, p = {}) => { console.log('[Shardy]', k, p); return save({ status: { k, p, at: Date.now() } }); };
// Desktop notification through the service worker (it checks the user's setting and language).
const notify = (k, p = {}) => chrome.runtime.sendMessage({ type: 'notify', k, p }).catch(() => {});

// --- history: shards and chapters per day, and a log of cards obtained ---
const HISTORY_DAYS = 90, CARD_LOG = 50;
async function addHistory({ shards = 0, chapters = 0, cards = [] }) {
  const { history = {}, cardLog = [] } = await chrome.storage.local.get(['history', 'cardLog']);
  const day = today();
  const h = history[day] || { shards: 0, chapters: 0, cards: 0 };
  history[day] = { shards: h.shards + shards, chapters: h.chapters + chapters, cards: h.cards + cards.length };
  const oldest = new Date(Date.now() - HISTORY_DAYS * 864e5).toLocaleDateString('sv');
  for (const d of Object.keys(history)) if (d < oldest) delete history[d];
  await save({ history, cardLog: [...cards, ...cardLog].slice(0, CARD_LOG) });
}

// --- sleeping on the service worker's clock (not throttled in hidden tabs) ---
let port = null, seq = 0;
const pending = new Map();
function send(id, ms) {
  try {
    if (!port) {
      port = chrome.runtime.connect({ name: 'ticker' });
      port.onMessage.addListener(id => { pending.get(id)?.resolve(); pending.delete(id); });
      port.onDisconnect.addListener(() => {
        port = null;
        for (const [id, p] of pending) send(id, Math.max(0, p.due - Date.now()));
      });
    }
    port.postMessage({ id, ms });
  } catch {
    setTimeout(() => { pending.get(id)?.resolve(); pending.delete(id); }, ms); // extension reloaded
  }
}
const tick = ms => new Promise(resolve => { const id = ++seq; pending.set(id, { resolve, due: Date.now() + ms }); send(id, ms); });
async function sleep(ms) {
  // Short chunks: each message also keeps the service worker alive through long breaks.
  for (let end = Date.now() + ms; Date.now() < end;) await tick(Math.min(end - Date.now(), 20000));
}

// --- site API (same calls the site makes, with the user's own session) ---
class AuthError extends Error {}
function headers() {
  const token = JSON.parse(localStorage.getItem('auth') || 'null')?.token?.access_token;
  if (!token) throw new AuthError('not logged in');
  return { Authorization: 'Bearer ' + token, 'Site-Id': '1', Accept: 'application/json' };
}
async function api(path, body) {
  const init = body
    ? { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { headers: headers(), cache: 'no-store' };
  const r = await fetch(API + path, init);
  if (r.status === 401) throw new AuthError('not logged in');
  if (!r.ok) { const e = new Error(`${path} -> ${r.status}`); e.status = r.status; throw e; }
  return (await r.json()).data;
}
async function apiRaw(path) {
  const r = await fetch(API + path, { headers: headers(), cache: 'no-store' });
  if (r.status === 401) throw new AuthError('not logged in');
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}
// The site's weekly shard limit for reading (profile → Карты → Осколки).
async function weeklyLimit() {
  const meta = (await apiRaw('profile/cards/shards?page=1&per_page=1')).meta?.weekly_limits;
  const read = meta?.items?.find(x => x.key === 'content');
  if (!read) return null;
  const weekly = { used: read.used, limit: read.limit, remaining: read.remaining, resetAt: Date.parse(meta.reset_at) || null, at: Date.now() };
  await save({ weekly });
  return weekly;
}
// Long waits (breaks, limits) end early when the user presses Stop.
async function waitWhileRunning(ms) {
  for (let end = Date.now() + ms; Date.now() < end;) {
    if (!(await load()).running) return;
    await sleep(Math.min(end - Date.now(), 20000));
  }
}

async function authMe() {
  try { const me = await api('auth/me'); return { loggedIn: !!me?.id, id: me?.id, name: me?.username }; }
  catch (e) { return { loggedIn: false, error: e instanceof AuthError ? null : e.message }; }
}
async function shardData(slug) {
  try { return await api(`cards/shards/title/manga/${parseInt(slug)}`); }
  catch (e) { if (e.status === 404) return null; throw e; }
}
const shardState = async (slug, ranks) => titleSummary(await shardData(slug), ranks);

// Average pages per chapter from a few chapters spread over the title (the loop reads all of them equally).
async function pageStats(slug) {
  const list = await chapterList(slug);
  const picks = [...new Set([0, Math.floor(list.length / 2), list.length - 1])].filter(i => list[i]);
  const counts = [];
  for (const i of picks) {
    const c = list[i];
    const d = await api(`manga/${slug}/chapter?number=${encodeURIComponent(c.number)}&volume=${encodeURIComponent(c.volume)}`).catch(() => null);
    if (d?.pages?.length) counts.push(d.pages.length);
  }
  return { chapters: list.length, pagesPerCh: counts.length ? Math.round(counts.reduce((a, b) => a + b, 0) / counts.length) : null };
}
// Raw card data (so the popup can recompute for any rank selection from its cache) plus chapter counts.
async function titleInfo(slug, withPages) {
  const d = await shardData(slug);
  const raw = { balance: { amount: d?.balance?.amount ?? 0 }, exchange_options: (d?.exchange_options || []).map(o => ({ rank: o.rank, cost: o.cost, missing_cards_count: o.missing_cards_count, total_cards_count: o.total_cards_count })) };
  if (!raw.exchange_options.some(o => o.total_cards_count > 0)) return { raw };
  if (withPages) return { raw, ...(await pageStats(slug)) };
  return { raw, chapters: (await chapterList(slug)).length };
}

// Exchanges shards for missing cards of the selected ranks while affordable. The site gives a random
// missing card per exchange, so nothing here can produce a duplicate (ranks with no missing cards are skipped).
async function autoBuy(slug, ranks, title) {
  const bought = [];
  for (let i = 0; i < 30; i++) {
    const data = await shardData(slug);
    const opt = (data?.exchange_options || [])
      .filter(o => ranks.includes(o.rank) && o.missing_cards_count > 0 && o.can_exchange && !o.duplicate)
      .sort((a, b) => a.cost - b.cost)[0];
    if (!opt) break;
    let res;
    try { res = await api(`cards/shards/title/manga/${parseInt(slug)}/exchange`, { rank: opt.rank }); }
    catch (e) { if (e instanceof AuthError) throw e; await status('st_buy_failed', { rank: opt.rank }); break; } // reading goes on
    const card = { rank: opt.rank, name: res?.card?.name || '', title, slug, at: Date.now() };
    bought.push(card);
    await addHistory({ cards: [card] });
    await status('st_bought', card);
    await notify('n_card', card);
  }
  return bought;
}

// The popup has no access to the site's login, so it asks this script to make API calls.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type === 'auth') { authMe().then(reply); return true; }
  if (msg?.type === 'api') {
    api(msg.path, msg.body).then(data => reply({ ok: true, data }), e => reply({ ok: false, error: e.message, auth: e instanceof AuthError }));
    return true;
  }
  if (msg?.type === 'weekly') {
    weeklyLimit().then(data => reply({ ok: true, data }), e => reply({ ok: false, error: e.message, auth: e instanceof AuthError }));
    return true;
  }
  if (msg?.type === 'titleInfo') {
    titleInfo(msg.slug, msg.withPages).then(data => reply({ ok: true, data }), e => reply({ ok: false, error: e.message, auth: e instanceof AuthError }));
    return true;
  }
});

// --- bookmark ("continue reading") protection ---
// Every chapter read moves the bookmark, so the user's own bookmark is saved before farming a title
// and put back with the same call the site's "mark as read" uses.
async function saveBookmark(slug) {
  const { savedBookmarks = {} } = await chrome.storage.local.get('savedBookmarks');
  if (slug in savedBookmarks) return; // already holds the user's original, not a farmed one
  const b = await api(`manga/${slug}/bookmark`);
  savedBookmarks[slug] = b && { item_id: b.item_id, progress: b.progress, status: b.status, item_number: b.meta?.item_number };
  await save({ savedBookmarks });
}
async function restoreBookmarks(slugs, forget) {
  const { savedBookmarks = {} } = await chrome.storage.local.get('savedBookmarks');
  for (const slug of slugs ?? Object.keys(savedBookmarks)) {
    if (!(slug in savedBookmarks)) continue;
    const b = savedBookmarks[slug];
    // ponytail: a title that had no bookmark before keeps the one reading created; delete it by hand if unwanted.
    if (b) await api('bookmarks', {
      media_type: 'manga', media_slug: slug,
      bookmark: { item_id: b.item_id, progress: b.progress, status: b.status },
      meta: { item_number: b.item_number },
    });
    if (forget) delete savedBookmarks[slug];
  }
  await save({ savedBookmarks });
}

// --- which chapter to read next ---
// A chapter pays shards once per cooldown (server constant, 30 days), judged by the site's is_viewed_last_at.
// Chapters are checked lazily, one request at a time, the same request the reader makes when opening one.
const chapterUrl = (slug, ch) => `/ru/${slug}/read/v${ch.volume}/c${ch.number}` + (ch.branches?.[0]?.branch_id ? `?bid=${ch.branches[0].branch_id}` : '');
const lists = {};
async function chapterList(slug) {
  if (!lists[slug] || Date.now() - lists[slug].at > 3600e3) lists[slug] = { at: Date.now(), list: await api(`manga/${slug}/chapters`) };
  return lists[slug].list;
}
async function loadScan(slug) {
  const { scans = {} } = await chrome.storage.local.get('scans');
  return scans[slug] || { viewed: {}, checked: {} };
}
async function saveScan(slug, scan) {
  const { scans = {} } = await chrome.storage.local.get('scans');
  scans[slug] = scan;
  await save({ scans });
}
const payable = (scan, ch, now, ms) => !scan.viewed[ch.id] || now - scan.viewed[ch.id] >= ms;
// Cooldown length from the site, refreshed daily.
async function cooldownSec() {
  const s = await load();
  if (s.cooldownSec && Date.now() - (s.cooldownAt || 0) < 864e5) return s.cooldownSec;
  const c = await api('constants?fields[]=chapterReadRewardCooldownSeconds').catch(() => null);
  const sec = +c?.chapterReadRewardCooldownSeconds || s.cooldownSec || COOLDOWN_SEC;
  await save({ cooldownSec: sec, cooldownAt: Date.now() });
  return sec;
}

// Next chapter that pays, plus how many still pay (unchecked chapters count as paying), or the cooldown end.
async function nextChapter(slug) {
  const ms = (await cooldownSec()) * 1000;
  const list = await chapterList(slug);
  const scan = await loadScan(slug);
  const now = Date.now();
  const candidates = list;
  let found = null, checks = 0;
  for (const ch of candidates) {
    const stale = scan.checked[ch.id] == null || (!scan.viewed[ch.id] && now - scan.checked[ch.id] > 12 * 3600e3);
    if (stale) {
      if (checks++) await sleep(rnd(600, 1400)); // gentle: one chapter request at a time
      const d = await api(`manga/${slug}/chapter?number=${encodeURIComponent(ch.number)}&volume=${encodeURIComponent(ch.volume)}`).catch(() => null);
      scan.viewed[ch.id] = d?.is_viewed_last_at ? Date.parse(d.is_viewed_last_at) : 0;
      scan.checked[ch.id] = now;
      if (checks % 10 === 0) await saveScan(slug, scan);
    }
    if (payable(scan, ch, now, ms)) { found = ch; break; }
  }
  await saveScan(slug, scan);
  const eligible = candidates.filter(ch => payable(scan, ch, now, ms)).length;
  const cooldownUntil = found ? null : Math.min(...candidates.map(ch => (scan.viewed[ch.id] || now) + ms));
  return { chapter: found, eligible, chapters: list.length, cooldownUntil };
}
async function markRead(slug, chapterPath) {
  const list = await chapterList(slug);
  const ch = list.find(c => chapterPath.endsWith(`/v${c.volume}/c${c.number}`));
  if (!ch) return;
  const scan = await loadScan(slug);
  scan.viewed[ch.id] = scan.checked[ch.id] = Date.now();
  await saveScan(slug, scan);
}

// --- reader ---
function reader() {
  const m = location.pathname.match(/^\/\w{2}\/([^/]+)\/read\/v[^/]+\/c[^/]+/);
  if (!m) return null;
  const total = +(document.body.innerText.match(/Страница \d+ \/ (\d+)/) || [])[1] || null;
  return { slug: m[1], chapter: m[0], label: m[0].split('/c').pop(), page: +(new URLSearchParams(location.search).get('p') || 1), total };
}

// Paged ("horizontal") mode is required: one click on the image = one page.
function ensurePagedMode() {
  const s = JSON.parse(localStorage.getItem('settings') || '{}');
  if (s.reader?.mode === 'horizontal' && s.reader?.clickTargetArea === 'image') return true;
  s.reader = { ...(s.reader || {}), mode: 'horizontal', clickTargetArea: 'image' };
  localStorage.setItem('settings', JSON.stringify(s));
  location.reload();
  return false;
}

const isPageImage = el => el?.tagName === 'IMG' && /^https:\/\/[^/]*(cdnlibs\.org|imglib\.info)\//.test(el.currentSrc || el.src);
function clickAt(el, x, y) {
  const o = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window, button: 0 };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    el.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, o));
  }
}

// --- ads and popups over the reader ---
// The topmost fixed element under the click point that covers a large part of the screen.
function overlayOf(el) {
  let found = null;
  for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
    if (getComputedStyle(e).position !== 'fixed') continue;
    const r = e.getBoundingClientRect();
    if (r.width * r.height >= innerWidth * innerHeight * 0.4) found = e;
  }
  return found;
}
// Walks light DOM and shadow roots; ad SDKs often draw their close button in a closed shadow root.
function* deepElements(root) {
  for (const e of root.querySelectorAll('*')) {
    yield e;
    const sr = e.shadowRoot || chrome.dom?.openOrClosedShadowRoot?.(e);
    if (sr) yield* deepElements(sr);
  }
}
const CLOSE_LABEL = /^(×|✕|✖|╳|x|закрыть|закрити|пропустить|пропустити|skip|close|skip ad|закрыть рекламу)$/i;
function findCloseButton(overlay) {
  for (const e of deepElements(overlay)) {
    const label = (e.getAttribute('aria-label') || e.getAttribute('title') || (e.children.length ? '' : e.textContent) || '').trim();
    const cls = String(e.className?.baseVal ?? e.className ?? '');
    if (!CLOSE_LABEL.test(label) && !/(^|[-_\s])close([-_\s]|$)/i.test(cls)) continue;
    const r = e.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (e.closest?.('a[href]') && new URL(e.closest('a[href]').href, location.href).host !== location.host) continue; // never follow ad links
    return e;
  }
  return null;
}

// --- main loop ---
let stuck = 0, lastTurnAt = 0, chaptersSinceBreak = 0, nextBreakAt = 0, zeroStreak = 0;
const counted = new Set(); // chapters already credited on this page load
let adSince = 0, adWait = 0, adTriedClose = false;

const updateItem = async (slug, patch) => {
  const { queue = [] } = await chrome.storage.local.get('queue');
  await save({ queue: queue.map(q => (q.slug === slug ? { ...q, ...patch } : q)) });
};

async function onChapterDone(s, item, chapterPath, pagesRead) {
  if (!nextBreakAt) nextBreakAt = Math.round(rnd(s.breakEveryMin, s.breakEveryMax));
  await sleep(2500); // the reader's "chapter read" request goes out on the same page turn
  await markRead(item.slug, chapterPath);
  const day = today();
  const dayCount = (s.day === day ? s.dayCount : 0) + 1;
  // Shards this chapter paid, measured before auto-exchange spends any.
  const before = await shardState(item.slug, s.ranks);
  const gained = before.balance - (item.balance ?? before.balance);
  const bought = s.autoBuy ? await autoBuy(item.slug, s.ranks, item.name) : [];
  const sum = bought.length ? await shardState(item.slug, s.ranks) : before;
  // Cards that appeared since the last check: bought here, or exchanged by hand on the site.
  const manual = Math.max(0, (sum.collected ?? 0) - (item.collected ?? sum.collected ?? 0) - bought.length);
  const at = Date.now();
  const cards = Array.from({ length: manual }, () => ({ rank: '', name: '', title: item.name, slug: item.slug, at }));
  await addHistory({ shards: Math.max(0, gained), chapters: 1, cards }); // bought cards were logged by autoBuy

  // Moving averages for the ETA: shards per chapter (global) and pages per chapter (per title).
  const ema = (old, v) => (old ? old * 0.85 + v * 0.15 : v);
  const stats = { ...s.stats };
  if (item.balance != null && gained > 0 && gained < 20) stats.shardsPerCh = ema(stats.shardsPerCh, gained);
  if (pagesRead) stats.pagesPerCh = ema(stats.pagesPerCh, pagesRead);
  const pagesPerCh = pagesRead ? Math.round(ema(item.pagesPerCh, pagesRead)) : item.pagesPerCh;
  zeroStreak = gained > 0 ? 0 : zeroStreak + 1;

  const done = ['complete', 'enough', 'noCards'].includes(titleState(sum));
  await updateItem(item.slug, { ...sum, pagesPerCh, done });
  await save({ day, dayCount, stats });
  await status('st_progress', { name: item.name, b: sum.balance, n: sum.need, c: dayCount });
  if (done) {
    await status('st_title_done', { name: item.name });
    await notify('n_title_done', { name: item.name });
    return restoreBookmarks([item.slug], true);
  }

  const weekly = await weeklyLimit().catch(() => null);
  if (weekly && weekly.remaining <= 0) return; // next step waits for the reset
  if (zeroStreak >= 5) {
    // Five chapters in a row paid nothing although the week still has room: stop wasting time on this title today.
    zeroStreak = 0;
    await updateItem(item.slug, { cooldownUntil: Date.now() + 864e5 });
    await status('st_no_credit', { name: item.name });
    return restoreBookmarks([item.slug], true);
  }

  if (++chaptersSinceBreak >= nextBreakAt) {
    chaptersSinceBreak = 0;
    nextBreakAt = Math.round(rnd(s.breakEveryMin, s.breakEveryMax));
    await restoreBookmarks([item.slug], false);
    const min = rnd(s.breakMin, s.breakMax);
    await status('st_break', { m: min.toFixed(1) });
    await waitWhileRunning(min * 60000);
    lastTurnAt = 0;
  }
}

async function handleBlocked(el) {
  const overlay = overlayOf(el);
  if (!overlay) {
    stuck++;
    await status('st_stuck', { n: stuck });
    if (stuck >= 6) { stuck = 0; await status('st_reload'); location.reload(); await sleep(15000); }
    return;
  }
  // Give the ad a few seconds on screen, like a person would, then close it.
  if (!adSince) { adSince = Date.now(); adWait = rnd(4, 9) * 1000; adTriedClose = false; }
  if (Date.now() - adSince < adWait) return status('st_ad_wait');
  const btn = !adTriedClose && findCloseButton(overlay);
  if (btn) {
    adTriedClose = true;
    const r = btn.getBoundingClientRect();
    clickAt(btn, r.left + r.width / 2, r.top + r.height / 2);
    btn.click?.();
    return status('st_ad_closed');
  }
  // No close button reachable (or it ignored a synthetic click): hide the overlay.
  overlay.style.setProperty('display', 'none', 'important');
  adSince = 0;
  return status('st_ad_hidden');
}

async function step() {
  const s = await load();
  if (!s.running) {
    // Stopped (button, closed window, finished): give the user's bookmarks back. Any MangaLib tab can do it.
    if (Object.keys(s.savedBookmarks || {}).length) { await restoreBookmarks(null, true); await status('st_restored'); }
    return new Promise(r => setTimeout(r, 5000));
  }
  if (!(await chrome.runtime.sendMessage('amFarmTab'))) return new Promise(r => setTimeout(r, 5000));

  // Weekly shard limit for reading: nothing more to earn until the reset.
  const now = Date.now();
  const weekly = s.weekly && now - s.weekly.at < 30 * 60e3 ? s.weekly : await weeklyLimit().catch(() => s.weekly);
  if (weekly && weekly.remaining <= 0 && weekly.resetAt > now) {
    await status('st_weekly', { date: weekly.resetAt });
    if (s.notifiedWeek !== weekly.resetAt) { await save({ notifiedWeek: weekly.resetAt }); await notify('n_weekly', { date: weekly.resetAt }); }
    await waitWhileRunning(Math.min(weekly.resetAt - now + 60e3, 6 * 3600e3));
    return weeklyLimit().catch(() => null);
  }

  const queue = s.queue.filter(q => !q.done);
  const item = queue.find(q => titleState(q) !== 'cooldown');
  if (!queue.length) { await save({ running: false, current: null }); await notify('n_all_done'); return status('st_all_done'); }
  if (!item) {
    // Every title is waiting for its chapters to come off cooldown.
    const until = Math.min(...queue.map(q => q.cooldownUntil));
    await status('st_all_cooldown', { date: until });
    return waitWhileRunning(Math.min(until - now + 60e3, 6 * 3600e3));
  }
  if (s.current !== item.slug) { await save({ current: item.slug }); zeroStreak = 0; }

  if (s.dailyMax && s.day === today() && s.dayCount >= s.dailyMax) {
    await status('st_daily', { n: s.dailyMax });
    return waitWhileRunning(10 * 60000);
  }

  await saveBookmark(item.slug);
  const r = reader();
  if (!r || r.slug !== item.slug) {
    // Start of a title, after its last chapter (the reader returns to the title page), or after a switch.
    if (s.autoBuy) await autoBuy(item.slug, s.ranks, item.name);
    const st = await shardState(item.slug, s.ranks);
    if (['complete', 'enough', 'noCards'].includes(titleState(st))) {
      await updateItem(item.slug, { ...st, done: true });
      return restoreBookmarks([item.slug], true);
    }
  }
  // Read only chapters that pay; jump past ones read in the last 3 months.
  const plan = await nextChapter(item.slug);
  await updateItem(item.slug, { eligible: plan.eligible, chapters: plan.chapters, cooldownUntil: plan.cooldownUntil });
  if (!plan.chapter) {
    await status('st_cooldown', { name: item.name, date: plan.cooldownUntil });
    return restoreBookmarks([item.slug], true);
  }
  if (!r || r.slug !== item.slug || !r.chapter.endsWith(`/v${plan.chapter.volume}/c${plan.chapter.number}`)) {
    await status('st_open_ch', { name: item.name, ch: plan.chapter.number });
    location.href = chapterUrl(item.slug, plan.chapter);
    return sleep(15000);
  }
  if (!ensurePagedMode()) return sleep(15000);

  await sleep(rnd(s.pageMin, s.pageMax) * 1000);
  if (Math.random() < 0.03) await sleep(rnd(20, 60) * 1000); // looking away now and then

  const before = reader();
  if (!before) return;
  const x = innerWidth * rnd(0.55, 0.7), y = innerHeight * rnd(0.35, 0.65);
  const el = document.elementFromPoint(x, y);
  // Click only a real manga page: anything else on top (ad, popup) is handled, never clicked blindly.
  if (!isPageImage(el)) return handleBlocked(el);
  adSince = 0;
  clickAt(el, x, y);
  await sleep(1500);

  const after = reader();
  if (!after) { stuck = 0; return; } // the reader left the title (after its last chapter); next step picks a chapter
  const t = Date.now();
  const turned = after.chapter !== before.chapter || after.page !== before.page;
  if (turned) {
    stuck = 0;
    const stats = { ...(await load()).stats };
    if (lastTurnAt && t - lastTurnAt < 120000) stats.secPerPage = stats.secPerPage ? stats.secPerPage * 0.95 + ((t - lastTurnAt) / 1000) * 0.05 : (t - lastTurnAt) / 1000;
    lastTurnAt = t;
    await save({ stats, live: { slug: item.slug, chapter: after.label, page: after.page, total: after.total, at: t } });
  }
  // The site credits a chapter once its reader passes 90% of the pages; count it right then.
  const done = [before, after].find(x => x.total && x.page / x.total > CREDIT_AT && !counted.has(x.chapter));
  if (done) {
    counted.add(done.chapter);
    return onChapterDone(await load(), item, done.chapter, done.total);
  }
  if (turned) return;
  stuck++;
  await status('st_stuck', { n: stuck });
  if (stuck >= 6) { stuck = 0; await status('st_reload'); location.reload(); await sleep(15000); }
}

(async () => {
  for (;;) {
    try { await step(); }
    catch (e) {
      if (e instanceof AuthError) {
        if ((await load()).running) { await save({ running: false }); await status('st_not_logged'); }
        await new Promise(r => setTimeout(r, 60000));
        continue;
      }
      if (/Extension context invalidated/.test(e.message)) return; // extension was reloaded; new script takes over
      await status('st_error', { e: e.message });
      await sleep(60000);
    }
  }
})();
}
