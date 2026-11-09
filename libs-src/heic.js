import factory from 'libheif-js/libheif-wasm/libheif-bundle.js'
let lib = null
module.exports = { get: () => (lib ??= factory()) }
