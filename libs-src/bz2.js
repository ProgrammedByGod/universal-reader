// библиотека в браузере кладёт себя в window.bz2, а в Node — в module.exports
import * as m from 'bz2'
const lib = () => globalThis.bz2 ?? m.default ?? m
module.exports = { decompress: data => lib().decompress(data) }
