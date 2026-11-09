// подставляется в сборку библиотеки вместо глобальных process и Buffer
import { Buffer as B } from 'buffer'
export const process = { browser: true, version: '', versions: {}, env: {}, nextTick: (f, ...a) => queueMicrotask(() => f(...a)), cwd: () => '/', stdout: null, stderr: null }
export const Buffer = B
