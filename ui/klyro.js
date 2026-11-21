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
const KEY = { recent: 'klyro.recent', fav: 'klyro.favorites', keep: 'klyro.keep' };

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
};

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
  const tab = { id: nextId++, title: 'New tab', url: '', frame: null, button: null };
  tabs.push(tab);
  select(tab);
  if (addr) open(tab, addr);
  return tab;
}

function closeTab(tab) {
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  tab.frame?.remove();
  tabs.splice(i, 1);
  if (tabs.length === 0) return void newTab();
  if (active === tab) select(tabs[Math.min(i, tabs.length - 1)]);
  else renderTabs();
}

function select(tab) {
  active = tab;
  for (const t of tabs) if (t.frame) t.frame.hidden = t !== tab;
  homeView.hidden = !!tab.frame;
  renderTabs();
  syncBar();
  if (!tab.frame) $('url').focus();
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
  remember(addr);
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
}

function syncBar() {
  const framed = !!active?.frame;
  if (document.activeElement !== address) address.value = framed ? active.url : '';
  $('back').disabled = $('fwd').disabled = $('reload').disabled = !framed;
  $('star').disabled = !framed;
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
$('star').addEventListener('click', () => {
  if (!active?.url) return;
  const favs = store.get(KEY.fav, []);
  if (!favs.includes(active.url)) store.set(KEY.fav, [...favs, active.url].slice(0, 20));
  renderLists();
});
address.addEventListener('focus', () => address.select());
window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'l') {
    e.preventDefault();
    address.focus();
  }
  if (mod && e.key.toLowerCase() === 't') {
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

// ---------- recent, favorites, settings ----------
function remember(addr) {
  if (!$('keep').checked) return;
  store.set(KEY.recent, [addr, ...store.get(KEY.recent, []).filter((x) => x !== addr)].slice(0, 8));
  renderLists();
}

function renderList(id, items, remove) {
  const ul = $(id);
  ul.replaceChildren();
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'none yet';
    ul.append(li);
    return;
  }
  for (const item of items) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.textContent = item.replace(/^https?:\/\//, '');
    a.title = item;
    a.addEventListener('click', () => open(active ?? newTab(), item));
    li.append(a);
    if (remove) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = '×';
      b.setAttribute('aria-label', 'remove ' + item);
      b.addEventListener('click', () => remove(item));
      li.append(b);
    }
    ul.append(li);
  }
}

function renderLists() {
  renderList('recent', store.get(KEY.recent, []), null);
  renderList('favorites', store.get(KEY.fav, []), (item) => {
    store.set(
      KEY.fav,
      store.get(KEY.fav, []).filter((x) => x !== item),
    );
    renderLists();
  });
}

$('clear').addEventListener('click', () => {
  store.set(KEY.recent, []);
  store.set(KEY.fav, []);
  renderLists();
});
$('keep').checked = store.get(KEY.keep, true);
$('keep').addEventListener('change', () => {
  store.set(KEY.keep, $('keep').checked);
  if (!$('keep').checked) {
    store.set(KEY.recent, []);
    renderLists();
  }
});

renderLists();
newTab();
