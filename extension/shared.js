// Shared by the popup and the content script (both load this file first).

const PRESETS = {
  slow:   { pageMin: 8, pageMax: 16, breakEveryMin: 6,  breakEveryMax: 10, breakMin: 5, breakMax: 15, dailyMax: 120 },
  normal: { pageMin: 5, pageMax: 12, breakEveryMin: 8,  breakEveryMax: 15, breakMin: 3, breakMax: 10, dailyMax: 250 },
  fast:   { pageMin: 3, pageMax: 7,  breakEveryMin: 12, breakEveryMax: 20, breakMin: 2, breakMax: 6,  dailyMax: 400 },
};
const NUMBER_FIELDS = Object.keys(PRESETS.normal);

const DEFAULTS = {
  running: false,
  lang: 'ru',
  speed: 'normal',
  ...PRESETS.normal,
  ranks: ['E', 'D', 'C', 'B', 'A'],
  autoBuy: false,     // exchange shards for missing cards as soon as a rank is affordable
  queue: [],          // [{ slug, name, cover, balance, need, done, noCards, collected, total, pagesPerCh }]
  stats: {},          // { secPerPage, shardsPerCh, pagesPerCh }
  live: null,         // { slug, chapter, page, total, at }: the page being read right now
  status: null,       // { k, p, at }
};

const AVG_PAGES = 45;            // chapter length before a title's real page count is known
const START_SHARDS_PER_CH = 1.2; // observed 1–2 shards per chapter
const CH_OVERHEAD_SEC = 6;       // loading the next chapter, interstitial ads
const COOLDOWN_SEC = 30 * 86400;  // server constant chapterReadRewardCooldownSeconds (2592000) at the time of writing
const WEEK_MS = 7 * 864e5;
const WEEKLY_READ_LIMIT = 750;   // site rule: reading gives at most 750 shards a week (900 with premium)
const CREDIT_AT = 0.9;           // the reader always reports a chapter as read past 90% of its pages
const cooldownMs = s => (s.cooldownSec || COOLDOWN_SEC) * 1000;

// Shard state of a title for the selected ranks. An exchange gives a random *missing* card of the rank
// (duplicates only once a rank is complete), so collecting every card costs exactly missing × cost.
function titleSummary(shardData, ranks) {
  const opts = (shardData?.exchange_options || []).filter(o => o.total_cards_count > 0);
  const picked = opts.filter(o => ranks.includes(o.rank));
  const total = picked.reduce((n, o) => n + o.total_cards_count, 0);
  const missing = picked.reduce((n, o) => n + o.missing_cards_count, 0);
  return {
    noCards: opts.length === 0,
    need: picked.reduce((sum, o) => sum + o.missing_cards_count * o.cost, 0),
    balance: shardData?.balance?.amount ?? 0,
    total,
    collected: total - missing,
  };
}
const shardsNeeded = titleSummary;

// complete: every selected card owned · enough: shards cover the rest · cooldown: no chapter pays right now
function titleState(item, now = Date.now()) {
  if (item.noCards) return 'noCards';
  if (item.need == null) return 'unknown';
  if (item.total && item.collected >= item.total) return 'complete';
  if ((item.balance || 0) >= item.need) return 'enough';
  if (item.cooldownUntil && item.cooldownUntil > now) return 'cooldown';
  return 'farm';
}

function paceOf(s) {
  const breakEvery = (s.breakEveryMin + s.breakEveryMax) / 2 || 1;
  return {
    secPerPage: s.stats?.secPerPage || (s.pageMin + s.pageMax) / 2 + 1.6, // delay + page load + click
    shardsPerCh: s.stats?.shardsPerCh || START_SHARDS_PER_CH,
    breakPerCh: ((s.breakMin + s.breakMax) / 2) * 60 / breakEvery,
  };
}

