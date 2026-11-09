import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js'
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js'
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js'
import { VRMLLoader } from 'three/examples/jsm/loaders/VRMLLoader.js'
import { AMFLoader } from 'three/examples/jsm/loaders/AMFLoader.js'
import { VOXLoader } from 'three/examples/jsm/loaders/VOXLoader.js'
import { PCDLoader } from 'three/examples/jsm/loaders/PCDLoader.js'
import { VTKLoader } from 'three/examples/jsm/loaders/VTKLoader.js'
import { MD2Loader } from 'three/examples/jsm/loaders/MD2Loader.js'
import { GCodeLoader } from 'three/examples/jsm/loaders/GCodeLoader.js'
import { PDBLoader } from 'three/examples/jsm/loaders/PDBLoader.js'
import { XYZLoader } from 'three/examples/jsm/loaders/XYZLoader.js'
module.exports = { THREE, OrbitControls, STLLoader, OBJLoader, GLTFLoader, PLYLoader, ThreeMFLoader,
    FBXLoader, ColladaLoader, TDSLoader, VRMLLoader, AMFLoader, VOXLoader, PCDLoader, VTKLoader, MD2Loader, GCodeLoader, PDBLoader, XYZLoader }
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js'
module.exports.parseExr = buf => { const l = new EXRLoader(); l.setDataType(THREE.FloatType); return l.parse(buf) }
import { USDLoader } from 'three/examples/jsm/loaders/USDLoader.js'
import { LWOLoader } from 'three/examples/jsm/loaders/LWOLoader.js'
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js'
import { MMDParser } from 'mmd-parser'
import dracoWrapper from './draco_wrapper.txt'
import dracoWasm from '../node_modules/three/examples/jsm/libs/draco/draco_decoder.wasm'
Object.assign(module.exports, { USDLoader, LWOLoader, BVHLoader, SkeletonUtils, MMDParser })
// Draco: декодер встроен в библиотеку, без загрузки из интернета
module.exports.makeDraco = () => {
    const d = new DRACOLoader()
    d.setDecoderConfig({ type: 'wasm' })
    d._loadLibrary = (url) => Promise.resolve(url.endsWith('.wasm') ? dracoWasm.buffer.slice(dracoWasm.byteOffset, dracoWasm.byteOffset + dracoWasm.byteLength) : dracoWrapper)
    return d
}
