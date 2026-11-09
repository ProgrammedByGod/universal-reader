// Verovio (с Humdrum): ноты MEI, Humdrum **kern, MusicXML, PAE → SVG
import createVerovioModule from '../node_modules/verovio/dist/verovio-module-hum.mjs'
import { VerovioToolkit } from '../node_modules/verovio/dist/verovio.mjs'
let mod = null
module.exports = { toolkit: async () => new VerovioToolkit(await (mod ??= createVerovioModule())) }
