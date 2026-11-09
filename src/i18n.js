// Перевод интерфейса. Строки в исходниках пишутся по-русски; при сборке каждая русская строка
// оборачивается в T(...) / TT`...` (см. i18n/transform.mjs), а здесь подменяется английской.
// Язык читается при загрузке плагина; при смене языка в настройках плагин перезапускается.
import EN from '../i18n/en.json'

export const LANG_KEY = 'universal-reader-lang'
const readLang = () => {
    try { const v = window.localStorage?.getItem(LANG_KEY); if (v === 'ru' || v === 'en') return v } catch {}
    return 'en'
}
export let lang = readLang()
export const isRu = () => lang === 'ru'
export const saveLang = v => { try { window.localStorage.setItem(LANG_KEY, v); return window.localStorage.getItem(LANG_KEY) === v } catch { return false } }

// ctx — имя файла исходника: для слов с разным смыслом («Вт» — вторник или ватт)
export function T(s, ctx) {
    if (lang === 'ru') return s
    return EN[ctx + '|' + s] ?? EN[s] ?? s
}
const fill = (tpl, vals) => tpl.replace(/\{(\d+)\}/g, (m, i) => (+i < vals.length ? vals[+i] : m))
export function TT(ctx) {
    return (strings, ...vals) => {
        const key = strings.reduce((a, s, i) => (i ? a + `{${i - 1}}` + s : s), '')
        if (lang === 'ru') return strings.reduce((a, s, i) => a + String(vals[i - 1]) + s)
        return fill(EN[ctx + '|' + key] ?? EN[key] ?? key, vals.map(String))
    }
}
// не переводить (строки, которые сверяются с содержимым файла)
export const NT = s => s
export const LOC = () => (lang === 'ru' ? 'ru-RU' : 'en-US')
// русские формы: [один, два, пять]; по-английски — [один, много]
export const plural = (n, [one, few, many]) => lang !== 'ru'
    ? (Math.abs(n) === 1 ? one : many)
    : (n % 10 === 1 && n % 100 !== 11) ? one : (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20)) ? few : many
