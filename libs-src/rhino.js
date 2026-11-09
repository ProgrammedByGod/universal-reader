// rhino3dm: модели Rhino .3dm. Сам .wasm лежит рядом, отдельным файлом
import rhino3dm from '../node_modules/rhino3dm/rhino3dm.module.js'
let mod = null
module.exports = { init: wasmBinary => (mod ??= rhino3dm({ wasmBinary, locateFile: f => f })) }
