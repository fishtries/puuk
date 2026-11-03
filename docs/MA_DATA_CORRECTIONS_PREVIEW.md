# Старые данные: конкретный предпросмотр исправлений

Это подготовленный план для согласования, не применённый production результат.
Срез: 1149 треков / 891 альбом; схема обновлена только на disposable copy.
Официальный источник: [Spotify — Fauxllennium (Japanese Deluxe Edition)](https://open.spotify.com/embed/album/5MQx9UktIiM86OYBZh1c4M); для Monday, Monday также [точная карточка трека](https://open.spotify.com/embed/track/14joz9oqnhYORgpKOmE0Aj).
Группа TV Girl и явно перечисленные исполнители сохранены; авторов/состав группы из songwriting credits не выводили. Neggy Gemmy добавляется по явному списку исполнителей Spotify, не извлекается из title. Title, album credits, album ID и audio не меняются.

| Трек | Было | Станет | Revision |
| --- | --- | --- | --- |
| Summer 2000 Baby | TV Girl/George Clanton | TV Girl, George Clanton | 1 |
| Everything Blue | TV Girl & George Clanton | TV Girl, George Clanton | 1 |
| Monday, Monday (feat. Neggy Gemmy) | TV Girl & George Clanton | TV Girl, George Clanton, Neggy Gemmy | 1 |
| Take a Trip | TV Girl/George Clanton | TV Girl, George Clanton | 1 |
| Fauxllennium | TV Girl, George Clanton | TV Girl, George Clanton | 1 |


Всего 5 подтверждённых предложений; 243 остальных кандидата остаются неоднозначными и не выбираются. Это не глобальный allowlist и не универсальное разделение пунктуации.

Артефакты:
- Выбранный JSON с evidence, точными IDs/revisions и отпечатками: [MA_SELECTED_ARTIST_CORRECTIONS.json](MA_SELECTED_ARTIST_CORRECTIONS.json)
- Полный локальный отчёт248кандидатов: /tmp/puuk-ma-selected-corrections.json
- Receipt проверки на копии: /tmp/puuk-ma-correction-validation.json
- Disposable validation DB: /tmp/puuk-ma-correction-validation.db

На копии выполнены CLI preview → apply → повтор apply → undo → повтор undo: все exit0, применены/отменены ровно5 строк, повторные вызовы идемпотентны. Все raw rows таблиц tracks и albums побайтово в значениях сохранились, менялись только credits/state/journal/catalog version. Это демонстрация исправления и условной отмены; настоящий rollout требует fresh report и revisions, а не переноса operation ID из копии. Исходная серверная БД, оригинальный snapshot и аудиофайлы не изменялись. Для production выбранные IDs/источники пересверяются перед применением.
