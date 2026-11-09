// Пакет библиотек (папка libs): в каталоге Обсидиана плагин ставится без него,
// а сам пакет пользователь скачивает с GitHub и кладёт в папку плагина вручную.
// Плагин ничего не скачивает сам — это запрещено правилами каталога.
export const REPO_URL = 'https://github.com/ProgrammedByGod/universal-reader'
export const LIBS_URL = REPO_URL + '/releases/latest'
// номер пакета: увеличивать, когда библиотеки меняются так, что старый пакет не подходит
export const LIBS_PACK = 1

export class LibsMissingError extends Error {
    constructor(name, outdated) {
        super(outdated
            ? `Для этого формата нужен более новый пакет библиотек (не найден файл ${name}). Скачайте свежий пакет и замените им папку libs в папке плагина.`
            : `Для этого формата нужен пакет библиотек (папка libs), а он не установлен. Скачайте его с GitHub и положите папку libs в папку плагина.`)
        this.libsMissing = true
        this.outdated = !!outdated
    }
}
