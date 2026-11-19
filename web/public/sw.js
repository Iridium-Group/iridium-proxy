// Service worker: sends proxied requests through Scramjet and everything else straight through.
importScripts('/scram/scramjet.all.js');

const { ScramjetServiceWorker } = $scramjetLoadWorker();
const scramjet = new ScramjetServiceWorker();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

async function handle(event) {
  await scramjet.loadConfig();
  if (scramjet.route(event)) return scramjet.fetch(event);
  return fetch(event.request);
}

self.addEventListener('fetch', (event) => event.respondWith(handle(event)));
