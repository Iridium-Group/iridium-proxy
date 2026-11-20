'use strict';
const form = document.getElementById('go');
const input = document.getElementById('url');
const note = document.getElementById('note');
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

/** Turn what was typed into an address: a URL as is, "example.com" as https, anything else a search. */
function toAddress(text) {
  const v = text.trim();
  if (!v) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return v;
  if (!/\s/.test(v) && /^[^\s/]+\.[^\s/]{2,}(\/|$|\?|#|:)/.test(v + '/')) return 'https://' + v;
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(v);
}

const openUrl = (address) => {
  location.href = '/klyro/go?u=' + encodeURIComponent(address);
};

function render(id, items, removable) {
  const ul = document.getElementById(id);
  ul.replaceChildren();
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'none yet';
    ul.append(li);
    return;
  }
  for (const address of items) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '/klyro/go?u=' + encodeURIComponent(address);
    a.textContent = address.replace(/^https?:\/\//, '');
    a.title = address;
    li.append(a);
    if (removable) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = '×';
      b.setAttribute('aria-label', 'remove ' + address);
      b.addEventListener('click', () => removable(address));
      li.append(b);
    }
    ul.append(li);
  }
}

function refresh() {
  render('recent', store.get(KEY.recent, []), null);
  render('favorites', store.get(KEY.fav, []), (address) => {
    store.set(
      KEY.fav,
      store.get(KEY.fav, []).filter((x) => x !== address),
    );
    refresh();
  });
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const address = toAddress(input.value);
  if (!address) {
    note.textContent = 'Enter a web address.';
    return;
  }
  try {
    new URL(address);
  } catch {
    note.textContent = 'That is not a valid address.';
    return;
  }
  note.textContent = '';
  if (document.getElementById('keep').checked) {
    const recent = [address, ...store.get(KEY.recent, []).filter((x) => x !== address)].slice(0, 8);
    store.set(KEY.recent, recent);
  }
  openUrl(address);
});

document.getElementById('fav').addEventListener('click', () => {
  const address = toAddress(input.value);
  if (!address) {
    note.textContent = 'Type an address first.';
    return;
  }
  const favs = store.get(KEY.fav, []);
  if (!favs.includes(address)) store.set(KEY.fav, [...favs, address].slice(0, 20));
  note.textContent = '';
  refresh();
});

document.getElementById('clear').addEventListener('click', () => {
  store.set(KEY.recent, []);
  store.set(KEY.fav, []);
  refresh();
});

const keep = document.getElementById('keep');
keep.checked = store.get(KEY.keep, true);
keep.addEventListener('change', () => {
  store.set(KEY.keep, keep.checked);
  if (!keep.checked) {
    store.set(KEY.recent, []);
    refresh();
  }
});

refresh();
