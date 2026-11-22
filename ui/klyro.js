'use strict';
// Klyro's browser shell: a vertical tab sidebar (pinned tabs, groups, drag to reorder), an address
// bar and the proxied pages. Every tab is an <iframe> pointing at Klyro's own /k/<session>/...
// address, so the page is same-origin with this shell and its title and URL can be read.

// Never run inside a proxied page's frame (for example from an error page's "back" link).
if (self !== top) top.location = location.href;

const $ = (id) => document.getElementById(id);
const tabsEl = $('tabs');
const pinnedEl = $('pinned');
const views = $('views');
const homeView = $('homeview');
const address = $('address');
const bar = $('bar');
const stripEl = $('strip');
const chromeEl = $('chrome');
const starBtn = document.getElementById('star');
const suggestEl = $('suggest');
const ctx = $('ctx');
const FAV = 'klyro.favorites';
const TABS = 'klyro.tabs';
const CLOSED = 'klyro.closed';
const MAX_TABS = 60;

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

const hostOf = (u) => {
  try {
    return new URL(u).host.replace(/^www\./, '');
  } catch {
    return u;
  }
};
// Group colours: greys from white to charcoal, told apart by lightness and by the group's name.
const COLORS = [
  '#ffffff',
  '#c4c4c4',
  '#8e8e8e',
  '#5c5c5c',
  '#dedede',
  '#a6a6a6',
  '#737373',
  '#3f3f3f',
];
const uid = () => Math.random().toString(36).slice(2, 8);

// ---------- state ----------
let nextId = 1;
/** @type {{id:number,title:string,url:string,pendingUrl:string,frame:HTMLIFrameElement|null,button:HTMLElement|null,pinned:boolean,group:string|null,loading:boolean}[]} */
const tabs = [];
/** @type {{id:string,name:string,color:string,collapsed:boolean}[]} */
let groups = [];
let active = null;

function makeTab(extra = {}) {
  return {
    id: nextId++,
    title: 'New tab',
    url: '',
    pendingUrl: '',
    frame: null,
    button: null,
    pinned: false,
    group: null,
    loading: false,
    ...extra,
  };
}

function newTab(addr, opts = {}) {
  if (tabs.length >= MAX_TABS) return active;
  const tab = makeTab(opts);
  const at = opts.after ? tabs.indexOf(opts.after) + 1 : tabs.length;
  tabs.splice(at, 0, tab);
  select(tab);
  if (addr) open(tab, addr);
  return tab;
}

function cleanGroups() {
  const used = new Set(tabs.map((t) => t.group));
  groups = groups.filter((g) => used.has(g.id));
}

function closeTab(tab) {
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  const url = tab.url || tab.pendingUrl;
  if (url) store.set(CLOSED, [{ url, title: tab.title }, ...store.get(CLOSED, [])].slice(0, 10));
  tab.frame?.remove();
  tabs.splice(i, 1);
  cleanGroups();
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
  tab.button?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  syncBar();
  if (!tab.frame) $('url').focus({ preventScroll: true });
  saveTabs();
}

// ---------- sidebar ----------
const ICON_MORE =
  '<svg viewBox="0 0 24 24"><circle cx="5.5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="18.5" cy="12" r="1.2"/></svg>';
const ICON_CHEV = '<svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';

function badge(tab) {
  const b = document.createElement('span');
  b.className = 'fav-badge';
  const host = tab.url ? hostOf(tab.url) : tab.pendingUrl ? hostOf(tab.pendingUrl) : '';
  if (host) {
    b.textContent = (host[0] ?? '?').toUpperCase();
  } else {
    b.classList.add('blank');
  }
  return b;
}

