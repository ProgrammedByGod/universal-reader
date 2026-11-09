import * as lz4 from 'lz4js'
module.exports = { decompress: u8 => new Uint8Array(lz4.decompress(u8)) }