// What a title can still give and how long that takes. Each chapter pays once per cooldown (30 days), so a
// big album needs several cooldown cycles: `cycles` counts the extra ones after the chapters that pay now.
// eligible: chapters that pay now (known after a scan; before that, all of them).
function titlePlan(s, item, now = Date.now()) {
  const st = titleState(item, now);
  if (item.done || ['complete', 'enough', 'noCards'].includes(st)) return { chapters: 0, sec: 0, shards: 0, waitSec: 0, cycles: 0 };
  if (item.need == null) return null;
  const p = paceOf(s);
  const pages = item.pagesPerCh || s.stats?.pagesPerCh || AVG_PAGES;
  const secPerCh = pages * p.secPerPage + CH_OVERHEAD_SEC + p.breakPerCh;
  const left = Math.max(0, item.need - (item.balance || 0));
  const all = item.chapters || Infinity;
  const nowCh = st === 'cooldown' ? 0 : Math.min(item.eligible ?? all, all);
  const neededCh = Math.ceil(left / p.shardsPerCh);
  let chapters = neededCh; // every chapter needed is read eventually, across cycles
  if (s.running && s.live?.slug === item.slug && s.live.total) chapters = Math.max(0, chapters - Math.min(1, s.live.page / (s.live.total * CREDIT_AT)));
  const cycles = neededCh > nowCh ? Math.ceil((neededCh - nowCh) / all) : 0;
  const firstWait = st === 'cooldown' ? Math.max(0, item.cooldownUntil - now) / 1000 : (s.cooldownSec || COOLDOWN_SEC);
  return {
    chapters,
    shards: Math.min(left, chapters * p.shardsPerCh),
    sec: chapters * secPerCh,
    cycles,
    waitSec: cycles ? firstWait + (cycles - 1) * (s.cooldownSec || COOLDOWN_SEC) : 0,
  };
}

// Time until the given titles are fully farmed, in queue order, or null while a title is unknown.
// Bound by reading speed, the daily chapter cap, the site's weekly shard limit and chapter cooldowns.
function etaSeconds(s, items, now = Date.now()) {
  let chapters = 0, sec = 0, shards = 0, wait = 0;
  for (const q of [].concat(items)) {
    const plan = titlePlan(s, q, now);
    if (!plan) return null;
    chapters += plan.chapters;
    sec += plan.sec;
    shards += plan.shards;
    wait = Math.max(wait, plan.waitSec); // cooldowns of different titles run at the same time
  }
  if (s.dailyMax) sec = Math.max(sec, (chapters / s.dailyMax) * 86400);
  const w = s.weekly;
  const limit = w?.limit || WEEKLY_READ_LIMIT;
  const thisWeek = w?.resetAt > now ? w.remaining : limit;
  const resetIn = w?.resetAt > now ? (w.resetAt - now) / 1000 : WEEK_MS / 1000;
  if (shards > thisWeek) sec = Math.max(sec, resetIn + ((shards - thisWeek) / limit) * (WEEK_MS / 1000));
  return Math.max(sec, wait);
}
// Cooldown cycles the slowest title still needs (shown so a huge album doesn't look like a few days).
const cyclesLeft = (s, items) => Math.max(0, ...[].concat(items).map(q => titlePlan(s, q)?.cycles || 0));