function tabEl(tab) {
  const el = document.createElement('div');
  el.className = 'tab' + (tab.pinned ? ' pin' : '') + (tab.loading ? ' loading' : '');
  el.setAttribute('role', 'tab');
  el.tabIndex = 0;
  el.setAttribute('aria-selected', String(tab === active));
  el.title = tab.url || tab.title;
  const t = document.createElement('span');
  t.className = 't' + (tab.url || tab.pendingUrl ? '' : ' dim');
  t.textContent = tab.title;
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'more';
  more.setAttribute('aria-label', 'Tab options');
  more.innerHTML = ICON_MORE;
  more.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = more.getBoundingClientRect();
    tabMenu(tab, r.left, r.bottom + 4);
  });
  const x = document.createElement('button');
  x.type = 'button';
  x.className = 'x';
  x.textContent = '×';
  x.setAttribute('aria-label', 'Close tab');
  x.addEventListener('click', (e) => {
    e.stopPropagation();
    closeTab(tab);
  });
  el.append(badge(tab), t, more, x);
  // The selected tab is the address bar: it expands and the others stay small (Safari's compact bar).
  if (tab === active && !tab.pinned) el.insertBefore(bar, more);
  el.addEventListener('click', (e) => {
    // Clicks inside the address bar (the selected tab hosts it) belong to the field: selecting the
    // tab again would redraw the row and take focus away from what is being typed.
    if (tab === active && e.target.closest('#bar')) return;
    if (tab !== active) select(tab);
  });
  el.addEventListener('keydown', (e) => {
    if (e.target === el && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      select(tab);
    }
  });
  el.addEventListener('auxclick', (e) => {
    if (e.button === 1) {
      e.preventDefault();
      closeTab(tab);
    }
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    tabMenu(tab, e.clientX, e.clientY);
  });
  wireDrag(el, tab);
  tab.button = el;
  return el;
}

function groupEl(g, members) {
  const wrap = document.createElement('div');
  wrap.className = 'group' + (g.collapsed ? ' collapsed' : '');
  wrap.style.setProperty('--gc', g.color);
  const head = document.createElement('div');
  head.className = 'ghead';
  head.innerHTML =
    ICON_CHEV + '<span class="dot"></span><span class="gname"></span><span class="count"></span>';
  head.querySelector('.dot').style.background = g.color;
  head.querySelector('.gname').textContent = g.name;
  head.querySelector('.count').textContent = g.collapsed ? String(members.length) : '';
  head.title = g.name + ' · click to ' + (g.collapsed ? 'expand' : 'collapse');
  head.addEventListener('click', () => {
    g.collapsed = !g.collapsed;
    renderTabs();
    saveTabs();
  });
  head.addEventListener('dblclick', () => renameGroup(g, head));
  head.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    groupMenu(g, head, e.clientX, e.clientY);
  });
  head.addEventListener('dragover', (e) => {
    if (!drag) return;
    e.preventDefault();
    head.classList.add('over');
  });
  head.addEventListener('dragleave', () => head.classList.remove('over'));
  head.addEventListener('drop', (e) => {
    e.preventDefault();
    head.classList.remove('over');
    if (drag) moveToGroup(drag, g);
  });
  const body = document.createElement('div');
  body.className = 'gbody';
  for (const t of members) body.append(tabEl(t));
  wrap.append(head, body);
  return wrap;
}

function renderTabs() {
  stripEl.append(bar); // keep it alive while the old tabs are discarded
  pinnedEl.replaceChildren();
  tabsEl.replaceChildren();
  for (const t of tabs) if (t.pinned) pinnedEl.append(tabEl(t));
  const done = new Set();
  for (const t of tabs) {
    if (t.pinned) continue;
    const g = t.group && groups.find((x) => x.id === t.group);
    if (!g) {
      tabsEl.append(tabEl(t));
    } else if (!done.has(g.id)) {
      done.add(g.id);
      tabsEl.append(
        groupEl(
          g,
          tabs.filter((x) => !x.pinned && x.group === g.id),
        ),
      );
    }
  }
  if (active?.pinned) stripEl.insertBefore(bar, tabsEl); // no tab to host it
}

