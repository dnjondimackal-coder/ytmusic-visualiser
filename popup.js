const api = globalThis.browser ?? globalThis.chrome;

const DEFAULTS = {
  enabled: true,
  intensity: 1.0,
  opacity: 1.0,
  pinnedMode: 'random',
  switchMin: 12,
  switchMax: 30,
  showName: true
};

const $ = (id) => document.getElementById(id);

function storageGet(defs) {
  return new Promise((res) => {
    try {
      const r = api.storage.local.get(defs, (v) => res(v || defs));
      if (r && typeof r.then === 'function') r.then((v) => res(v || defs), () => res(defs));
    } catch (e) { res(defs); }
  });
}
function save(patch) { try { api.storage.local.set(patch); } catch (e) {} }

(async () => {
  const s = { ...DEFAULTS, ...(await storageGet(DEFAULTS)) };

  $('enabled').checked = !!s.enabled;
  $('mode').value = s.pinnedMode;
  $('intensity').value = s.intensity;
  $('opacity').value = s.opacity;
  $('switchMin').value = s.switchMin;
  $('switchMax').value = s.switchMax;
  $('showName').checked = !!s.showName;
  $('intensityV').textContent = (+s.intensity).toFixed(2) + '×';
  $('opacityV').textContent = Math.round(s.opacity * 100) + '%';

  $('enabled').onchange = (e) => save({ enabled: e.target.checked });
  $('mode').onchange = (e) => save({ pinnedMode: e.target.value });
  $('showName').onchange = (e) => save({ showName: e.target.checked });

  $('intensity').oninput = (e) => {
    save({ intensity: +e.target.value });
    $('intensityV').textContent = (+e.target.value).toFixed(2) + '×';
  };
  $('opacity').oninput = (e) => {
    save({ opacity: +e.target.value });
    $('opacityV').textContent = Math.round(e.target.value * 100) + '%';
  };

  $('switchMin').onchange = (e) => save({ switchMin: Math.max(4, +e.target.value || 12) });
  $('switchMax').onchange = (e) => save({ switchMax: Math.max(5, +e.target.value || 30) });

  // "Skip" nudges the content script via a storage change (no tabs permission needed).
  $('next').onclick = () => save({ nudge: Date.now() });
})();