const STR = {
  ru: {
    stCooldown: 'Главы на откате до {date}', weekLabel: 'Лимит недели', laterNote: 'Главы платят раз в {d} дн., поэтому нужно ещё {n} цикла(ов) отката',
    payNow: 'платят {e} из {c} глав', myShards: 'С осколками', ranksSL: 'S и L на осколки не меняются: S — за активность и события, L — за обмен полного альбома.',
    st_weekly: 'Недельный лимит осколков исчерпан, продолжу {date}', st_all_cooldown: 'Все главы на откате, продолжу {date}',
    st_cooldown: '«{name}»: все главы на откате до {date}, перехожу дальше', st_no_credit: '«{name}»: главы перестали давать осколки, пропускаю на сутки',
    st_open_ch: '«{name}»: открываю главу {ch}',
    cards: 'Карты {c}/{t}', needShards: 'нужно {n}', inQueue: 'В очереди', stComplete: 'Все карты собраны', stEnough: 'Хватает на все карты',
    addAllNeeded: 'Добавить все нужные · {n}', readyGroup: 'Собраны или без карт · {n}', checking: 'Проверяю карты… {d}/{n}',
    sortFast: 'Быстрые', sortProgress: 'Ближе к цели', sortName: 'По названию', sortQueue: 'Сначала быстрые',
    autoBuy: 'Автообмен осколков на карты', autoBuyHint: 'Как только осколков хватает, меняет их на недостающую карту выбранного ранга. Дубликатов не будет: сайт выдаёт только недостающие карты, пока ранг не собран.',
    on: 'Вкл', off: 'Выкл', liveLine: 'Глава {ch} · стр. {p}/{n}', titleEta: '≈ {t}',
    st_bought: 'Получена карта {rank}: {name}', st_buy_failed: 'Не удалось обменять осколки на карту {rank}',
    remaining: 'Осталось', paceLabel: 'Темп', perChapter: 'Осколков/глава', chPerHour: '{n} гл/ч',
    nowReading: 'Сейчас читается', nextUp: 'Следующий', titles: 'Тайтлов: {n}', allDone: 'Все тайтлы готовы',
    startFarm: 'Начать фарм', stopFarm: 'Остановить', windowNote: 'Чтение идёт в отдельном окне — не закрывайте его',
    login: 'Войти', addTitles: 'Добавить тайтлы', emptyHero: 'Выберите тайтлы — расширение будет читать главы, которые сейчас дают осколки, пока не наберёт на все карты.',
    selected: 'Выбрано: {n}', ranksHint: 'Цель — осколки на все недостающие карты выбранных рангов',
    loggedAs: 'Аккаунт: {name}',
    notLogged: 'Нет входа в аккаунт MangaLib. Войдите на сайте и откройте окно снова.',
    noTab: 'Откройте mangalib.me, чтобы проверить аккаунт.',
    openSite: 'Открыть MangaLib',
    reloadTab: 'Перезагрузите вкладку MangaLib и откройте окно снова.',
    start: 'Старт', stop: 'Стоп',
    startHint: 'Чтение идёт в отдельном окне. Его можно свернуть за другие окна, но не закрывать.',
    eta: 'Осталось ≈ {t}', etaUnknown: 'Осталось: считаю…',
    pace: '~{ch} глав/ч · ~{sh} осколка/глава',
    tabQueue: 'Очередь', tabAdd: 'Добавить', tabSettings: 'Настройки',
    emptyQueue: 'Список пуст. Добавьте тайтлы во вкладке «Добавить».',
    shards: '{b} / {n} осколков', done: 'Готово', noCards: 'Нет карт', now: 'читается',
    up: 'Выше', down: 'Ниже', remove: 'Удалить',
    addCurrent: 'Тайтл из текущей вкладки',
    searchTitle: 'Поиск', search: 'Название тайтла…', bookmarks: 'Из моих закладок', folder: 'Папка',
    addSelected: 'Добавить выбранные', add: 'Добавить',
    added: 'Добавлено: {n}', already: 'Уже в списке', notTitlePage: 'Откройте страницу тайтла или главу.',
    nothing: 'Ничего не найдено',
    speed: 'Скорость',
    slow: 'Медленно', normal: 'Обычно', fast: 'Быстро', custom: 'Своя',
    hint_slow: 'Безопаснее всего: длинные паузы и не больше 120 глав в день.', hint_normal: 'Баланс скорости и осторожности.', hint_fast: 'Быстрее, но заметнее для антифрода.', hint_custom: 'Свои значения ниже.',
    secPerPage: 'Секунд на страницу', breakEvery: 'Перерыв каждые … глав', breakLen: 'Длина перерыва, мин',
    dailyMax: 'Глав в день (0 = без лимита)', ranks: 'Собирать карты рангов', language: 'Язык',
    d: 'д', h: 'ч', m: 'мин', mo: 'мес.', y: 'г.',
    st_starting: 'Запуск…',
    st_stopped: 'Остановлено',
    st_open: 'Открываю «{name}» с 1 главы',
    st_progress: '«{name}»: {b}/{n} осколков · глав сегодня: {c}',
    st_break: 'Перерыв {m} мин',
    st_daily: 'Дневной лимит {n} глав, продолжу завтра',
    st_title_done: '«{name}» готов, перехожу к следующему',
    st_all_done: 'Все тайтлы готовы',
    st_ad_wait: 'Реклама на экране, жду',
    st_ad_closed: 'Закрыл рекламу',
    st_ad_hidden: 'Скрыл рекламу',
    st_stuck: 'Читалка не отвечает ({n}/6)',
    st_reload: 'Перезагружаю главу',
    st_error: 'Ошибка: {e}. Повтор через минуту',
    st_restored: 'Закладки восстановлены',
    st_tab_closed: 'Остановлено: окно чтения закрыто',
    st_not_logged: 'Остановлено: нет входа в аккаунт',
  },
  uk: {
    stCooldown: 'Розділи на відкаті до {date}', weekLabel: 'Ліміт тижня', laterNote: 'Розділи платять раз на {d} дн., тож потрібно ще {n} цикл(и) відкату',
    payNow: 'платять {e} з {c} розділів', myShards: 'З уламками', ranksSL: 'S і L на уламки не обмінюються: S — за активність і події, L — за обмін повного альбому.',
    st_weekly: 'Тижневий ліміт уламків вичерпано, продовжу {date}', st_all_cooldown: 'Усі розділи на відкаті, продовжу {date}',
    st_cooldown: '«{name}»: усі розділи на відкаті до {date}, переходжу далі', st_no_credit: '«{name}»: розділи перестали давати уламки, пропускаю на добу',
    st_open_ch: '«{name}»: відкриваю розділ {ch}',
    cards: 'Карти {c}/{t}', needShards: 'потрібно {n}', inQueue: 'У черзі', stComplete: 'Усі карти зібрано', stEnough: 'Вистачає на всі карти',
    addAllNeeded: 'Додати всі потрібні · {n}', readyGroup: 'Зібрані або без карт · {n}', checking: 'Перевіряю карти… {d}/{n}',
    sortFast: 'Швидкі', sortProgress: 'Ближче до мети', sortName: 'За назвою', sortQueue: 'Спочатку швидкі',
    autoBuy: 'Автообмін уламків на карти', autoBuyHint: 'Щойно уламків вистачає, міняє їх на відсутню карту вибраного рангу. Дублікатів не буде: сайт видає лише відсутні карти, доки ранг не зібрано.',
    on: 'Увімк', off: 'Вимк', liveLine: 'Розділ {ch} · стор. {p}/{n}', titleEta: '≈ {t}',
    st_bought: 'Отримано карту {rank}: {name}', st_buy_failed: 'Не вдалося обміняти уламки на карту {rank}',
    remaining: 'Залишилось', paceLabel: 'Темп', perChapter: 'Уламків/розділ', chPerHour: '{n} розд/год',
    nowReading: 'Зараз читається', nextUp: 'Наступний', titles: 'Тайтлів: {n}', allDone: 'Усі тайтли готові',
    startFarm: 'Почати фарм', stopFarm: 'Зупинити', windowNote: 'Читання йде в окремому вікні — не закривайте його',
    login: 'Увійти', addTitles: 'Додати тайтли', emptyHero: 'Виберіть тайтли — розширення читатиме розділи, які зараз дають уламки, доки не назбирає на всі карти.',
    selected: 'Вибрано: {n}', ranksHint: 'Мета — уламки на всі відсутні карти вибраних рангів',
    loggedAs: 'Акаунт: {name}',
    notLogged: 'Немає входу в акаунт MangaLib. Увійдіть на сайті й відкрийте вікно знову.',
    noTab: 'Відкрийте mangalib.me, щоб перевірити акаунт.',
    openSite: 'Відкрити MangaLib',
    reloadTab: 'Перезавантажте вкладку MangaLib і відкрийте вікно знову.',
    start: 'Старт', stop: 'Стоп',
    startHint: 'Читання йде в окремому вікні. Його можна сховати за інші вікна, але не закривати.',
    eta: 'Залишилось ≈ {t}', etaUnknown: 'Залишилось: рахую…',
    pace: '~{ch} розділів/год · ~{sh} уламка/розділ',
    tabQueue: 'Черга', tabAdd: 'Додати', tabSettings: 'Налаштування',
    emptyQueue: 'Список порожній. Додайте тайтли у вкладці «Додати».',
    shards: '{b} / {n} уламків', done: 'Готово', noCards: 'Немає карт', now: 'читається',
    up: 'Вище', down: 'Нижче', remove: 'Видалити',
    addCurrent: 'Тайтл з поточної вкладки',
    searchTitle: 'Пошук', search: 'Назва тайтлу…', bookmarks: 'З моїх закладок', folder: 'Папка',
    addSelected: 'Додати вибрані', add: 'Додати',
    added: 'Додано: {n}', already: 'Вже у списку', notTitlePage: 'Відкрийте сторінку тайтлу або розділ.',
    nothing: 'Нічого не знайдено',
    speed: 'Швидкість',
    slow: 'Повільно', normal: 'Звичайно', fast: 'Швидко', custom: 'Своя',
    hint_slow: 'Найбезпечніше: довгі паузи й не більше 120 розділів на день.', hint_normal: 'Баланс швидкості й обережності.', hint_fast: 'Швидше, але помітніше для антифроду.', hint_custom: 'Свої значення нижче.',
    secPerPage: 'Секунд на сторінку', breakEvery: 'Перерва кожні … розділів', breakLen: 'Тривалість перерви, хв',
    dailyMax: 'Розділів на день (0 = без ліміту)', ranks: 'Збирати карти рангів', language: 'Мова',
    d: 'д', h: 'год', m: 'хв', mo: 'міс.', y: 'р.',
    st_starting: 'Запуск…',
    st_stopped: 'Зупинено',
    st_open: 'Відкриваю «{name}» з 1 розділу',
    st_progress: '«{name}»: {b}/{n} уламків · розділів сьогодні: {c}',
    st_break: 'Перерва {m} хв',
    st_daily: 'Денний ліміт {n} розділів, продовжу завтра',
    st_title_done: '«{name}» готовий, переходжу до наступного',
    st_all_done: 'Усі тайтли готові',
    st_ad_wait: 'Реклама на екрані, чекаю',
    st_ad_closed: 'Закрив рекламу',
    st_ad_hidden: 'Сховав рекламу',
    st_stuck: 'Читалка не відповідає ({n}/6)',
    st_reload: 'Перезавантажую розділ',
    st_error: 'Помилка: {e}. Повтор за хвилину',
    st_restored: 'Закладки відновлено',
    st_tab_closed: 'Зупинено: вікно читання закрито',
    st_not_logged: 'Зупинено: немає входу в акаунт',
  },
};

function t(lang, key, params = {}) {
  const s = (STR[lang] || STR.ru)[key] ?? STR.ru[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? '');
}

function formatDuration(lang, sec) {
  if (sec == null || !isFinite(sec)) return '∞';
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.round((sec % 3600) / 60);
  const u = k => t(lang, k);
  if (d >= 365) return `${(d / 365).toFixed(1)} ${u('y')}`;
  if (d >= 60) return `${Math.round(d / 30)} ${u('mo')}`;
  if (d >= 10) return `${d}${u('d')}`;
  if (d) return `${d}${u('d')} ${h}${u('h')}`;
  if (h) return `${h}${u('h')} ${m}${u('m')}`;
  return `${m} ${u('m')}`;
}