function renameGroup(g, head) {
  const span = head.querySelector('.gname');
  const input = document.createElement('input');
  input.value = g.name;
  input.maxLength = 30;
  input.setAttribute('aria-label', 'Group name');
  span.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const finish = (commit) => {
    if (finished) return;
    finished = true;
    if (commit && input.value.trim()) g.name = input.value.trim();
    renderTabs();
    saveTabs();
  };
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}

// ---------- grouping, pinning, moving ----------
function newGroupWith(tab) {
  const used = new Set(groups.map((g) => g.color));
  const color = COLORS.find((c) => !used.has(c)) ?? COLORS[groups.length % COLORS.length];
  const g = { id: uid(), name: 'Group ' + (groups.length + 1), color, collapsed: false };
  groups.push(g);
  tab.pinned = false;
  tab.group = g.id;
  cleanGroups();
  renderTabs();
  saveTabs();
  const head = tabsEl.querySelectorAll('.ghead')[groups.indexOf(g)];
  if (head) renameGroup(g, head);
}

function setGroup(tab, g) {
  tab.pinned = false;
  tab.group = g ? g.id : null;
  cleanGroups();
  renderTabs();
  saveTabs();
}

function setPinned(tab, on) {
  tab.pinned = on;
  if (on) tab.group = null;
  cleanGroups();
  renderTabs();
  saveTabs();
}

/** Take a tab out of the list, then put it back where `where(rest)` says (an index into the rest). */
function reinsert(src, where) {
  tabs.splice(tabs.indexOf(src), 1);
  tabs.splice(Math.max(0, Math.min(where(tabs), tabs.length)), 0, src);
}
const lastIndex = (pred) => (list) => list.reduce((a, t, i) => (pred(t) ? i : a), -1);

function moveTab(src, target, before) {
  if (src === target) return;
  reinsert(src, (rest) => rest.indexOf(target) + (before ? 0 : 1));
  src.pinned = target.pinned;
  src.group = target.group;
  cleanGroups();
  renderTabs();
  saveTabs();
}

function moveToGroup(src, g) {
  reinsert(src, (rest) => {
    const last = lastIndex((t) => t.group === g.id)(rest);
    return last < 0 ? rest.length : last + 1;
  });
  src.pinned = false;
  src.group = g.id;
  cleanGroups();
  renderTabs();
  saveTabs();
}

// ---------- drag and drop ----------
let drag = null;
function wireDrag(el, tab) {
  // The selected tab holds the address field, and a draggable parent stops a field from taking a
  // text cursor in some browsers, so it is not draggable; every other tab is.
  el.draggable = !(tab === active && !tab.pinned);
  el.addEventListener('dragstart', (e) => {
    drag = tab;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tab.url || '');
    el.classList.add('dragging');
    document.body.classList.add('dragging');
  });
  el.addEventListener('dragend', () => {
    drag = null;
    document.body.classList.remove('dragging');
    renderTabs();
  });
  const side = (e) => {
    const r = el.getBoundingClientRect();
    return e.clientX < r.left + r.width / 2;
  };
  el.addEventListener('dragover', (e) => {
    if (!drag || drag === tab) return;
    e.preventDefault();
    e.stopPropagation();
    const before = side(e);
    el.classList.toggle('drop-before', before);
    el.classList.toggle('drop-after', !before);
  });
  el.addEventListener('dragleave', () => el.classList.remove('drop-before', 'drop-after'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const before = side(e);
    el.classList.remove('drop-before', 'drop-after');
    if (drag) moveTab(drag, tab, before);
  });
}
function dropZone(zone, onDrop) {
  zone.addEventListener('dragover', (e) => {
    if (!drag) return;
    e.preventDefault();
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', (e) => {
    if (e.target === zone) zone.classList.remove('over');
  });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    if (drag) onDrop(drag);
  });
}
dropZone(pinnedEl, (t) => {
  reinsert(t, (rest) => lastIndex((x) => x.pinned)(rest) + 1);
  t.pinned = true;
  t.group = null;
  cleanGroups();
  renderTabs();
  saveTabs();
});
dropZone(tabsEl, (t) => {
  reinsert(t, (rest) => rest.length);
  t.pinned = false;
  t.group = null;
  cleanGroups();
  renderTabs();
  saveTabs();
});

