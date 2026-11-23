// Chrome only adds content scripts when a page loads, so tabs that were already open
// (or got moved into split view) can end up without the counter. This fills those in.

const NOTION = /^https:\/\/([^/]+\.)?(notion\.so|notion\.com|notion\.site)\//;

async function ensureCounter(tabId, url) {
  if (tabId == null || !url || !NOTION.test(url)) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'nwc-ping' });
  } catch (_) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    } catch (_) {
      // Tab closed, still loading, or site access turned off.
    }
  }
}

// Installed, updated, or reloaded from chrome://extensions: cover every open Notion tab.
chrome.runtime.onInstalled.addListener(async () => {
  for (const tab of await chrome.tabs.query({})) ensureCounter(tab.id, tab.url);
});

// Clicking into a tab (including either half of a split view).
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    ensureCounter(tab.id, tab.url);
  } catch (_) {}
});

// A page finishing loading.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete') ensureCounter(tabId, tab.url);
});
