// OpenCascade (occt-import-js): STEP, IGES, BREP → треугольные сетки. Сам .wasm лежит рядом, отдельным файлом
import factory from '../node_modules/occt-import-js/dist/occt-import-js.js'
let mod = null
module.exports = { init: wasmBinary => (mod ??= factory({ wasmBinary, locateFile: f => f })) }
