import { decompress } from 'brotli/decompress.js'
module.exports = { decompress: u8 => decompress(u8) }
