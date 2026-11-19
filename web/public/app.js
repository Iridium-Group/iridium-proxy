'use strict';
const form = document.getElementById('form');
const input = document.getElementById('address');
const status = document.getElementById('status');
const stage = document.getElementById('stage');
const SEARCH = 'https://duckduckgo.com/?q=%s';

function toUrl(text) {
  const value = text.trim();
  try {
    return new URL(value).toString();
  } catch {}
  try {
    const url = new URL(`http://${value}`);
    if (url.hostname.includes('.') && !/\s/.test(value)) return url.toString();
  } catch {}
  return SEARCH.replace('%s', encodeURIComponent(value));
}

const setStatus = (text, bad = false) => {
  status.textContent = text;
  status.dataset.bad = bad ? '1' : '';
};

const { ScramjetController } = $scramjetLoadController();
const scramjet = new ScramjetController({
  files: {
    wasm: '/scram/scramjet.wasm.wasm',
    all: '/scram/scramjet.all.js',
    sync: '/scram/scramjet.sync.js',
  },
});
const ready = scramjet.init();
const connection = new BareMux.BareMuxConnection('/baremux/worker.js');
let frame;

async function setup() {
  if (!navigator.serviceWorker) {
    throw new Error('Service workers need https (or localhost) and a modern browser.');
  }
  await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  await ready;
  const wisp = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/wisp/`;
  await connection.setTransport('/libcurl/index.mjs', [{ websocket: wisp }]);
}

let setupDone;
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    setStatus('Starting…');
    setupDone ??= setup();
    await setupDone;
    frame ??= (() => {
      const f = scramjet.createFrame();
      f.frame.id = 'frame';
      stage.replaceChildren(f.frame);
      return f;
    })();
    frame.go(toUrl(input.value));
    setStatus('');
  } catch (error) {
    setupDone = undefined;
    setStatus(String(error?.message ?? error), true);
  }
});
