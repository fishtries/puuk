# Восстановление метаданных импорта Spotify

`spotify_imports.py` восстанавливает теги файлов из журнала инцидента по сохранённому
Spotify track URL (`WOAS`). Аудио не скачивается и не перекодируется. Файлы без
однозначного совпадения пропускаются и попадают в `plan.json`.

1. Сохранить journal бота с записями `changed_files` за период инцидента.
2. Получить manifest исходных ссылок без поиска текстов:
   `python -m spotdl save URL... --save-file source.spotdl --lyrics`.
3. Запустить dry-run в venv бота:

```bash
python scripts/repair/spotify_imports.py \
  --repo /home/fish/apps/puuk/puuk \
  --incident /path/to/incident.log \
  --source /path/to/source.spotdl \
  --backup /path/to/backup
```

4. Проверить `plan.json`, повторить команду с `--apply`.

Перед записью сохраняются SQLite через backup API (`before.db`) и полные исходные
файлы (`audio/`). Изменения публикуются атомарно, после сравнения SHA-256 MPEG
данных. В каталоге обновляются метаданные и версия обложки; ID, лайки и история
сохраняются. Прогресс записывается в `result.json`. Для отката доступны исходные
файлы и снимок базы; восстанавливать всю базу поверх новых действий пользователей
без отдельной сверки не следует.
