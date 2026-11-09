import { createExtractorFromData } from 'node-unrar-js/esm/index.js'
import wasmBinary from 'node-unrar-js/esm/js/unrar.wasm'
module.exports = { createExtractorFromData, wasmBinary: wasmBinary.buffer.slice(wasmBinary.byteOffset, wasmBinary.byteOffset + wasmBinary.byteLength) }
