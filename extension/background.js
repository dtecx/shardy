// Service worker: owns the farm window, the timer the reader runs on, and desktop notifications.
importScripts('shared.js'); // strings and date formatting shared with the popup

// The cover CDN answers 403 to requests without a Referer, and extension pages send none.
// Session rule, limited to requests made outside any tab (the popup): the site's own pages are untouched.
async function coverReferer() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: 'https://mangalib.me/' }] },
      condition: { requestDomains: ['cover.imglib.info'], resourceTypes: ['image'], tabIds: [chrome.tabs.TAB_ID_NONE] },
    }],
  });
}
chrome.runtime.onInstalled.addListener(coverReferer);
chrome.runtime.onStartup.addListener(coverReferer);
coverReferer();

// Chrome throttles timers in hidden tabs (down to one wake-up per minute after 5 minutes),
// so the content script sleeps by asking this worker to message it back. Worker timers and
// incoming messages are not throttled, and every message keeps the worker alive.
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'ticker') return;
  port.onMessage.addListener(({ id, ms }) => {
    setTimeout(() => { try { port.postMessage(id); } catch { /* tab gone */ } }, ms);
  });
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg === 'amFarmTab') {
    chrome.storage.local.get('farmTabId').then(s => reply(s.farmTabId === sender.tab?.id));
    return true;
  }
  if (msg?.type === 'notify') {
    notify(msg.k, msg.p).then(() => reply(true));
    return true;
  }
  if (msg?.type === 'start') {
    start().then(() => reply(true), e => reply(String(e)));
    return true;
  }
});

// Reading runs in its own small window so the user keeps every other tab and window free.
async function start() {
  const { farmTabId } = await chrome.storage.local.get('farmTabId');
  const existing = farmTabId && await chrome.tabs.get(farmTabId).catch(() => null);
  let tabId = existing?.id;
  if (!tabId) {
    const win = await chrome.windows.create({ url: 'https://mangalib.me/ru', focused: false, width: 520, height: 760, type: 'normal' });
    tabId = win.tabs[0].id;
  }
  await chrome.storage.local.set({ running: true, farmTabId: tabId, status: { k: 'st_starting', at: Date.now() } });
}

chrome.tabs.onRemoved.addListener(async id => {
  const { farmTabId, running } = await chrome.storage.local.get(['farmTabId', 'running']);
  if (farmTabId !== id) return;
  await chrome.storage.local.set({ farmTabId: null });
  if (running) await chrome.storage.local.set({ running: false, status: { k: 'st_tab_closed', at: Date.now() } });
});

async function notify(key, params) {
  const { notify: on = true, lang = 'ru' } = await chrome.storage.local.get(['notify', 'lang']);
  if (!on) return;
  await chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title: 'Shardy', message: tDated(lang, key, params || {}), priority: 0 });
}
