// Декодер JPEG без потерь (для снимков DICOM)
import * as jll from 'jpeg-lossless-decoder-js'
const Decoder = jll.Decoder ?? jll.default?.Decoder ?? jll.lossless?.Decoder
module.exports = { decode: (bytes) => { const d = new Decoder(); const out = d.decompress(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)); return { data: new Uint8Array(out), bytesPerSample: d.getBytesPerSample?.() ?? null, width: d.frame?.samplesPerLine, height: d.frame?.numLines, comps: d.frame?.numComp } } }
