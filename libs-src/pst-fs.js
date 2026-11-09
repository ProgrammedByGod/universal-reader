// файловая система не нужна: файл передаётся целиком в памяти
const no = () => { throw new Error('fs недоступна') }
export const openSync = no, readSync = no, closeSync = () => {}
export default { openSync, readSync, closeSync }
