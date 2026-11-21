'use strict';
// Klyro's browser shell: tabs, address bar and navigation around the proxied page.
// Every tab is an <iframe> pointing at Klyro's own /k/<session>/... address, so the page
// is same-origin with this shell and its title and URL can be read.

// Never run inside a proxied page's frame (for example from an error page's "back" link).
if (self !== top) top.location = location.href;

const $ = (id) => document.getElementById(id);
const tabsEl = $('tabs');
const views = $('views');
const homeView = $('homeview');
const address = $('address');
const FAV = 'klyro.favorites';
const TABS = 'klyro.tabs';
const CLOSED = 'klyro.closed';

const store = {
  get(k, fallback) {
    try {
      return JSON.parse(localStorage.getItem(k)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* storage may be blocked */
    }
  },
  remove(k) {
    try {
      localStorage.removeItem(k);
    } catch {
      /* storage may be blocked */
    }
  },
};

// Earlier versions kept a list of recent addresses. It is gone, so delete what it saved.
store.remove('klyro.recent');
store.remove('klyro.keep');

/** What was typed into an address: a URL as is, "example.com" as https, anything else a search. */
function toAddress(text) {
  const v = text.trim();
  if (!v) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v;
  if (!/\s/.test(v) && /^[^\s/]+\.[^\s/]{2,}(\/|$|\?|#|:)/.test(v + '/')) return 'https://' + v;
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(v);
}

/** Turn a Klyro path (/k/<session>/https/host/path?q) back into the real URL, or null. */
function upstreamOf(pathname, search) {
  const m = /^\/k\/[\w-]{22}\/(https?|wss?)\/([^/?#]+)(\/.*)?$/.exec(pathname);
  if (!m) return null;
  return `${m[1].replace(/^ws/, 'http')}://${m[2]}${m[3] ?? '/'}${search}`;
}

// ---------- tabs ----------
let nextId = 1;
const tabs = [];
let active = null;

function newTab(addr) {
  const tab = {
    id: nextId++,
    title: 'New tab',
    url: '',
    pendingUrl: '',
    frame: null,
    button: null,
  };
  tabs.push(tab);
  select(tab);
  if (addr) open(tab, addr);
  return tab;
}

function closeTab(tab) {
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  const url = tab.url || tab.pendingUrl;
  if (url) store.set(CLOSED, [{ url, title: tab.title }, ...store.get(CLOSED, [])].slice(0, 10));
  tab.frame?.remove();
  tabs.splice(i, 1);
  if (tabs.length === 0) newTab();
  else if (active === tab) select(tabs[Math.min(i, tabs.length - 1)]);
  else renderTabs();
  saveTabs();
}

/** Bring back the most recently closed tab (Ctrl/Cmd+Shift+T). */
function reopenClosed() {
  const [last, ...rest] = store.get(CLOSED, []);
  if (!last) return;
  store.set(CLOSED, rest);
  const tab = newTab();
  tab.title = last.title || 'New tab';
  open(tab, last.url);
}

function select(tab) {
  active = tab;
  if (tab.pendingUrl && !tab.frame) {
    // A tab restored from the last visit: load it now that it is being shown.
    const url = tab.pendingUrl;
    tab.pendingUrl = '';
    return void open(tab, url);
  }
  for (const t of tabs) if (t.frame) t.frame.hidden = t !== tab;
  homeView.hidden = !!tab.frame;
  renderTabs();
  syncBar();
  if (!tab.frame) $('url').focus();
  saveTabs();
}

function renderTabs() {
  tabsEl.replaceChildren();
  for (const tab of tabs) {
    const b = document.createElement('button');
    b.className = 'tab';
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(tab === active));
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = tab.title;
    t.title = tab.url || tab.title;
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.setAttribute('aria-label', 'Close tab');
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tab);
    });
    b.append(t, x);
    b.addEventListener('click', () => select(tab));
    tabsEl.append(b);
    tab.button = b;
  }
  const plus = document.createElement('button');
  plus.id = 'newtab';
  plus.type = 'button';
  plus.title = 'New tab';
  plus.setAttribute('aria-label', 'New tab');
  plus.textContent = '+';
  plus.addEventListener('click', () => newTab());
  tabsEl.append(plus);
}

// ---------- navigation ----------
function open(tab, addr) {
  if (!tab.frame) {
    const f = document.createElement('iframe');
    f.className = 'view';
    f.title = 'Page';
    f.addEventListener('load', () => refresh(tab));
    views.append(f);
    tab.frame = f;
  }
  tab.title = 'Loading…';
  tab.url = addr;
  // /klyro/go opens a session and redirects to the proxied address.
  tab.frame.src = '/klyro/go?u=' + encodeURIComponent(addr);
  select(tab);
}

/** Read the URL and title from a tab's page (same-origin, so this is allowed). */
function refresh(tab) {
  if (!tab.frame) return;
  try {
    const w = tab.frame.contentWindow;
    const real = upstreamOf(w.location.pathname, w.location.search);
    if (real) tab.url = real;
    const title = w.document.title;
    tab.title = title || (real ? new URL(real).host : 'Page');
  } catch {
    /* the frame is mid-navigation */
  }
  if (tab === active) syncBar();
  const label = tab.button?.querySelector('.t');
  if (label) {
    label.textContent = tab.title;
    label.title = tab.url;
  }
  saveTabs();
}

function syncBar() {
  const framed = !!active?.frame;
  if (document.activeElement !== address) address.value = framed ? active.url : '';
  $('back').disabled = $('fwd').disabled = $('reload').disabled = !framed;
  $('star').disabled = !framed;
  const starred = framed && store.get(FAV, []).some((f) => f.url === active.url);
  $('star').classList.toggle('on', starred);
  $('star').title = starred ? 'Remove from favorites' : 'Add to favorites';
  document.title = framed && active.title ? `${active.title} · Klyro` : 'Klyro';
}

function go(text) {
  const addr = toAddress(text);
  if (!addr) return false;
  try {
    new URL(addr);
  } catch {
    return false;
  }
  open(active ?? newTab(), addr);
  return true;
}

$('bar').addEventListener('submit', (e) => {
  e.preventDefault();
  go(address.value);
  address.blur();
});
$('go').addEventListener('submit', (e) => {
  e.preventDefault();
  const note = $('note');
  if (go($('url').value)) {
    note.textContent = '';
    $('url').value = '';
  } else note.textContent = 'Enter a web address or a search.';
});
$('back').addEventListener('click', () => {
  try {
    active.frame.contentWindow.history.back();
  } catch {
    /* ignore */
  }
});
$('fwd').addEventListener('click', () => {
  try {
    active.frame.contentWindow.history.forward();
  } catch {
    /* ignore */
  }
});
$('reload').addEventListener('click', () => {
  try {
    active.frame.contentWindow.location.reload();
  } catch {
    /* ignore */
  }
});
$('home').addEventListener('click', () => {
  if (!active) return;
  active.frame?.remove();
  Object.assign(active, { frame: null, url: '', title: 'New tab' });
  select(active);
});
address.addEventListener('focus', () => address.select());
window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'l') {
    e.preventDefault();
    address.focus();
  }
  if (mod && e.shiftKey && e.key.toLowerCase() === 't') {
    e.preventDefault();
    reopenClosed();
  } else if (mod && e.key.toLowerCase() === 't') {
    e.preventDefault();
    newTab();
  }
  if (mod && e.key.toLowerCase() === 'w' && active) {
    e.preventDefault();
    closeTab(active);
  }
});

