# Claude Pick for Chrome

Pick an element on any page in your own Chrome and paste it into Claude. It is the Pick from Claude Browser, without VS Code: the same selector, DOM path, box, text, computed styles and HTML, in the same Markdown format, plus a screenshot of the element.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose this `chrome-extension` folder.
3. Optional: pin **Claude Pick** to the toolbar.

Edge works the same way, at `edge://extensions`. After pulling a new version, press the reload button on the extension's card.

## Use

1. Click the **Claude Pick** button, or press **Alt+Shift+P**. If the shortcut does nothing, set one at `chrome://extensions/shortcuts`.
2. Hover: the element under the pointer is highlighted with its tag and size.
3. Click the element. The page does not get that click. **Esc** or a second press of the button cancels.
4. The element's Markdown is now in the clipboard: paste it into the Claude chat with **Ctrl+V**.
5. For the screenshot, click **Copy screenshot** on the toast and paste again with **Ctrl+V**.

Nothing is saved to disk, so Chrome never asks where to save a file. The clipboard holds one thing at a time, hence the two pastes.

On a plain `http://` page that is not `localhost`, the page cannot put an image in the clipboard. There **Copy screenshot** opens the screenshot in a new tab, which copies it; paste it and close the tab.

## Limits

- Chrome lets no extension run on `chrome://` pages, the Chrome Web Store or the PDF viewer. The button shows ✕ there.
- The screenshot is of the visible part of the element only.
- An element inside an iframe gets a selector relative to the top page.

## Permissions

| Permission | Why |
|---|---|
| `activeTab`, `scripting` | Run the picker in the current tab, only when you press the button, and capture that tab for the screenshot |
| `clipboardWrite` | Copy the Markdown on pages where the async clipboard is unavailable (plain `http://`) |

The extension reads no page until you press the button and sends nothing anywhere.
