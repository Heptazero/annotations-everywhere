# Annotations Everywhere — PDF annotations and Markdown sidenotes for Obsidian

[English](README.md) · [简体中文](README.zh-CN.md) · [Releases](https://github.com/Heptazero/annotations-everywhere/releases) · [Report an issue](https://github.com/Heptazero/annotations-everywhere/issues)

Annotations Everywhere is an open-source Obsidian plugin for PDF highlights, left/right margin notes, shared annotations between original and translated PDFs, and editable Markdown footnote sidenotes. Annotation data stays in your vault; the plugin does not rewrite your PDFs or require a cloud account.

中文简介：在 Obsidian 中给 PDF 划线、添加左右侧边批注，让原文与保留版式的译文共享批注；也能把 Markdown 脚注显示为可编辑的页边注。支持全库批注搜索、按页码批量复制或移动、手动大纲，以及通过库内文件同步到手机。

> **Version scope:** Release **0.51.0** adds PDF backlinks and copy templates, semantic color groups, the redesigned desktop/mobile selection toolbar, expanded display conversions, and tabbed settings. These additions are not in 0.50.1. Check the [release notes](https://github.com/Heptazero/annotations-everywhere/releases) for your installed version. Automated tests and build checks pass; recent desktop/mobile interactions still need real-device acceptance testing.

## What can I use this Obsidian plugin for?

| Question / 使用场景 | Workflow and important limit |
| --- | --- |
| How can I highlight PDFs and write notes beside the text?<br>PDF 划线、左右侧边批注 | [Text highlights, region highlights, and margin notes](#highlight-pdf-text-formulas-and-figures). The PDF itself stays unchanged. |
| Can the original paper and its translation share annotations?<br>原文与译文共享批注 | [One collection for multiple PDFs](#share-annotations-between-original-and-translated-pdfs). Requires compatible pages and corresponding content positions. |
| How do I move notes from a partial translation to a complete PDF?<br>批注批量复制、移动和页码映射 | [Select annotations and map source pages to target pages](#copy-or-move-annotations-to-another-pdf). A one-time transfer, not ongoing sharing. |
| Can I find and delete highlights across a research folder?<br>全库批注搜索和批量删除 | [The vault-wide manager](#search-and-manage-annotations-across-your-vault) filters by folder and annotation status. |
| Can Markdown footnotes appear in the margin?<br>Markdown 脚注转页边注 | [Editable, scroll-synced sidenotes](#show-markdown-footnotes-as-editable-sidenotes), using ordinary footnote syntax. |
| Can I add an outline to a PDF without bookmarks?<br>手动大纲、章节折叠和双栏阅读 | [Native/shared outlines, manual headings, and reading order](#navigate-pdf-outlines-and-double-column-papers). No PDF metadata rewriting. |
| Can I copy a PDF quote link and see which notes cite it?<br>PDF 双链引用和反向链接 | [Reference links and source-note navigation](#copy-pdf-quote-links-and-see-backlinks), available since 0.51.0. |
| Can I use annotations on desktop and mobile, offline?<br>本地存储和手机同步 | [Vault-local annotation files](#sync-annotations-between-desktop-and-mobile). Your sync tool transfers the files; this is not a hosted sync service. |

## Highlight PDF text, formulas, and figures

Annotations Everywhere supports selected-text highlights and rectangular region annotations in Obsidian's built-in PDF viewer. Notes can sit in aligned left or right margin rails, float freely on the page, or stay as highlights without a visible note box.

Open a PDF, select text, and search the command palette for **[PDF]** to add a margin note or create a highlight with **[PDF] 仅勾画选区（无批注框）**. Without a text selection, the annotation tool lets you drag a rectangle around an equation, figure, or scanned region.

Text selections retain their quote. A rectangle marks a location but does **not** extract searchable text, recognize a formula, or perform OCR. You can write a comment yourself without OCR.

**Selection toolbar and conversions (0.51.0+):** Enable the desktop or mobile selection toolbar to get one row of preset colors and an add-note button after selecting text. Choose a color to highlight, or write a comment before saving. Existing annotations can switch between hover notes, collapsed dots, floating boxes, and left/right margin notes without losing text, quote, anchors, color, or layers.

**Semantic color groups (0.51.0+):** Create separate semantic palettes for different contexts, such as claim/evidence/question and definition/theorem/proof. Each group has independent color identities. Switching groups does not reinterpret old annotations; removing a preset retains its definition for existing notes.

## Share annotations between original and translated PDFs

Annotations Everywhere can share one editable annotation collection across two or more PDFs, including an original paper and a layout-preserving translation. Editing a shared annotation updates the common collection instead of maintaining separate copies.

Use **[PDF] 添加 PDF 到共享批注组** and choose the other file. Sharing checks page count, each page's dimensions, and rotation. If existing annotations conflict, choose whether to merge them or keep one side; replacement choices require confirmation. Commands can open the next group member beside the current PDF or cycle through members while retaining the page and position.

Matching geometry does not prove that translated text occupies the same position. Sharing is coordinate-based, not automatic text alignment, translation, or document matching. For PDFs with inserted pages, consider [page-mapped copying or moving](#copy-or-move-annotations-to-another-pdf); reflowed text still needs visual checking.

To stop sharing, use **[PDF] 解除共享绑定(当前 PDF 保留批注副本)**. The current PDF keeps an independent annotation copy; this is not a command to delete the annotations.

## Copy or move annotations to another PDF

Select annotations in the vault-wide manager, choose **copy** or **move**, select a target PDF, and specify source-page ranges and each target starting page. Multiple non-overlapping source ranges are supported.

For example, after reading a 30-page partial translation, transfer those notes to the complete translation. A mapping of source pages **1–30 → target start 11** sends them to target pages **11–40**. Copy keeps the originals; move removes the selected source records after applying the transfer.

The transfer maps pages and scales geometric anchors to target page dimensions; it does not find equivalent sentences in a different layout. Source text-selection offsets are not reused on the target. Check transferred positions, especially after reflow; PDF reference links already pasted into notes are not rewritten.

## Search and manage annotations across your vault

Open **[PDF] 打开全库批注管理** to browse annotated PDFs and shared groups, see counts and update times, search annotation content, filter by folder or standalone/shared/unmounted status, sort by update time, and expand or collapse groups. Select records for batch deletion, copying, or moving, and jump back to their PDF locations.

For the current PDF, use **[PDF] 打开批注列表面板** or **[PDF] 搜索当前 PDF 的批注**. The panel supports collapsible page/color grouping and named layers; one annotation can belong to multiple layers without duplicating its text.

If a PDF was removed or restored under a different path, retained records may appear as **未挂载** (unmounted). Mount them from the manager or use **[PDF] 恢复未挂载批注到当前 PDF** and select the appropriate source. Page and filename information help choose candidates; they do not prove document identity. This recovers retained records, not a deleted PDF or deleted annotation data.

## Show Markdown footnotes as editable sidenotes

Annotations Everywhere displays ordinary Markdown footnote definitions as editable, scroll-synced notes in the right margin of an Obsidian note. This footnote-to-sidenote workflow is separate from PDF annotation storage.

```markdown
The claim needs more context.[^context]

[^context]: This definition can appear as an editable sidenote in the right margin.
```

Adjust the shared margin width and gap in settings or drag the aligned margin boundary. The underlying note remains Markdown with footnote syntax; no proprietary footnote format is required.

## Navigate PDF outlines and double-column papers

Use a PDF's native outline when present, or inherit an outline from another member of its shared group. **[PDF] 添加手动大纲标题** supplements the outline with a title, hierarchy level, and starting page when bookmarks are missing. Annotations can be folded under chapter ranges in the outline view; a range ends at the next heading at the same or a higher level.

**[PDF] 切换批注阅读顺序（单栏 / 双栏）** changes how the plugin orders annotations for a single- or double-column paper. It does not alter the PDF's text layer or native copy/paste order. Manual headings supplement the plugin's outline without writing bookmarks into the PDF file.

## Copy PDF quote links and see backlinks

**Available since 0.51.0.** Annotations Everywhere can copy a PDF text-selection or region link and show backlinks from that region to the Markdown notes that reference it.

1. Select PDF text and use the toolbar link icon or **[PDF] 复制选区引用链接**. Existing annotations and the annotation list also offer reference-copy actions.
2. Paste into a Markdown note. Copying alone does not create an annotation or edit a note.
3. After Obsidian indexes the link, **显示 PDF 引用勾画** shows its region using the existing annotation layer, without drawing a duplicate over an existing annotation.
4. Click the return-arrow icon beside the region to see source notes, reference counts, and line locations, then choose an entry to jump back to that note.

In **引用** settings, choose link-only, inline-quote, or blockquote output and customize the link label and separate templates. Variables are `{{text}}`, `{{link}}`, `{{file}}`, and `{{page}}`; templates must retain `{{link}}`. Real newlines or literal `\n` are supported, with a clipboard-text preview and reset action. Inserted PDF text and LaTeX are not reinterpreted as template syntax. Menus and commands can override the toolbar's default format.

Links use native `#page=…&selection=…` text offsets or Everything Bilink-compatible `#page=…&rect=…` coordinates. A link copied from a shared translation points to the PDF being read, not automatically to the English original. Reference icons can be hidden; referenced regions can keep their style or use an underline/border while retaining their semantic color.

References are derived from note links, not extra saved annotations. Explicitly adding a comment or changing a reference-only region's color creates a normal annotation. Deleting, moving, or reanchoring an annotation never rewrites note links; remove the Markdown link to remove a reference-only highlight.

This is not a complete Everything Bilink replacement: cropped embed previews, formula recovery, Markdown block-reference tools, and bulk link rewriting are not included. With both plugins enabled, turn off one plugin's PDF reference highlighting. No Bilink data or existing links are migrated or deleted. See [integration scope and compatibility](BILINK-INTEGRATION.md).

## Sync annotations between desktop and mobile

Annotations Everywhere stores PDF annotations in plain files inside the vault. The default data folder is `.annotations-everywhere/`; choose another **vault-relative folder path** in settings and configure the same location on each device. Ensure your sync tool includes that folder, particularly if it excludes hidden folders.

Your existing vault sync tool transfers the annotation files. The plugin has no hosted synchronization service, account requirement, or remote dependency. Desktop and mobile code paths are supported, but actual PDF/touch behavior should be checked on your device.

For overlapping edits on multiple devices, use **[PDF] 改用可同步的分文件批注** to migrate from the legacy `annotations.json` store to revision files, designed to reduce whole-file sync conflicts. Finish syncing all devices first and stop older versions from writing the legacy store. Revision files do not guarantee conflict-free edits; **[PDF] 查看批注同步冲突** exposes conflicts for review. Back up the data before migration.

## Settings and keyboard controls

The settings UI uses **常用 / 引用 / 外观 / 管理** tabs, inline search, and collapsible sections. Search accepts multiple terms and entered group names/folder paths, retains the query on refresh, and preserves normal collapse state. Data location, property sync, and layers are under **管理**.

The reference-source picker adjusts to window/mobile-keyboard changes. Use Up/Down to navigate (Up from search selects the last result), Home/End on a result for the first/last entry, and Escape to restore focus. Leaving it releases the temporary PDF-navigation key scope.

## Installation

### Community directory

Once the plugin is listed, install **Annotations Everywhere** from **Settings → Community plugins → Browse**.

### Manual installation

Download `main.js`, `manifest.json`, and `styles.css` from the same [GitHub release](https://github.com/Heptazero/annotations-everywhere/releases) and place them in:

```text
<vault>/.obsidian/plugins/annotations-everywhere/
```

Restart Obsidian, then enable **Annotations Everywhere** under **Community plugins**.

## Compatibility

- Minimum Obsidian version: 1.7.2.
- Desktop and mobile are supported; real-device acceptance remains separate from builds and tests.
- PDF features rely on Obsidian's built-in PDF viewer. Viewer internals can change, so recheck PDF interaction after major app updates.

## Privacy and limitations

The plugin reads Markdown/PDF files through Obsidian and uses Obsidian's link metadata to find PDF reference sources. It writes settings and annotation data to the vault; copying a reference only writes to the system clipboard. It makes no network requests and collects no analytics.

PDF annotations are **not embedded in or exported into the PDF file**. Another PDF reader will not display this vault-local collection. Annotations Everywhere is not a PDF translator, OCR service, browser/webpage annotation extension, or bibliographic reference manager.

## Frequently asked questions

### Do translated PDFs need matching filenames or a cn_ prefix?

No. Choose the other PDF manually when creating a shared group. Filename resemblance helps find candidates; it is not proof of identity and does not replace the page-geometry checks. You do not need a separate filename-mapping plugin.

### Can three PDFs share annotations, or is sharing limited to a pair?

Sharing supports more than two compatible PDFs. Add each to the shared group and cycle between members. They use one annotation collection, not a chain of pairwise copies.

### Can I add a comment to an existing highlight later?

Since 0.51.0, the expanded display-conversion workflow can turn a highlight into a hover note, dot, floating box, or margin note while preserving the same record. Use the annotation list or the PDF context menu to change its display form.

### Will restoring a PDF automatically recover all my annotations?

Not necessarily. Keep the annotation-data files as well as the PDF. If retained records are unmounted after a path change, choose the correct source in the manager's recovery workflow. A similar filename or a sufficient page count does not establish that the records belong to this document.

### Does the plugin need an AI API key or a paid cloud service?

No. Annotations Everywhere has no built-in AI service or API-key requirement. An external AI can help draft Markdown commentary, but the plugin does not automatically read, translate, or annotate papers with AI. Multi-device file transfer is handled by your chosen vault sync tool.

## Development

```bash
npm install
npm run build
```

The production build outputs `main.js` in the repository root.

## Support

Report bugs or request features in [GitHub Issues](https://github.com/Heptazero/annotations-everywhere/issues). Include plugin and Obsidian versions, device/platform, steps to reproduce, and whether the PDF is standalone or shared. Review private PDFs and annotation data before attaching them.

## License

[MIT](LICENSE)
