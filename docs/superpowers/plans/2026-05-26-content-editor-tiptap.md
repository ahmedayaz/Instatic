# Content editor — Tiptap-based replacement

**Status:** Prototype (initial implementation merged in the same change set as
this doc). Treat this file as the architectural rationale; the code is the
source of truth for what was shipped.

**Date:** 2026-05-26.

## Why

The previous body editor in `src/admin/pages/content/RichMarkdownEditor.tsx`
was a hand-rolled, ~720-line block-list with a `contentEditable` per block,
custom pointer-event drag-and-drop, a per-block type-switcher menu, and
exactly five supported block shapes (paragraph / H2-H4 / image / video). It
worked, but the day-to-day writing experience was thin:

- No inline formatting at all — bold, italic, code, strike, links could only
  be entered as literal markdown source and rendered through the publisher
  later. The editor itself never re-rendered them.
- No lists, no quotes, no fenced code blocks, no horizontal rules, no tables.
- No floating bubble menu, no `/` slash menu — block type was changed via
  a chevron button hanging off the side of each block (the Gutenberg shape).
- One `contentEditable` per block meant arrow-key caret movement across
  blocks was fighting React, and the project carried bespoke focus signals
  to compensate (`focusBodySignal`, `pendingFocusBlockId`).
- Most of the file was reorder ergonomics — measuring rects, projecting drop
  indices, settling drop animations — not text editing.

The user-visible bar was: *"don't ship another shitty Gutenberg"*. The
existing editor was structurally exactly that: a list of independent block
widgets with floating affordances. The new editor is structurally a single
document — one ProseMirror doc, one caret, paragraphs/headings/lists/etc.
flowing through it the way they do in Linear, Notion, Craft, etc.

## What changed

| Before | After |
| --- | --- |
| Hand-rolled `RichMarkdownEditor` over a list of `ContentBlock` shapes | `TiptapBodyEditor` over a single ProseMirror document, headless Tiptap 3 |
| `ContentBlock` discriminated union (`paragraph` / `heading` / `media`) in `src/core/markdown/blockModel.ts` | No discriminated union. Body is plain markdown text in/out of the editor. Tiptap owns the in-memory doc shape (ProseMirror JSON) |
| Tiny hand-written markdown parser (5 line-level rules) | Body is round-tripped between **markdown text** (stored) and **ProseMirror JSON** (editor) by a new `markdownDocument.ts` module — `markdownToProseMirrorDoc(md)` and `proseMirrorDocToMarkdown(doc)` |
| Publisher's `renderMarkdownToHtml` had its own narrow grammar (5 rules) | Publisher uses `marked` (already a dep) with GFM enabled, then escapes URLs and sanitizes per the body-content allow-list. One implementation now spans editor input *and* output |
| Per-block chrome (drag handle + type chevron) | One floating **bubble menu** for inline marks (B/I/code/strike/link), one **slash menu** for inserting block-level nodes (H2/H3/H4, lists, quote, code block, divider, table, **media**, **data token**). No per-block chrome at all. |
| `/` was a literal character | `/` opens a contextual command menu (`@tiptap/suggestion`-driven) at the caret |
| No markdown shortcuts beyond `# ` → heading | Full set of input rules: `# `→H1, `## `→H2, `### `→H3, `**x**`→bold, `*x*`→italic, `` `x` ``→code, `~~x~~`→strike, `- `→bullet, `1. `→ordered, `> `→quote, `---`→hr, ` ``` `→code block (StarterKit + Tiptap built-ins) |
| Title pressed Enter → bumps `focusBodySignal` → editor mounts an empty paragraph & focuses it | Title pressed Enter → calls `editor.commands.focus('start')` directly (the editor is always one document, no per-block focus hops). The signal counter API stays for now to keep `ContentDocumentCanvas`'s interface stable. |
| Drag-and-drop block reorder via pointer events | Removed. Block reorder in a document editor is done by selecting and using cut/paste, or the keyboard shortcut `Cmd-Shift-Up/Down`. We don't want users dragging headings around like a Trello board — the writing surface is text, not tiles. |

## Storage shape — still markdown, just extended

Per the requirements, the canonical body remains a markdown string in the
`body` cell of the post-type data row. Existing entries continue to load with
no migration step. The grammar is widened on both ends:

- **Inline marks:** `**bold**`, `*italic*`, `` `code` ``, `~~strike~~`,
  `[link](url)`
- **Headings:** `## `, `### `, `#### ` (H1 is reserved for the title, normalised
  on parse — `# ` becomes `## `)
- **Lists:** `- ` / `* ` bullets, `1. ` ordered; nested via 2-space indents
- **Block quote:** `> `
- **Code block:** triple-backtick fence with optional language
- **Horizontal rule:** `---`
- **Tables:** GFM-pipe-table syntax
- **Media (extension):** `![alt](src)` for images, `@[video](src)` for videos
  (the in-house extension carried over from before)
- **Data tokens:** raw `{source.field}` text — the editor treats them as
  plain inline text (no decoration in v1; the publisher's template
  interpolation resolves them at render time)

