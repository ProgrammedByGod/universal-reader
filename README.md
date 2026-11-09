# Universal Reader and File Viewer

*[Русская версия](README.ru.md)*

<p align="center">
  <a href="https://github.com/ProgrammedByGod/universal-reader/releases/latest"><img src="https://img.shields.io/badge/⬇_Download-latest_release-2ea44f?style=for-the-badge" alt="Download"></a>
  &nbsp;
  <a href="https://boosty.to/programmedbygod"><img src="https://img.shields.io/badge/❤_Support_on-Boosty-f15f2c?style=for-the-badge" alt="Support on Boosty"></a>
</p>

A read-only reader and file viewer for Obsidian that opens **more than 1000 file extensions** right inside the vault: books, comics, documents, spreadsheets, databases, presentations, web pages, email, notes, diagrams, maps, 3D models, fonts, archives, code and much more.

> ❤️ **Universal Reader is free and made by one person.** If it saves you time, please support its development on **[Boosty](https://boosty.to/programmedbygod)** — even a small donation helps keep the plugin growing.

> 💡 **Have an idea, found a bug, or a file that won't open?** [Open an issue](https://github.com/ProgrammedByGod/universal-reader/issues/new) — every suggestion is read. Details below in [Feedback and ideas](#feedback-and-ideas).

### ⬇️ Not familiar with GitHub? Here's how to download

1. Open the **[latest release](https://github.com/ProgrammedByGod/universal-reader/releases/latest)**.
2. Scroll down to the **Assets** section and click **`universal-reader-x.y.z.zip`** (the full version).
3. Unpack it into `<your vault>/.obsidian/plugins/`. To find this folder, open Obsidian → Settings → Community plugins → click the 📁 folder icon next to "Installed plugins".
4. Restart Obsidian and turn on **Universal Reader and File Viewer** in Settings → Community plugins.

> **Alpha.** The plugin never changes your files, but please back up your vault or try it on a test vault first.

## What it opens

- **Books:** EPUB, FB2, MOBI/AZW3, DjVu, TXT and old e-book formats. Real page numbers and footnotes, plus remembered reading positions.
- **Comics:** CBZ, CBR, CB7.
- **Documents:** DOCX, DOC, ODT, RTF, XPS, CHM, Visio, DocBook and more.
- **Spreadsheets and databases:** XLSX, XLS, ODS, CSV, SQLite, Access, Parquet, Arrow and more.
- **Presentations:** PPTX, PPT, ODP.
- **Email and contacts:** EML, MSG, MBOX, Outlook PST/OST, vCard, iCalendar.
- **Notes and mind maps:** XMind, FreeMind, Joplin, CherryTree, Anki and more.
- **Diagrams and drawings:** Graphviz, BPMN, DXF, Excalidraw, tldraw, Mermaid.
- **Maps and tracks:** GPX, KML, GeoJSON, Shapefile, FIT.
- **3D models:** STL, OBJ, glTF, PLY, 3MF, STEP, IGES, Rhino, IFC.
- **Images:** TIFF, HEIC, PSD, JPEG XL, ICO, EMF/WMF and more.
- **Fonts:** TTF, OTF, WOFF.
- **Archives:** ZIP, RAR, 7z, TAR, GZ, XZ, ZST and more. Files inside an archive open right in the reader.
- **Scientific and engineering data:** HDF5, NetCDF, MATLAB, DICOM, NIfTI, KiCad and Gerber.
- **Sheet music:** MusicXML, ABC, MEI, Humdrum.
- **Other:** source code and configs, subtitles, Flash (.swf, via Ruffle) and many more.

The full list, with a toggle for every format, is in the plugin settings.

Some things it can do with any file:
- **Show in hex view:** see any file byte by byte.
- **File information:** see what a file is.
- **Compare with another file.**
- **Open as book:** open a Markdown note as a book.

PDF is still opened by Obsidian's own viewer. KeePass databases are shown as information only, never with passwords.

## Installation

### From the Obsidian catalog
Settings → Community plugins → Browse → search for **Universal Reader** (or just a format, e.g. *epub*, *docx*, *djvu*) → Install → Enable.

The catalog version already includes the popular formats: Word, Excel, PowerPoint, TIFF, HEIC (iPhone photos), DjVu, RAR, SQLite and 3D models.

### Libs pack, for rare heavy formats
Some formats need large libraries (several to tens of megabytes each), so they are not part of the catalog version. These include 7z, RTF, sheet music, CAD (STEP/IGES/Rhino/IFC), HDF5 scientific data and Flash. When you open such a file, the reader shows a **"Library pack needed"** panel with a download button.

1. Download `universal-reader-libs-x.y.z.zip` from [Releases](https://github.com/ProgrammedByGod/universal-reader/releases/latest).
2. Unpack it into `<your vault>/.obsidian/plugins/universal-reader/`. You should end up with a `libs` folder next to `main.js`.
3. Open the file again. There is no need to restart Obsidian.

The settings tab shows whether the pack is installed and whether it is up to date.

### Manual install (full version)
Download `universal-reader-x.y.z.zip` from [Releases](https://github.com/ProgrammedByGod/universal-reader/releases/latest). Unpack it into `<your vault>/.obsidian/plugins/`, then enable the plugin in Settings → Community plugins.

## Feedback and ideas

Your feedback shapes the plugin. Write in [Issues](https://github.com/ProgrammedByGod/universal-reader/issues) (English or Russian is fine) if you:

- 🐞 **found a bug.** Describe what you did, what happened, and your Obsidian version and OS.
- 📄 **have a file that doesn't open or looks wrong.** Mention the file extension and, if possible, attach a sample file. Make sure the file contains nothing private.
- ✨ **want a new format or feature.** Say what you'd like and how you'd use it.
- 🌍 **found a translation mistake**, or want to add a new interface language.

Code contributions are welcome too. Fork the repository, make your changes and open a **pull request**. See [Building from source](#building-from-source) below.

## Support

If you find the plugin useful, you can support its development on **[Boosty](https://boosty.to/programmedbygod)** ❤️

## Privacy and network use

The plugin works fully offline:
- It makes **no network requests**.
- It does not collect or send any data.
- It never downloads or updates anything by itself.

The only link to the internet is the "Download from GitHub" button. It opens this repository's releases page in your browser, and only when you click it.

Reading positions are stored in `reader/library.json` inside your vault. You can change the folder in the settings.

## Language

The interface is in English by default. Russian can be selected in the settings under "Language / Язык".

## Conflicts with other plugins

If another plugin already opens an extension (for example, an EPUB reader or Excalidraw), Universal Reader gives way and tells you once. The settings then show a "Conflicts with other plugins" list, where you can choose which plugin opens each such extension.

## Building from source

```bash
npm install
node build.mjs dist          # → dist/main.js, manifest.json, styles.css, libs/
node readme.mjs dist/README.txt en
```

- `src/`: plugin code.
- `libs-src/`: entry points for the libraries. Popular ones are built into `main.js`; the rest go into `libs/`.
- `i18n/`: build-time translation. Interface strings are written in Russian in the source, `i18n/transform.mjs` wraps them, and `i18n/en.json` holds the English translations.
- `vendor/`: foliate-js and DjVu.js.

## License

[GPL-3.0-or-later](LICENSE). The plugin includes code under GPL licenses: uniorg (GPL-3.0+), DjVu.js (GPL-2.0+), and format layouts derived from Calibre (GPL-3.0).

Bundled libraries: foliate-js (MIT), DjVu.js (GPL-2.0+), JSZip (MIT), mammoth (BSD-2), rtf.js (MIT), SheetJS (Apache-2.0), node-unrar-js (MIT, unRAR license), 7z-wasm (LGPL), UTIF.js (MIT), pptx-preview, asciidoctor.js (MIT), uniorg (GPL-3.0+), opentype.js (MIT), libheif-js (LGPL-3.0), ag-psd (MIT), sql.js (MIT), abcjs (MIT), bz2 (MIT), fflate (MIT), fzstd (MIT), xz-decompress (MIT), lz4js (ISC), hyparquet (MIT), apache-arrow (Apache-2.0), mdb-reader (MIT), textile-js (MIT), djot (MIT), msgreader (Apache-2.0), viz.js / Graphviz (EPL), OpenSheetMusicDisplay (BSD-3), @jsquash/jxl (Apache-2.0), bpmn-js (bpmn.io license), three.js (MIT), dxf-parser (MIT), hwp.js (Apache-2.0), roughjs (MIT), h5wasm / HDF5 (BSD), Verovio (LGPL-3.0), occt-import-js and OpenCascade (LGPL-2.1), rhino3dm (MIT), web-ifc (MPL-2.0), Ruffle (MIT / Apache-2.0). The SAS format reader follows the description in pandas (BSD-3).
