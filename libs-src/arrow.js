import { tableFromIPC, compressionRegistry, CompressionType } from 'apache-arrow'
import { decompress as zstd } from 'fzstd'
import * as lz4 from 'lz4js'
compressionRegistry.set(CompressionType.LZ4_FRAME, { decode: u8 => new Uint8Array(lz4.decompress(u8)) })
compressionRegistry.set(CompressionType.ZSTD, { decode: u8 => zstd(u8) })
module.exports = { tableFromIPC }