The serializer (`proseMirrorDocToMarkdown`) produces stable, idempotent
output — re-parsing the output and re-serializing yields the same string.
That property is tested.

## Files added

```
src/admin/pages/content/TiptapBodyEditor.tsx
src/admin/pages/content/TiptapBodyEditor.module.css
src/admin/pages/content/components/BodyBubbleMenu/BodyBubbleMenu.tsx
src/admin/pages/content/components/BodyBubbleMenu/BodyBubbleMenu.module.css
src/admin/pages/content/components/BodySlashMenu/SlashCommand.ts          // Tiptap extension wired to @tiptap/suggestion
src/admin/pages/content/components/BodySlashMenu/BodySlashMenu.tsx        // React portal renderer for the slash menu
src/admin/pages/content/components/BodySlashMenu/BodySlashMenu.module.css
src/admin/pages/content/nodes/MediaNode.ts                                // Tiptap node spec for `![alt](src)` / `@[video](src)`
src/core/markdown/markdownDocument.ts                                     // markdown <-> ProseMirror JSON
```

## Files changed

```
src/admin/pages/content/ContentPage.tsx                                   // notch actions now run editor commands instead of mutating a block list
src/admin/pages/content/components/ContentDocumentCanvas/ContentDocumentCanvas.tsx
src/admin/pages/content/hooks/useContentEntryDraft.ts                     // `blocks` -> `body: string`
src/admin/pages/content/hooks/useContentMediaPicker.ts                    // `setBlocks` -> editor command via ref
src/core/markdown/renderMarkdown.ts                                       // marked + body-content sanitizer
src/__tests__/data/markdown.test.ts                                       // covers the new round-trip + GFM serializer
src/__tests__/data/contentAdmin.test.tsx                                  // legacy block-id queries replaced with editor-document assertions
src/__tests__/architecture/admin-feature-folders.test.ts                  // updated marker file
src/__tests__/architecture/button-primitive-usage.test.ts                 // updated allowlist entry
```

## Files deleted

```
src/admin/pages/content/RichMarkdownEditor.tsx
src/admin/pages/content/RichMarkdownEditor.module.css
src/core/markdown/blockModel.ts
```

(per CLAUDE.md: pre-release, no backward-compat shims, delete the old
implementation — don't run both side-by-side.)

## Why we didn't store HTML or ProseMirror JSON

We considered all three options. The user picked markdown explicitly. The
trade-offs were:

- **Markdown (chosen):** smallest stored payload, human-diffable, plays well
  with the existing publisher's `renderMarkdownToHtml` consumers
  (`firstImagePathFromMarkdown` for featured-image fallback, the dynamic-binding
  `{{ body | html }}` filter, etc.). Cost: we own the
  ProseMirror-JSON ↔ markdown round-trip. That cost is bounded — the grammar
  is fixed and tested.
- **HTML:** Tiptap's native format; saves us the serializer. But it inflates
  the stored bytes by ~3× on average, makes diffs unreadable, and forces every
  consumer of `body` to parse HTML (e.g. `firstImagePathFromMarkdown` would
  become a DOM walk).
- **ProseMirror JSON:** best fidelity (no serialise/parse loss, no escaping
  quirks). But the JSON is *huge* relative to markdown, and every
  non-editor consumer (RSS, exports, the publisher itself) would need a JSON
  renderer.

## Why no drag-and-drop block reorder

This is the single most Gutenberg-coded affordance — a drag handle on every
paragraph, paragraphs as movable tiles. A real writing surface is one
document; reordering is done at the text level (cut/paste, keyboard move).
The drag handle is the right primitive for a *page builder* (which we have
in the visual editor), not for a *content editor*. The Tiptap ecosystem does
ship a `DragHandle` extension if a future task wants this back, but it's not
the default writing affordance and we don't enable it.

## Verification

`bun test`, `bun run build`, `bun run lint` all pass on the changed files.
The dynamic-binding pipeline (`{{ body | html }}`) and `firstImagePathFromMarkdown`
continue to work against the extended markdown grammar — the publisher path
swapped from a hand-rolled scanner to `marked`-with-GFM, but the inputs are
the same shape (markdown text).

## Follow-ups (deliberately out of scope)

- **Syntax highlight in code blocks** (`@tiptap/extension-code-block-lowlight`
  + `lowlight`). Plain `<pre><code>` works for v1; the editor renders code
  blocks with our standard CSS Module styling.
- **Drag-handle reorder for headings.** If user research shows people miss
  this, wire `@tiptap/extensions`' `DragHandle` to operate at the heading
  level only. Not a default.
- **Inline data-token chip.** Today `{source.field}` is plain text in the
  doc. A v2 could promote it to a non-editable Tiptap node with click-to-edit
  semantics (and replace the BindingPickerDialog's "append-paragraph" insert
  with an at-caret node insert — already implemented for the insert path; the
  decoration is the missing piece).
- **Inline image upload by drop / paste.** The new `<EditorContent />`
  surface accepts pasted images today but the upload pipeline isn't wired
  yet; `onPaste` / `onDrop` hooks would call into the same media-picker
  upload that the modal uses.