// ---------- context menus ----------
function showMenu(items, x, y) {
  ctx.replaceChildren();
  for (const it of items) {
    if (it === '-') {
      ctx.append(document.createElement('hr'));
      continue;
    }
    if (it.heading) {
      const h = document.createElement('div');
      h.className = 'sub';
      h.textContent = it.heading;
      ctx.append(h);
      continue;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = it.label;
    b.addEventListener('click', () => {
      hideMenu();
      it.run();
    });
    ctx.append(b);
  }
  ctx.hidden = false;
  const r = ctx.getBoundingClientRect();
  ctx.style.left = Math.max(6, Math.min(x, innerWidth - r.width - 6)) + 'px';
  ctx.style.top = Math.max(6, Math.min(y, innerHeight - r.height - 6)) + 'px';
  ctx.querySelector('button')?.focus();
}
function hideMenu() {
  ctx.hidden = true;
}
document.addEventListener('pointerdown', (e) => {
  if (!ctx.hidden && !ctx.contains(e.target)) hideMenu();
});
document.addEventListener('scroll', hideMenu, true);

function tabMenu(tab, x, y) {
  const items = [];
  items.push({
    label: tab.pinned ? 'Unpin tab' : 'Pin tab',
    run: () => setPinned(tab, !tab.pinned),
  });
  items.push({ label: 'New group with this tab', run: () => newGroupWith(tab) });
  const others = groups.filter((g) => g.id !== tab.group);
  if (others.length) {
    items.push({ heading: 'Move to group' });
    for (const g of others) items.push({ label: g.name, run: () => setGroup(tab, g) });
  }
  if (tab.group) items.push({ label: 'Remove from group', run: () => setGroup(tab, null) });
  items.push('-');
  if (tab.url || tab.pendingUrl)
    items.push({
      label: 'Duplicate',
      run: () => newTab(tab.url || tab.pendingUrl, { after: tab, group: tab.group, pinned: false }),
    });
  items.push({
    label: 'Close other tabs',
    run: () => {
      for (const t of [...tabs]) if (t !== tab && !t.pinned) closeTab(t);
      select(tab);
    },
  });
  items.push({ label: 'Close tab', run: () => closeTab(tab) });
  showMenu(items, x, y);
}

function groupMenu(g, head, x, y) {
  showMenu(
    [
      { label: 'Rename group', run: () => renameGroup(g, head) },
      {
        label: 'Change colour',
        run: () => {
          g.color = COLORS[(COLORS.indexOf(g.color) + 1) % COLORS.length];
          renderTabs();
          saveTabs();
        },
      },
      {
        label: g.collapsed ? 'Expand group' : 'Collapse group',
        run: () => {
          g.collapsed = !g.collapsed;
          renderTabs();
          saveTabs();
        },
      },
      '-',
      {
        label: 'Ungroup',
        run: () => {
          for (const t of tabs) if (t.group === g.id) t.group = null;
          cleanGroups();
          renderTabs();
          saveTabs();
        },
      },
      {
        label: 'Close group',
        run: () => {
          for (const t of tabs.filter((t) => t.group === g.id)) closeTab(t);
        },
      },
    ],
    x,
    y,
  );
}

// ---------- navigation ----------
function open(tab, addr) {
  if (!tab.frame) {
    const f = document.createElement('iframe');
    f.className = 'view';
    f.title = 'Page';
    f.addEventListener('load', () => {
      tab.loading = false;
      refresh(tab);
      tab.button?.classList.remove('loading');
    });
    views.append(f);
    tab.frame = f;
  }
  tab.title = 'Loading…';
  tab.url = addr;
  tab.loading = true;
  // /klyro/go opens a session and redirects to the proxied address.
  tab.frame.src = '/klyro/go?u=' + encodeURIComponent(addr);
  select(tab);
}

/** Read the URL and title from a tab's page (same-origin, so this is allowed). */
function refresh(tab) {
  if (!tab.frame) return;
  let urlChanged = false;
  try {
    const w = tab.frame.contentWindow;
    const real = upstreamOf(w.location.pathname, w.location.search);
    if (real && real !== tab.url) {
      urlChanged = hostOf(real) !== hostOf(tab.url);
      tab.url = real;
    }
    const title = w.document.title;
    tab.title = title || (real ? hostOf(real) : 'Page');
  } catch {
    /* the frame is mid-navigation */
  }
  if (tab === active) syncBar();
  const el = tab.button;
  if (el) {
    const label = el.querySelector('.t');
    label.textContent = tab.title;
    label.classList.remove('dim');
    el.title = tab.url;
    if (urlChanged) el.replaceChild(badge(tab), el.querySelector('.fav-badge'));
    else {
      const b = el.querySelector('.fav-badge');
      if (b.classList.contains('blank') && tab.url) el.replaceChild(badge(tab), b);
    }
  }
  saveTabs();
}

function syncBar() {
  const framed = !!active?.frame;
  if (document.activeElement !== address) address.value = framed ? active.url : '';
  $('back').disabled = $('fwd').disabled = $('reload').disabled = !framed;
  starBtn.disabled = !framed;
  const starred = framed && store.get(FAV, []).some((f) => f.url === active.url);
  starBtn.classList.toggle('on', starred);
  starBtn.title = starred ? 'Remove from favorites' : 'Add to favorites';
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
  Object.assign(active, { frame: null, url: '', title: 'New tab', loading: false });
  select(active);
});
$('newtab').addEventListener('click', () => newTab());