// Pages change their title and URL without a load event (single-page apps), so check now and then.
setInterval(() => {
  if (active?.frame) refresh(active);
}, 1000);

// ---------- saved tabs ----------
// Only addresses and titles are saved (never session identifiers), so a restored tab starts a fresh
// session. Sites you were signed in to will ask you to sign in again; Klyro does not keep logins.
let saveTimer = 0;
function saveTabs() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeTabs, 150);
}
function writeTabs() {
  const list = tabs.map((t) => ({
    url: t.url || t.pendingUrl || '',
    title: t.title && t.title !== 'Loading…' ? t.title : '',
  }));
  store.set(TABS, { active: Math.max(0, tabs.indexOf(active)), tabs: list });
}
window.addEventListener('pagehide', writeTabs);

function restoreTabs() {
  const saved = store.get(TABS, null);
  if (!saved || !Array.isArray(saved.tabs) || saved.tabs.length === 0) return false;
  for (const s of saved.tabs.slice(0, 20)) {
    tabs.push({
      id: nextId++,
      title: s.title || 'New tab',
      url: '',
      pendingUrl: typeof s.url === 'string' ? s.url : '',
      frame: null,
      button: null,
    });
  }
  select(tabs[Math.min(Math.max(0, saved.active | 0), tabs.length - 1)]);
  return true;
}

// ---------- favorites ----------
const COLORS = [
  '#5b4df0',
  '#0ea5a4',
  '#e0662f',
  '#c2417c',
  '#3b82f6',
  '#16a34a',
  '#a855f7',
  '#d97706',
];
const colorFor = (s) =>
  COLORS[[...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % COLORS.length];
const hostOf = (u) => {
  try {
    return new URL(u).host.replace(/^www\./, '');
  } catch {
    return u;
  }
};

function renderFavorites() {
  const favs = store.get(FAV, []);
  const ul = $('favorites');
  ul.replaceChildren();
  for (const f of favs) {
    const host = hostOf(f.url);
    const li = document.createElement('li');
    li.className = 'fav';
    li.title = f.url;
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.style.background = colorFor(host);
    badge.textContent = (host[0] ?? '?').toUpperCase();
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = f.title || host;
    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.type = 'button';
    rm.textContent = '×';
    rm.setAttribute('aria-label', 'Remove ' + host);
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      store.set(
        FAV,
        store.get(FAV, []).filter((x) => x.url !== f.url),
      );
      renderFavorites();
      syncBar();
    });
    li.append(badge, name, rm);
    li.addEventListener('click', () => open(active ?? newTab(), f.url));
    ul.append(li);
  }
}

$('star').addEventListener('click', () => {
  if (!active?.url) return;
  const favs = store.get(FAV, []);
  const i = favs.findIndex((f) => f.url === active.url);
  if (i >= 0) favs.splice(i, 1);
  else
    favs.push({
      url: active.url,
      title: active.title && active.title !== 'Loading…' ? active.title : '',
    });
  store.set(FAV, favs.slice(0, 18));
  renderFavorites();
  syncBar();
});
$('clear').addEventListener('click', (e) => {
  e.preventDefault();
  store.set(FAV, []);
  store.remove(TABS);
  store.remove(CLOSED);
  renderFavorites();
  syncBar();
});

// Favorites saved by earlier versions were plain address strings.
store.set(
  FAV,
  store.get(FAV, []).map((f) => (typeof f === 'string' ? { url: f, title: '' } : f)),
);
renderFavorites();
if (!restoreTabs()) newTab();
