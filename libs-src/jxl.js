import decode, { init } from '@jsquash/jxl/decode.js'
import wasm from '@jsquash/jxl/codec/dec/jxl_dec.wasm'
let ready = null
module.exports = { decode: async buf => { ready ??= WebAssembly.compile(wasm).then(m => init(m)); await ready; return decode(buf) } }
