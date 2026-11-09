import textile from 'textile-js'
import * as djot from '@djot/djot'
module.exports = { textile: s => textile.parse(s), djot: s => djot.renderHTML(djot.parse(s)) }
