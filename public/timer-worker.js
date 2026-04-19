/**
 * Web Worker for throttle-resistant timers.
 *
 * Browsers throttle setInterval/setTimeout on hidden tabs, which causes
 * WebSocket keepalive pings to be delayed and connections to drop.
 * Workers are exempt from this throttling, so we use one to fire
 * reliable intervals regardless of tab visibility.
 *
 * Protocol:
 *   Main → Worker: { type: 'interval:start', id: string, ms: number }
 *   Main → Worker: { type: 'interval:stop', id: string }
 *   Worker → Main: { type: 'tick', id: string }
 */

const timers = {};

self.onmessage = (e) => {
  const { type, id, ms } = e.data;
  if (type === 'interval:start') {
    if (timers[id]) clearInterval(timers[id]);
    timers[id] = setInterval(() => {
      self.postMessage({ type: 'tick', id });
    }, ms);
  } else if (type === 'interval:stop') {
    clearInterval(timers[id]);
    delete timers[id];
  }
};
