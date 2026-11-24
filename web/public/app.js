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

let controller;
let frame;

/** If one of the scripts did not start, say which, and why, in words a person can send back. */
function explainMissing() {
  const missing = [];
  if (typeof $scramjet === 'undefined') missing.push('Scramjet (scramjet.js)');
  if (typeof $scramjetController === 'undefined' || !$scramjetController?.Controller)
    missing.push('the Scramjet controller (controller.api.js)');
  if (typeof LibcurlTransport === 'undefined') missing.push('the transport (libcurl/index.js)');
  if (!missing.length) return '';
  const why = (window.__loadErrors ?? []).join('; ');
  return `${missing.join(' and ')} did not start${why ? `: ${why}` : ''}. Browser: ${navigator.userAgent}`;
}

async function setup() {
  if (!navigator.serviceWorker) {
    throw new Error('Service workers need https (or localhost) and a modern browser.');
  }
  const problem = explainMissing();
  if (problem) throw new Error(problem);
  const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  const { active } = await navigator.serviceWorker.ready;
  // A static host (for example Vercel) cannot run Wisp, so config.js can point at a separate server.
  const wisp =
    window.IRIDIUM_WISP ||
    `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/wisp/`;
  const transport = new LibcurlTransport.LibcurlClient({ websocket: wisp });
  await transport.init();
  controller = new $scramjetController.Controller({
    serviceworker: active ?? registration.active,
    transport,
  });
  await controller.wait();
}

let setupDone;
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    setStatus('Starting…');
    setupDone ??= setup();
    await setupDone;
    frame ??= (() => {
      const element = document.createElement('iframe');
      element.id = 'frame';
      stage.replaceChildren(element);
      return controller.createFrame(element);
    })();
    frame.go(toUrl(input.value));
    setStatus('');
  } catch (error) {
    setupDone = undefined;
    setStatus(String(error?.message ?? error), true);
  }
});
