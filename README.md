# Annotations Everywhere

Annotations Everywhere adds editable margin notes to Markdown and anchored annotations to PDFs in Obsidian. It keeps annotation data inside the vault so the same notes can travel across desktop and mobile devices.

## Features

- Render Markdown footnote definitions as editable, scroll-synced sidenotes.
- Highlight selected PDF text or rectangular regions, including formulas and figures.
- Keep notes in left or right margin rails, or place them freely on the page.
- Share one annotation collection across multiple compatible PDFs, such as an original paper and its translation.
- Search, filter, sort, copy, move, delete, and recover annotations from a vault-wide manager.
- Organize annotations with colors, named layers, native or manual outlines, and single- or double-column reading order.
- Use mobile-friendly controls and an optional palette after selecting PDF text.
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

## Annotation data and sync

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

- Minimum Obsidian version: 1.5.8
- Desktop and mobile are supported.
- PDF features rely on Obsidian's built-in PDF viewer. Viewer internals can change between Obsidian releases, so PDF interaction should be rechecked after major app updates.

## Privacy

The plugin reads Markdown and PDF files selected through Obsidian and writes its settings and annotation data to the vault. It makes no network requests and collects no analytics.

## Development

```bash
npm install
npm run build
```

The production build outputs `main.js` in the repository root.

## License

[MIT](LICENSE)
