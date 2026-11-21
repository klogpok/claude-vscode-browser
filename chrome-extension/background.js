// Claude Pick service worker: starts the picker in the tab, and does what a content script cannot —
// capture the visible tab, and copy the screenshot from an extension tab when the page itself may not.

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['picker.js'] });
  } catch (e) {
    // chrome:// pages, the Web Store and the PDF viewer refuse scripts.
    console.warn('Claude Pick cannot run here:', e);
    await chrome.action.setBadgeText({ tabId: tab.id, text: '✕' });
    setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: '' }).catch(() => {}), 2000);
  }
});

// The screenshot shot.html shows, handed over right after the tab opens.
let shot = null;

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const run = (/** @type {() => Promise<any>} */ f) => { f().then(reply, (e) => reply({ error: String(e && e.message || e) })); return true; };
  if (msg.type === 'capture') return run(async () => ({ dataUrl: await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: 'png' }) }));
  // A page without the async clipboard (plain http://) cannot copy an image: copy it from an extension tab.
  if (msg.type === 'showShot') return run(async () => {
    shot = { dataUrl: msg.dataUrl, name: msg.name };
    await chrome.tabs.create({ url: 'shot.html', index: sender.tab.index + 1, openerTabId: sender.tab.id });
    return { ok: true };
  });
  if (msg.type === 'getShot') { reply(shot || { error: 'no screenshot' }); return false; }
  return false;
});