// ---------- address bar suggestions ----------
const suggest = suggestEl;
let sugItems = [];
let sugIndex = -1;

function closeSuggest() {
  suggest.hidden = true;
  sugItems = [];
  sugIndex = -1;
}
function paintSuggest() {
  suggest.replaceChildren();
  sugItems.forEach((s, i) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(i === sugIndex));
    const main = document.createElement('span');
    main.className = 's-main';
    main.textContent = s.text;
    const kind = document.createElement('span');
    kind.className = 's-kind';
    kind.textContent = s.kind;
    li.append(main, kind);
    li.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      s.run();
      closeSuggest();
      address.blur();
    });
    suggest.append(li);
  });
  suggest.hidden = sugItems.length === 0;
  if (!suggest.hidden) {
    // Sit under the address bar, as wide as it is (at least 320px) and inside the window.
    const c = chromeEl.getBoundingClientRect();
    const r = bar.getBoundingClientRect();
    const width = Math.min(Math.max(r.width, 320), innerWidth - 16);
    suggest.style.width = width + 'px';
    suggest.style.left = Math.max(8, Math.min(r.left - c.left, innerWidth - width - 8)) + 'px';
  }
}
function updateSuggest() {
  const q = address.value.trim();
  if (!q || document.activeElement !== address) return closeSuggest();
  const lower = q.toLowerCase();
  const items = [];
  const looksUrl = toAddress(q) && !toAddress(q).startsWith('https://duckduckgo.com/?q=');
  items.push({
    text: q,
    kind: looksUrl ? 'Go to address' : 'Search',
    run: () => go(q),
  });
  for (const t of tabs) {
    if (t === active || !(t.url || t.pendingUrl)) continue;
    const hay = `${t.title} ${t.url || t.pendingUrl}`.toLowerCase();
    if (hay.includes(lower))
      items.push({ text: t.title || hostOf(t.url), kind: 'Switch to tab', run: () => select(t) });
  }
  for (const f of store.get(FAV, [])) {
    const hay = `${f.title} ${f.url}`.toLowerCase();
    if (hay.includes(lower))
      items.push({
        text: f.title || hostOf(f.url),
        kind: 'Favorite',
        run: () => open(active ?? newTab(), f.url),
      });
  }
  sugItems = items.slice(0, 7);
  sugIndex = -1;
  paintSuggest();
}
address.addEventListener('input', updateSuggest);
address.addEventListener('focus', () => address.select());
address.addEventListener('blur', () => setTimeout(closeSuggest, 80));
address.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!sugItems.length) return;
    e.preventDefault();
    const n = sugItems.length;
    sugIndex = e.key === 'ArrowDown' ? (sugIndex + 1) % n : (sugIndex - 1 + n) % n;
    paintSuggest();
  } else if (e.key === 'Escape') {
    closeSuggest();
    address.value = active?.frame ? active.url : '';
    address.blur();
  }
});
bar.addEventListener('submit', (e) => {
  e.preventDefault();
  const pick = sugItems[sugIndex];
  if (pick) pick.run();
  else go(address.value);
  closeSuggest();
  address.blur();
});

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (e.key === 'Escape') hideMenu();
  if (mod && (k === 'l' || k === 'k')) {
    e.preventDefault();
    address.focus();
  } else if (mod && e.shiftKey && k === 't') {
    e.preventDefault();
    reopenClosed();
  } else if (mod && k === 't') {
    e.preventDefault();
    newTab();
  } else if (mod && k === 'w' && active) {
    e.preventDefault();
    closeTab(active);
  } else if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    const i = tabs.indexOf(active);
    const n = tabs.length;
    select(tabs[(i + (e.key === 'ArrowDown' ? 1 : n - 1)) % n]);
  } else if (e.altKey && /^[1-9]$/.test(e.key)) {
    e.preventDefault();
    const t = tabs[Number(e.key) - 1];
    if (t) select(t);
  }
});

