# Annotations Everywhere

Annotations Everywhere adds editable margin notes to Markdown and anchored annotations to PDFs in Obsidian. It keeps annotation data inside the vault so the same notes can travel across desktop and mobile devices.

## Features

- Render Markdown footnote definitions as editable, scroll-synced sidenotes.
- Highlight selected PDF text or rectangular regions, including formulas and figures.
- Keep notes in left or right margin rails, or place them freely on the page.
- Share one annotation collection across multiple compatible PDFs, such as an original paper and its translation.
- Search, filter, sort, copy, move, delete, and recover annotations from a vault-wide manager.
- Organize annotations with colors, named layers, native or manual outlines, and single- or double-column reading order.
- Use a compact selection toolbar with preset colors and an add-note action on desktop or mobile.
- Copy PDF selection/region reference links and jump from highlighted references back to their source notes.
- Store annotations as plain vault files, with an optional revision-file format designed to reduce sync conflicts.

## Quick start

### Markdown sidenotes

Use ordinary Markdown footnotes:

```markdown
The claim needs more context.[^context]

[^context]: This definition can appear as an editable sidenote in the right margin.
```

The margin width and gap can be adjusted in the plugin settings or by dragging the aligned margin boundary.

### PDF annotations

Open a PDF and use the command palette to:

- add a note to the left or right rail;
- add a freely positioned note;
- create a highlight without a visible note box;
- open the current PDF annotation panel;
- open the vault-wide annotation manager;
- add a compatible PDF to the current shared annotation group.

Text annotations retain the selected quote. Rectangular selections can be used for formulas, figures, or scanned content that cannot be selected as text.

Enable the desktop or mobile selection toolbar in the plugin settings to show it automatically after selecting PDF text. Its colors come from the configurable preset palette. Choose a color to highlight immediately, or use the note icon to add text before saving.

Preset color groups let the same visual color have different meanings in different reading contexts. Add a group in settings to copy the current colors with independent identities, then rename each meaning or choose new colors. Switch groups from the palette icon in the selection toolbar or color picker. Switching groups does not change earlier annotations. Removing a group or color from the presets retains its definition for existing annotations.

Existing PDF annotations can switch between highlights with hover notes, collapsed dots, freely positioned boxes, and left or right margin notes. Use the conversion action in the annotation list or the PDF annotation context menu. Conversion preserves the same annotation, including its text, quote, anchors, color, and layers.

### PDF reference links

Select PDF text and use the link icon in the selection toolbar, or the **[PDF] 复制选区引用链接** command. Existing highlights and annotations offer **复制引用链接** and **复制引文及链接** in their context menu; the annotation list has a link action too. Copying alone does not create an annotation or edit a note.

Paste the link into a Markdown note. After Obsidian indexes it, **显示 PDF 引用勾画** (enabled by default) shows the referenced region using the existing annotation layer. A small return-arrow icon beside the region opens a searchable source list showing note counts, reference counts and line locations, even for a single reference. Select an entry to jump to the note. The icon can be hidden; referenced regions can keep their original style or use an underline or border without changing their semantic color. Adding a comment or choosing a color explicitly saves a normal annotation; the references themselves remain derived from the notes.

In the settings **引用** tab, customize separate link-only, inline-quote and blockquote templates with `{{text}}`, `{{link}}`, `{{file}}` and `{{page}}`. Templates support real newlines or literal `\n`, provide a live clipboard-text preview and a reset action, and must retain `{{link}}`. PDF text and LaTeX are inserted literally, not reinterpreted as template syntax. The toolbar uses your selected default format; menus and commands can still choose each format explicitly. Link label text is separately configurable.

Links retain native `#page=…&selection=…` text offsets or Everything Bilink-compatible `#page=…&rect=…` coordinates. Links copied from a shared translation target the PDF being read, not the English original. Deleting, moving or reanchoring an annotation never rewrites links in your notes. Remove the Markdown link to remove a reference-only highlight.

This first integration does not replace Everything Bilink's cropped embed previews, formula recovery, Markdown block-reference tools or reference-rewrite features. If both plugins are enabled, turn off one plugin's PDF reference highlighting to avoid duplicate layers. Existing links and Bilink data are not migrated or deleted.

## Annotation data and sync

Settings use compact **常用 / 引用 / 外观 / 管理** tabs, an inline search and flat collapsible sections. Data location, property synchronization and layers are under **管理**.

The default annotation directory is `.annotations-everywhere/` inside the vault. You can choose another vault folder in the plugin settings.

Annotations Everywhere does not modify the PDF file itself. It does not use telemetry or remote services. Your existing vault sync tool is responsible for transferring the annotation files between devices.

For devices that may edit annotations at the same time, the plugin can migrate the annotation store to revision files. Complete synchronization on every device before starting that migration, and stop older plugin versions from writing the legacy `annotations.json` file.

## Installation

### Community directory

Once the plugin is listed, install **Annotations Everywhere** from **Settings -> Community plugins -> Browse**.

### Manual installation

Download `main.js`, `manifest.json`, and `styles.css` from the matching GitHub release and place them in:

```text
<vault>/.obsidian/plugins/annotations-everywhere/
```

Restart Obsidian, then enable **Annotations Everywhere** under **Community plugins**.

## Compatibility

- Minimum Obsidian version: 1.7.2
- Desktop and mobile are supported.
- PDF features rely on Obsidian's built-in PDF viewer. Viewer internals can change between Obsidian releases, so PDF interaction should be rechecked after major app updates.

## Privacy

The plugin reads Markdown/PDF files through Obsidian and uses Obsidian's link metadata to find PDF reference sources. It writes its settings and annotation data to the vault; copying a reference only writes to the system clipboard. It makes no network requests and collects no analytics.

## Development

```bash
npm install
npm run build
```

The production build outputs `main.js` in the repository root.

## License

[MIT](LICENSE)
