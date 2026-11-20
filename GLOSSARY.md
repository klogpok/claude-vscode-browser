# Claude Browser

A browser inside VS Code that Claude drives over MCP while the user watches and steers it in the same view.

## Language

**Browser**:
The headless Chrome/Edge instance that Claude and the user share.
_Avoid_: Chrome, tab, page (a page is what the Browser has open)

**Panel**:
The VS Code editor tab that shows the Browser live and passes the user's mouse and keyboard to it.
_Avoid_: webview, view, preview

**Tool**:
One action Claude can take on the Browser over MCP, named `browser_*`.
_Avoid_: command, endpoint

**Pick**:
An element the user chose in the Panel to show Claude, captured with its selector, styles, HTML and a screenshot.
_Avoid_: selection, inspected element

**Pick mode**:
The Panel state in which clicking the page chooses an element for a Pick instead of clicking it.
_Avoid_: picker, inspect mode

**Dialog**:
An alert, confirm, prompt or beforeunload the page opens; the Browser always answers it at once.
_Avoid_: popup, modal

**Dialog plan**:
Claude's one-shot answer for the next Dialog; without one, the Dialog is accepted.
_Avoid_: dialog handler

**Console log**:
The page's console messages, exceptions, log entries and handled Dialogs, as Claude reads them.
_Avoid_: logs, output
