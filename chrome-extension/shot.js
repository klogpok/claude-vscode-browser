// Shows the screenshot the picker could not copy itself, and copies it from here: an extension page
// always has the async clipboard.
const status = document.getElementById('status');
const img = document.getElementById('shot');

async function copy() {
  try {
    const blob = await (await fetch(img.src)).blob();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    status.textContent = 'Screenshot copied — paste it into Claude (Ctrl+V), then close this tab.';
  } catch (e) {
    status.textContent = `Could not copy (${e.message}). Click "Copy screenshot".`;
  }
}

document.getElementById('copy').addEventListener('click', copy);

chrome.runtime.sendMessage({ type: 'getShot' }).then((r) => {
  if (!r || r.error) { status.textContent = 'No screenshot to show.'; return; }
  document.title = r.name;
  img.onload = copy;
  img.src = r.dataUrl;
});
