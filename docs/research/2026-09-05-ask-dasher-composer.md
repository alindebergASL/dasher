# Ask Dasher composer — bounded interface research

Date: 2026-09-05
Scope: a single prompt + CSV source composer; no analysis, source-adapter, or persistence changes.

## Observations worth carrying into Dasher

1. **The question remains the primary act; source attachment is context.** OpenAI puts saved-file attachment behind the composer's add control, while Anthropic describes the sequence as “upload relevant data or describe what you need.” Dasher should therefore give the prompt the largest uninterrupted writing surface and make source choice clear but subordinate—not present two equal calls to action. [S1][S2]
2. **Show the selected source as state, not helper prose.** OpenAI's file library distinguishes uploaded files from generated files and supports recent-file attachment from the composer. For Dasher's smaller scope, a persistent “Sample data active” / “Uploaded data active” status with the filename is a clearer analogue than a long conditional paragraph. [S1]
3. **A custom drop target should still be a real file input.** MDN recommends backing the styled drop zone with an `input[type=file]` and associated label so click/keyboard selection remains available; it also says drag-and-drop must remain an alternative rather than the only path. [S3][S4]
4. **Do not remove the native input from the accessibility tree.** MDN specifically cautions that `display:none` and `visibility:hidden` can make the input non-interactive to assistive technology; visually conceal it without removing it and expose an obvious focus treatment on the designed surface. [S4]
5. **Announce source changes without moving focus.** W3C's ARIA22 technique uses a pre-existing `role="status"` live region, with `aria-atomic="true"` where the whole contextual message should be announced. [S5]
6. **Keep scope honest.** The `accept` attribute is only a picker hint, not validation. Dasher's existing trusted server validation remains authoritative; the composer should say CSV, but must not imply client-side acceptance proves safety. [S4]

## Applied design constraints

- One heading: **Ask Dasher**.
- A wrapping textarea, not a single-line/truncating input.
- One source surface backed by the native file input, with click, keyboard, and file-drop paths.
- Explicit states: **Sample data active** and **Uploaded data active: _filename_**; uploaded state offers a reversible **Use sample data** action.
- One dominant submit action; examples are quiet prompt starters.
- A polite atomic status announces source changes; focus stays where the user put it.
- Stage 1's interpretation/correction strip stays exactly downstream of the composer.

## Source ledger

- **[S1] OpenAI Help Center, “File storage and Library in ChatGPT”** (updated 2026-08-31; accessed 2026-09-05). Supports composer attachment via add control and distinct uploaded/generated file state. https://help.openai.com/en/articles/20001052-file-storage-and-library-in-chatgpt
- **[S2] Anthropic, “Claude can now create and edit files”** (2025-09-09; accessed 2026-09-05). Supports prompt-first sequence: upload relevant files or describe the intended output, then guide in conversation. https://www.anthropic.com/news/create-files
- **[S3] MDN, “File drag and drop”** (accessed 2026-09-05). Supports a label-styled drop zone backed by a real file input and a non-drag selection path. https://developer.mozilla.org/en-US/docs/Web/API/HTML_Drag_and_Drop_API/File_drag_and_drop
- **[S4] MDN, “`input type=file`”** (accessed 2026-09-05). Supports native input/label semantics, visually hiding without `display:none`, accepted-type hints, and server-side validation. https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/input/file
- **[S5] W3C WAI, “ARIA22: Using role=status to present status messages”** (accessed 2026-09-05). Supports pre-existing polite status announcements and explicit `aria-atomic="true"`. https://www.w3.org/WAI/WCAG22/Techniques/aria/ARIA22
