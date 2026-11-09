// HDF5 (h5wasm, wasm встроен): научные данные .h5/.hdf5, MATLAB v7.3, NetCDF-4
import h5wasm, { ready } from '../node_modules/h5wasm/dist/esm/hdf5_hl.js'
module.exports = { h5wasm, ready: () => ready }
