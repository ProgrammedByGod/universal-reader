// Собирает README.txt для архива плагина из реестра форматов
import fs from 'node:fs'
import { FORMAT_LIST, GROUPS, ALL_EXTS, MOBILE_EXCLUDED } from './src/registry.js'

const EN = JSON.parse(fs.readFileSync('i18n/en.json', 'utf8'))
const LANG = process.argv[3] || 'ru'
const tr = x => (LANG === 'en' ? EN[x] ?? x : x)
const version = JSON.parse(fs.readFileSync('manifest.json', 'utf8')).version.replace(/-alpha$/, '')
const mobile = ALL_EXTS.length - new Set(MOBILE_EXCLUDED).size
const wrap = (s, w = 96, ind = '   ') => { const out = []; let line = ''; for (const word of s.split(' ')) { if ((line + ' ' + word).length > w) { out.push(line); line = ind + word } else line = line ? line + ' ' + word : word } out.push(line); return out.join('\n') }
let fmt = ''
for (const [g, name] of GROUPS) {
    const items = FORMAT_LIST.filter(f => f.group === g)
    fmt += `\n${tr(name).toUpperCase()}\n`
    for (const f of items) fmt += wrap(`• ${tr(f.name)}: ${f.exts.map(e => '.' + e).join(' ')} — ${tr(f.desc)}${f.heavy ? (LANG === 'en' ? ' [not on mobile]' : ' [не на телефоне]') : ''}`) + '\n'
}
const textRu = `Универсальная читалка для Обсидиана — альфа ${version} (только чтение)

УСТАНОВКА / ОБНОВЛЕНИЕ
1. Сделайте резервную копию хранилища (или проверяйте на тестовом хранилище).
2. Скопируйте папку universal-reader целиком (вместе с папкой libs) в
   <ваше хранилище>/.obsidian/plugins/  (при обновлении — заменить содержимое).
3. Перезапустите Обсидиан: Настройки → Сторонние плагины → «Универсальная читалка».

Если плагин установлен из каталога Обсидиана, в нём нет папки libs. Популярные форматы (Word, Excel,
PowerPoint, TIFF, HEIC, DjVu, RAR, SQLite, 3D-модели) встроены и работают и так. Для редких тяжёлых форматов
(7z, RTF, ноты, CAD, научные данные, Flash) скачайте архив universal-reader-libs со страницы
https://github.com/ProgrammedByGod/universal-reader/releases и распакуйте его в папку плагина
<хранилище>/.obsidian/plugins/universal-reader/ — должна получиться папка libs. Плагин сам ничего не скачивает.

НАСТРОЙКИ ФОРМАТОВ
В настройках плагина — список всех форматов по группам, с описанием и переключателем.
Выключенный формат читалка не забирает — его откроет Обсидиан или другой плагин.
Есть поиск по названию или расширению и кнопки «Включить/Выключить группу».
Изменения действуют сразу (уже открытые вкладки нужно открыть заново).

КОНФЛИКТЫ С ДРУГИМИ ПЛАГИНАМИ
Если расширение уже открывает другой плагин (например, EPUB-читалка или Excalidraw), Универсальная
читалка ему уступает и один раз сообщает об этом. В настройках появляется блок «Конфликты с другими
плагинами»: для каждого такого расширения есть переключатель — включите, и файл будет открывать читалка;
выключите — расширение вернётся прежнему плагину. Выбор запоминается.

Любой файл можно посмотреть побайтно: правый клик → «Показать в шестнадцатеричном виде».
Заметку .md можно открыть как книгу: правый клик → «Открыть как книгу».
PDF пока открывает встроенный просмотрщик Обсидиана.
Место чтения сохраняется в папке «Читалка/library.json» в хранилище.

ФОРМАТЫ: ${ALL_EXTS.length} расширений, на телефоне ${mobile} (без самых тяжёлых)
${fmt}
ЛИЦЕНЗИИ БИБЛИОТЕК
foliate-js (MIT), DjVu.js (GPL-2.0+), JSZip (MIT), mammoth (BSD-2), rtf.js (MIT),
SheetJS (Apache-2.0), node-unrar-js (MIT, unRAR license), 7z-wasm (LGPL),
UTIF.js (MIT), pptx-preview (бесплатна для использования), asciidoctor.js (MIT),
uniorg (GPL-3.0+), opentype.js (MIT), libheif-js (LGPL-3.0), ag-psd (MIT), sql.js (MIT),
abcjs (MIT), bz2 (MIT), fflate (MIT), fzstd (MIT), xz-decompress (MIT), lz4js (ISC),
hyparquet (MIT), apache-arrow (Apache-2.0), mdb-reader (MIT), textile-js (MIT), djot (MIT),
msgreader (Apache-2.0), viz.js / Graphviz (EPL), OpenSheetMusicDisplay (BSD-3),
@jsquash/jxl (Apache-2.0), bpmn-js (bpmn.io license), three.js (MIT), dxf-parser (MIT),
hwp.js (Apache-2.0), roughjs (MIT), h5wasm / HDF5 (BSD), Verovio (LGPL-3.0), occt-import-js и OpenCascade (LGPL-2.1),
rhino3dm (MIT), web-ifc (MPL-2.0), Ruffle (MIT / Apache-2.0). Устройство старых форматов — по Calibre (GPL-3.0),
формат SAS — по описанию из pandas (BSD-3).

ИЗМЕНЕНИЯ
0.8.1 — исправления по проверке каталога Обсидиана: Flash (Ruffle) загружается без вставки <script>
        на страницу; из встроенных библиотек убраны старые полифилы, создававшие элементы <script>.
        Фото с iPhone (HEIC, HEIF) открываются без пакета библиотек и теперь работают и на телефоне.
0.8.0 — подготовка к каталогу Обсидиана. Популярные библиотеки (Word, Excel, PowerPoint, TIFF, DjVu,
        RAR, SQLite, 3D-модели и др.) встроены в main.js; остальные вынесены в отдельный пакет libs.
        Если для файла нужен пакет, а его нет, читалка показывает, где его скачать и куда положить;
        в настройках видно, установлен ли пакет.
0.7.0 — интерфейс на двух языках: английский (по умолчанию) и русский, переключается в настройках
        («Language / Язык»). Папка для данных чтения по умолчанию теперь «reader» (старая папка «Читалка»
        переносится сама). Даты и числа показываются по правилам выбранного языка.
0.6.1 — большие библиотеки: научные данные HDF5 (а также NetCDF-4 и MATLAB 7.3), ноты MEI и Humdrum
        (с прослушиванием), инженерные модели STEP, IGES и BREP с цветами деталей, модели Rhino (.3dm),
        здания IFC, ролики и игры Flash (.swf) через эмулятор Ruffle — без доступа в интернет. Эти форматы
        не включаются на телефоне: библиотеки весят по нескольку мегабайт.
0.6.0 — форматы «на две и три звёздочки»:
        распознавание по содержимому (переписки Телеграма, WhatsApp, Discord, SMS, история перемещений Google,
        выписки 1С, Thumbs.db, геномные VCF и другие); старые Word (.doc), PowerPoint (.ppt), справка CHM, XPS,
        Visio, DocBook, TEI, JATS, GNU Info и Texinfo, KWord, Scribus, HWPX, InDesign IDML, Celtx, OFD;
        Joplin, CherryTree, Xournal++, SMART Notebook, GoodNotes, Scratch, Mathematica, MindManager, SimpleMind;
        почта Outlook (.pst, .ost), Outlook для Mac (.olm), Outlook Express (.dbx), электронные подписи;
        DICOM и NIfTI (снимки КТ и МРТ), NRRD, ЭЭГ (EDF), NumPy, MATLAB, R, SAS Transport, SPSS Portable, NetCDF,
        QlikView, OFX, геномы, молекулы и кристаллы в 3D, масс-спектры, цитометрия, GeoPackage, MBTiles;
        GIMP, JPEG 2000, SGI, Sun, Amiga, игровые текстуры, PICT, MNG, EPS, ICC, LUT, превью Clip Studio,
        InDesign, Affinity; USDZ, LightWave, Draco, MikuMikuDance, Tilt Brush, BVH-анимации, миниатюры Blender;
        платы Gerber и KiCad; тренировки Garmin FIT и Sigma, OpenStreetMap, GML, MapInfo, «Здоровье» Apple,
        CSV с координатами на карте; аудиокниги с главами, AIFF, CAF, DSD, FLV и MPEG-TS, проекты Ableton,
        трекерная музыка и музыка приставок (сведения), субтитры DVD/Blu-ray, MIDI со звуком; образы дисков
        и установщики (DMG, MSI, VHD, VMDK, Snap, AppImage…), многотомные архивы, Brotli, игровые архивы,
        «паспорт» пакетов; шрифты PCF, BMFont, .dfont, исходники FontForge/Glyphs/UFO/FontLab, Hershey и BGI;
        ключи SSH/PGP, контрольные суммы с проверкой, SARIF, LCOV, JUnit, записи терминала asciinema;
        программы и прошивки (ELF, Mach-O, Java, Android DEX, WebAssembly, Python, Lua), ROM приставок,
        ярлыки Windows, журналы событий Windows (.evtx), дампы памяти, профили iOS, сертификаты и ключи (.p7b, .crl,
        .p12), базы KeePass (только сведения, без паролей), переводы Qt, LyX, DITA.
        Новые функции: «Сведения о файле» (размер, даты, настоящий тип файла, EXIF и место съёмки на карте,
        теги музыки с обложкой и текстом песни, свойства документов и PDF, контрольные суммы);
        «Сравнить с другим файлом» (построчно для текста, по байтам для остального); выбор кодировки
        для текстовых файлов; кнопка «Скопировать как Markdown» (таблицы, статьи, текущая глава книги);
        файлы из архивов и вложения писем открываются читалкой в отдельном окне; если файл повреждён —
        вместо ошибки показывается, что удалось узнать, текстовые строки и байты; ![[файл]] в заметке
        показывается карточкой с кнопками «Открыть в читалке» и «Сведения».
0.5.0 — ещё ~340 расширений «на одну звёздочку»: книги Xteink (.xtc, .xtch), ярлыки Google Диска, формулы MathML,
        таблицы Apple Numbers (настоящей таблицей), Lotus 1-2-3, Quattro Pro, SYLK, DIF, QIF, LTSV, заметки Tomboy,
        TiddlyWiki, TaskPaper, KityMinder, SMS и заметки старых телефонов, ДНК (FASTA/FASTQ), тренировки TCX, PWX,
        Polar, полёты IGC, OziExplorer, NMEA, TomTom, WKT, 3D-модели FBX, Collada, 3ds, VRML, AMF, MagicaVoxel,
        облака точек, G-code в 3D, превью Procreate, Sketch, Adobe XD, CorelDRAW, Paint.NET, FreeCAD и MuseScore,
        палитры, метаданные XMP, остальные RAW-фотоаппараты, шрифты консоли PSF, метрики AFM/PFM, архивы LZMA,
        lzip, LHA, ARJ, cpio, библиотеки .a/.lib, UUE/XXE/Base64/BinHex, пакеты приложений Android, Windows Store,
        Ruby, Rust, звук AAC и видео .m4v/.3g2, около 150 языков программирования, конфигов и шаблонов.
        Читалка больше не отнимает форматы у других плагинов: уступает им, а в настройках появился блок
        «Конфликты с другими плагинами», где любое такое расширение можно забрать себе переключателем.
0.4.1 — наброски Excalidraw (.excalidraw) и доски tldraw (.tldr). «Спорные» форматы (Excalidraw, tldraw,
        draw.io, 3D-модели, карты мыслей) читалка забирает последней и уступает их «родному» плагину.
0.4.0 — ещё ~250 расширений: почтовые ящики и Outlook, архивы сайтов, Evernote, карты мыслей,
        Anki, семейные деревья, песни с аккордами, плейлисты, торренты, сертификаты, переводы,
        языки разметки, новые языки кода, Access/Parquet/Arrow/Avro/SPSS/Stata/SAS/dBase,
        MusicXML и MIDI, Graphviz, draw.io, BPMN, DXF, 3D-модели, карты GPX/KML/GeoJSON/Shapefile
        (без интернета), редкие картинки, RAW-превью, JPEG XL, HDR/EXR, шрифты Type 1 и точечные,
        пакеты Linux, CAB, ISO, программы Windows (только сведения), hex-просмотр.
        Новые настройки: список форматов с описаниями и переключателями.
0.3.0 — разновидности Office, старый Excel .xls, архивы, шрифты, HEIC, PSD, иконки, SQLite,
        ноты ABC, диаграммы Mermaid, субтитры TTML/SAMI, старые форматы книг (TCR, PML, eReader,
        zTXT, SNB, LRF), двоичный plist и другие расширения.
0.2.0 — субтитры, тексты песен, контакты, календари, OPML, RSS/Atom, переводы .po,
        письма .eml, списки литературы, diff/patch, .nfo, сценарии Fountain, исходный код и конфиги.
0.1.2 — сноски входят в нумерацию, до них можно долистать.
0.1.1 — настоящие номера страниц без перескоков.
`
const textEn = `Universal Reader and File Viewer for Obsidian — alpha ${version} (read-only)

INSTALL / UPDATE
1. Back up your vault (or test on a separate vault).
2. Copy the universal-reader folder in full (including the libs folder) into
   <your vault>/.obsidian/plugins/  (when updating, replace its contents).
3. Restart Obsidian: Settings → Community plugins → "Universal Reader and File Viewer".

If the plugin was installed from the Obsidian catalog, it has no libs folder. Popular formats (Word,
Excel, PowerPoint, TIFF, HEIC, DjVu, RAR, SQLite, 3D models) are built in and work anyway. For rare heavy
formats (7z, RTF, sheet music, CAD, scientific data, Flash) download universal-reader-libs from
https://github.com/ProgrammedByGod/universal-reader/releases and unpack it into the plugin folder
<vault>/.obsidian/plugins/universal-reader/ so that a libs folder appears. The plugin never downloads anything itself.

LANGUAGE
The interface is in English by default. Russian can be selected in the plugin settings
("Language / Язык"); the plugin restarts itself to apply it.

FORMAT SETTINGS
The plugin settings list every format by group, with a description and a toggle.
The reader does not take a disabled format — Obsidian or another plugin opens it.
There is a search by name or extension and "Enable/Disable group" buttons.
Changes apply immediately (tabs that are already open need to be reopened).

CONFLICTS WITH OTHER PLUGINS
If an extension is already opened by another plugin (e.g. an EPUB reader or Excalidraw), Universal
Reader gives way and tells you once. The settings then show a "Conflicts with other plugins" block:
each such extension has a toggle — turn it on and the reader opens the file; turn it off and the
extension goes back to the previous plugin. The choice is remembered.

Any file can be viewed byte by byte: right-click → "Show in hex view".
A .md note can be opened as a book: right-click → "Open as book".
PDF is still opened by Obsidian's built-in viewer.
Reading positions are saved in "reader/library.json" in the vault.

FORMATS: ${ALL_EXTS.length} extensions, ${mobile} on mobile (without the heaviest)
${fmt}
LIBRARY LICENSES
foliate-js (MIT), DjVu.js (GPL-2.0+), JSZip (MIT), mammoth (BSD-2), rtf.js (MIT),
SheetJS (Apache-2.0), node-unrar-js (MIT, unRAR license), 7z-wasm (LGPL),
UTIF.js (MIT), pptx-preview (free to use), asciidoctor.js (MIT),
uniorg (GPL-3.0+), opentype.js (MIT), libheif-js (LGPL-3.0), ag-psd (MIT), sql.js (MIT),
abcjs (MIT), bz2 (MIT), fflate (MIT), fzstd (MIT), xz-decompress (MIT), lz4js (ISC),
hyparquet (MIT), apache-arrow (Apache-2.0), mdb-reader (MIT), textile-js (MIT), djot (MIT),
msgreader (Apache-2.0), viz.js / Graphviz (EPL), OpenSheetMusicDisplay (BSD-3),
@jsquash/jxl (Apache-2.0), bpmn-js (bpmn.io license), three.js (MIT), dxf-parser (MIT),
hwp.js (Apache-2.0), roughjs (MIT), h5wasm / HDF5 (BSD), Verovio (LGPL-3.0), occt-import-js and OpenCascade (LGPL-2.1),
rhino3dm (MIT), web-ifc (MPL-2.0), Ruffle (MIT / Apache-2.0). Old format layouts — after Calibre (GPL-3.0),
SAS format — after the description in pandas (BSD-3).

CHANGES
0.8.1 — fixes for the Obsidian catalog review: Flash (Ruffle) is loaded without inserting a <script>
        into the page; old polyfills that created <script> elements were removed from bundled libraries.
        iPhone photos (HEIC, HEIF) now open without the libs pack and also work on mobile.
0.8.0 — getting ready for the Obsidian catalog. Popular libraries (Word, Excel, PowerPoint, TIFF, DjVu,
        RAR, SQLite, 3D models and more) are built into main.js; the rest moved to a separate libs pack.
        If a file needs the pack and it is missing, the reader shows where to download it and where to
        put it; the settings show whether the pack is installed.
0.7.0 — two interface languages: English (default) and Russian, switched in the settings
        ("Language / Язык"). The default reading data folder is now "reader" (the old "Читалка"
        folder is moved automatically). Dates and numbers follow the selected language.
0.6.1 — big libraries: HDF5 scientific data (plus NetCDF-4 and MATLAB 7.3), MEI and Humdrum scores
        (with playback), STEP, IGES and BREP engineering models with part colours, Rhino models (.3dm),
        IFC buildings, Flash movies and games (.swf) via the Ruffle emulator — with no internet access.
        These formats are not enabled on mobile: the libraries weigh several megabytes each.
0.6.0 — "two and three star" formats: detection by content (Telegram, WhatsApp, Discord and SMS
        exports, Google location history, 1C statements, Thumbs.db, VCF genomes and more); old Word,
        PowerPoint, CHM help, XPS, Visio, DocBook, TEI, JATS, GNU Info, Outlook .pst/.ost, DICOM, NIfTI,
        EDF, NumPy, MATLAB, R, SAS, SPSS, NetCDF, KiCad and Gerber boards, Garmin FIT, disk images and
        installers, program and firmware info, KeePass (information only, no passwords) and many more.
        New functions: "File information", "Compare with another file", text encoding selection,
        "Copy as Markdown", opening files from archives and email attachments in the reader,
        a readable report for damaged files, ![[file]] embeds shown as a card.
0.5.0 — ~340 more "one star" extensions; the reader no longer takes formats from other plugins
        and has a "Conflicts with other plugins" settings block.
0.4.x — ~250 more extensions: mailboxes, website archives, mind maps, Anki, genealogy, maps,
        3D models, sheet music, Excalidraw and tldraw; format settings with toggles.
0.3.0 — Office variants, old Excel, archives, fonts, HEIC, PSD, icons, SQLite and more.
0.2.0 — subtitles, lyrics, contacts, calendars, feeds, translations, email, code and configs.
0.1.x — books with real page numbers and footnotes.
`
const out = process.argv[2] || 'README.txt'
fs.writeFileSync(out, LANG === 'en' ? textEn : textRu)
console.log('README:', ALL_EXTS.length, 'расширений, телефон', mobile)
