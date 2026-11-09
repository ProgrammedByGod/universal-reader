// Декодер JPEG 2000 (OpenJPEG, сборка Cornerstone): для .jp2/.j2k и снимков DICOM
import factory from '../node_modules/@cornerstonejs/codec-openjpeg/dist/openjpegwasm_decode.js'
import wasm from '../node_modules/@cornerstonejs/codec-openjpeg/dist/openjpegwasm_decode.wasm'
let mod = null
const init = async () => mod ??= await factory({ wasmBinary: wasm, locateFile: f => f })
// codestream: Uint8Array с потоком J2K (без коробок JP2)
const decode = async codestream => {
    const m = await init()
    const d = new m.J2KDecoder()
    try {
        d.getEncodedBuffer(codestream.length).set(codestream)
        d.decode()
        const info = d.getFrameInfo()
        const out = d.getDecodedBuffer()
        return { width: info.width, height: info.height, bits: info.bitsPerSample, signed: info.isSigned, comps: info.componentCount, data: new Uint8Array(out).slice() }
    } finally { d.delete?.() }
}
module.exports = { decode }
