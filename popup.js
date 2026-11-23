const grid = document.getElementById('grid');
const badge = document.getElementById('badge');
const empty = document.getElementById('empty');
const show = document.getElementById('show');

let lastKey = '';

function render(state) {
  const key = JSON.stringify(state);
  if (key === lastKey) return;
  lastKey = key;

  const dark = state ? state.dark : window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.body.classList.toggle('dark', dark);
  document.body.classList.toggle('selecting', !!(state && state.selecting));
  badge.hidden = !(state && state.selecting);

  grid.replaceChildren();
  if (!state || !state.hasPage) {
    empty.hidden = false;
    empty.textContent = !state
      ? 'Open a Notion page to see its count.'
      : state.blocked
        ? "Chrome won't let the counter run on this Notion tab. In chrome://extensions → Notion Word Counter → Details, set Site access to \"On all sites\" or add notion.so."
        : 'Open a Notion page to see its count.';
    return;
  }
  empty.hidden = true;
  for (const { label, value } of state.rows) {
    const l = document.createElement('div');
    l.className = 'label';
    l.textContent = label;
    const v = document.createElement('div');
    v.className = 'value';
    v.textContent = value;
    grid.append(l, v);
  }
}

const NOTION = /^https:\/\/([^/]+\.)?(notion\.so|notion\.com|notion\.site)\//;
const triedInject = new Set();

// Ask a tab for its stats. If it's a Notion tab with no counter running, add one.
async function ask(tab) {
  try {
    return await chrome.tabs.sendMessage(tab.id, { type: 'nwc-stats' });
  } catch (_) {}
  const isNotion = !!tab.url && NOTION.test(tab.url);
  if (!isNotion) return null;
  if (!triedInject.has(tab.id)) {
    triedInject.add(tab.id);
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      return await chrome.tabs.sendMessage(tab.id, { type: 'nwc-stats' });
    } catch (_) {}
  }
  return { blocked: true };
}

// With Chrome's split view, the focused half might not be the Notion one, so also
// ask the other tab in the split.
async function refresh() {
  let fallback = null;
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    const active = tabs.filter((t) => t.active);
    const splitIds = new Set(active.map((t) => t.splitViewId).filter((id) => id != null && id !== -1));
    const candidates = [...active, ...tabs.filter((t) => !t.active && splitIds.has(t.splitViewId))];

    for (const tab of candidates) {
      const state = await ask(tab);
      if (state && state.hasPage) return render(state);
      fallback = fallback || state;
    }
  } catch (_) {}
  render(fallback || null);
}

chrome.storage.local.get('hidden', ({ hidden }) => {
  show.checked = !hidden;
});
show.addEventListener('change', () => {
  chrome.storage.local.set({ hidden: !show.checked });
});

refresh();
setInterval(refresh, 500);
