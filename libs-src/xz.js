import { XzReadableStream } from 'xz-decompress'
module.exports = { decompress: async u8 => new Uint8Array(await new Response(new XzReadableStream(new Blob([u8]).stream())).arrayBuffer()) }