// Pages change their title and URL without a load event (single-page apps), so check now and then.
setInterval(() => {
  if (active?.frame) refresh(active);
}, 1000);

// ---------- saved tabs ----------
// Only addresses, titles, pins and groups are saved (never session identifiers), so a restored tab
// starts a fresh session. Sites you were signed in to will ask you to sign in again.
let saveTimer = 0;
function saveTabs() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeTabs, 150);
}
function writeTabs() {
  store.set(TABS, {
    v: 2,
    active: Math.max(0, tabs.indexOf(active)),
    groups,
    tabs: tabs.map((t) => ({
      url: t.url || t.pendingUrl || '',
      title: t.title && t.title !== 'Loading…' ? t.title : '',
      pinned: t.pinned,
      group: t.group,
    })),
  });
}
window.addEventListener('pagehide', writeTabs);

function restoreTabs() {
  const saved = store.get(TABS, null);
  if (!saved || !Array.isArray(saved.tabs) || saved.tabs.length === 0) return false;
  if (Array.isArray(saved.groups)) {
    groups = saved.groups
      .filter((g) => g && typeof g.id === 'string')
      .slice(0, 20)
      .map((g) => ({
        id: g.id,
        name: String(g.name ?? 'Group').slice(0, 30),
        color: COLORS.includes(g.color) ? g.color : COLORS[0],
        collapsed: !!g.collapsed,
      }));
  }
  const ids = new Set(groups.map((g) => g.id));
  for (const s of saved.tabs.slice(0, MAX_TABS)) {
    tabs.push(
      makeTab({
        title: s.title || 'New tab',
        pendingUrl: typeof s.url === 'string' ? s.url : '',
        pinned: !!s.pinned,
        group: !s.pinned && ids.has(s.group) ? s.group : null,
      }),
    );
  }
  cleanGroups();
  select(tabs[Math.min(Math.max(0, saved.active | 0), tabs.length - 1)]);
  return true;
}

// ---------- favorites ----------
function renderFavorites() {
  const favs = store.get(FAV, []);
  const ul = $('favorites');
  ul.replaceChildren();
  for (const f of favs) {
    const host = hostOf(f.url);
    const li = document.createElement('li');
    li.className = 'fav';
    li.title = f.url;
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = (host[0] ?? '?').toUpperCase();
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
    li.append(b, name, rm);
    li.addEventListener('click', () => open(active ?? newTab(), f.url));
    ul.append(li);
  }
}

starBtn.addEventListener('click', () => {
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
