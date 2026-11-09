// Account switching in the service worker: per-account data is parked and restored. Run: node tests/accounts.test.js
const fs = require('fs'); const vm = require('vm'); const path = require('path'); const assert = require('assert');
const ext = path.join(__dirname, '..', 'extension');

function worker(initial) {
  const store = JSON.parse(JSON.stringify(initial));
  const pick = keys => Object.fromEntries((keys == null ? Object.keys(store) : [].concat(keys)).filter(k => k in store).map(k => [k, JSON.parse(JSON.stringify(store[k]))]));
  const listeners = {};
  const ev = name => ({ addListener: f => { listeners[name] = f; } });
  const chrome = {
    storage: { local: { get: async k => pick(k), set: async o => Object.assign(store, JSON.parse(JSON.stringify(o))), remove: async ks => [].concat(ks).forEach(k => delete store[k]) } },
    runtime: { onConnect: ev('connect'), onMessage: ev('message'), onInstalled: ev('installed'), onStartup: ev('startup') },
    tabs: { onRemoved: ev('removed'), TAB_ID_NONE: -1 },
    declarativeNetRequest: { updateSessionRules: async () => {} },
    notifications: { create: async () => {} },
  };
  const ctx = { chrome, setTimeout, console, importScripts: f => vm.runInContext(fs.readFileSync(path.join(ext, f), 'utf8'), ctx) };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ext, 'background.js'), 'utf8'), ctx);
  const send = msg => new Promise(res => listeners.message(msg, {}, res));
  return { store, send };
}

(async () => {
  // First account seen adopts the data that is already there.
  const w = worker({ queue: [{ slug: '1--a' }], history: { '2026-11-09': { shards: 5 } }, lang: 'ru' });
  await w.send({ type: 'account', account: { id: 1, name: 'alice' } });
  assert.strictEqual(w.store.ownerId, 1);
  assert.strictEqual(w.store.queue.length, 1);

  // Another account: alice's data is parked, bob starts clean, settings stay.
  w.store.running = true;
  await w.send({ type: 'account', account: { id: 2, name: 'bob' } });
  assert.strictEqual(w.store.ownerId, 2);
  assert.deepStrictEqual(w.store.queue, []);
  assert.strictEqual(w.store.history, undefined);
  assert.strictEqual(w.store.running, false, 'farming stops on a switch');
  assert.strictEqual(w.store.status.k, 'st_account_switched');
  assert.strictEqual(w.store.lang, 'ru');
  assert.strictEqual(w.store.profiles[1].queue[0].slug, '1--a');

  // Back to alice: her data returns, bob's is parked.
  w.store.queue = [{ slug: '2--b' }];
  await w.send({ type: 'account', account: { id: 1, name: 'alice' } });
  assert.strictEqual(w.store.queue[0].slug, '1--a');
  assert.strictEqual(w.store.history['2026-11-09'].shards, 5);
  assert.strictEqual(w.store.profiles[2].queue[0].slug, '2--b');
  assert.strictEqual(w.store.profiles[1], undefined);

  // Logging out stops farming but keeps the data.
  w.store.running = true;
  await w.send({ type: 'account', account: null });
  assert.strictEqual(w.store.running, false);
  assert.strictEqual(w.store.status.k, 'st_logged_out');
  assert.strictEqual(w.store.queue[0].slug, '1--a');
  assert.strictEqual(w.store.account.id, null);

  // Two tabs reporting at once can't interleave a switch.
  await Promise.all([w.send({ type: 'account', account: { id: 2, name: 'bob' } }), w.send({ type: 'account', account: { id: 2, name: 'bob' } })]);
  assert.strictEqual(w.store.ownerId, 2);
  assert.strictEqual(w.store.queue[0].slug, '2--b');
  assert.strictEqual(w.store.profiles[1].queue[0].slug, '1--a');
  console.log('accounts self-check ok');
})().catch(e => { console.error(e); process.exit(1); });
