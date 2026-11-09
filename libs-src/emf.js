import * as EMF from 'rtf.js/dist/EMFJS.bundle.js'
import * as WMF from 'rtf.js/dist/WMFJS.bundle.js'
module.exports = { EMFJS: EMF.EMFJS ?? EMF.default?.EMFJS ?? EMF, WMFJS: WMF.WMFJS ?? WMF.default?.WMFJS ?? WMF }
