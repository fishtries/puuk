-- Migration 007: сохраняемый порядок треков в плейлистах (колонка position).
--
-- ALTER TABLE ADD COLUMN не идемпотентен, а apply_migrations применяет SQL
-- сплитом по точке с запятой и глушит только ошибки duplicate column. Поэтому
-- и ALTER, и backfill position = 0..N-1 (по added_at ASC внутри каждого
-- playlist) выполняются python-логикой в repositories/schema.py
-- (_ensure_playlist_track_positions) ДО вызова apply_migrations: если колонка
-- уже существует, шаг полностью пропускается и повторный запуск init_db
-- не сбрасывает сохранённый пользователем порядок.
-- Этот файл — каноническая запись версии в schema_migrations.

ALTER TABLE playlist_tracks ADD COLUMN position INTEGER NOT NULL DEFAULT 0
