import evalscope from './evalscope.js';
import jmeter from './jmeter.js';
import locust from './locust.js';

export const engines = [evalscope, locust, jmeter];

export function getEngine(id) {
  return engines.find((e) => e.id === id) ?? null;
}

export function engineSummaries() {
  return engines.map((e) => ({
    id: e.id,
    name: e.name,
    tagline: e.tagline,
    category: e.category,
    accent: e.accent,
    docs: e.docs,
    install: e.install,
    binary: e.binary,
    defaults: e.defaults,
    fields: e.fields,
  }));
}

let cache = null;
let cacheAt = 0;
const TTL = 30_000;

/** Probe every engine CLI; results are cached briefly to keep the UI snappy. */
export async function detectAll({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache && now - cacheAt < TTL) return cache;
  const results = await Promise.all(
    engines.map(async (e) => {
      try {
        const r = await e.detect();
        return { id: e.id, name: e.name, ...r };
      } catch (err) {
        return {
          id: e.id, name: e.name, available: false, mode: 'demo',
          detail: `检测失败：${err?.message || err}`,
        };
      }
    }),
  );
  cache = results;
  cacheAt = now;
  return results;
}

export function invalidateDetection() {
  cache = null;
}
