// Service worker: sends the proxied pages' requests through the Scramjet controller and leaves
// everything else alone. The controller's file also handles install and activate.
importScripts('/controller/controller.sw.js');

addEventListener('fetch', (event) => {
  if ($scramjetController.shouldRoute(event)) {
    event.respondWith($scramjetController.route(event));
  }
});
