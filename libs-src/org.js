import { unified } from 'unified'
import uniorgParse from 'uniorg-parse'
import uniorg2rehype from 'uniorg-rehype'
import rehypeStringify from 'rehype-stringify'
const proc = unified().use(uniorgParse).use(uniorg2rehype).use(rehypeStringify)
module.exports = { toHtml: text => String(proc.processSync(text)) }
