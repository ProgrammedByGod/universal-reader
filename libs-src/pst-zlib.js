// pst-extractor распаковывает сжатые блоки через node:zlib — подменяем на fflate
import { unzlibSync, inflateSync } from 'fflate'
import { Buffer } from 'buffer'
export const unzipSync = b => { const u = new Uint8Array(b); try { return Buffer.from(unzlibSync(u)) } catch { return Buffer.from(inflateSync(u)) } }
export default { unzipSync }
