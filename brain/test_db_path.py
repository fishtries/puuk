"""Изоляция тестовой БД: временный путь вместо рабочего puuk.db.

Импортируется первым в тестовых модулях ДО импорта db/config —
переназначает PUUK_DB_PATH, чтобы прогоны тестов не оставляли мусор
в рабочей базе (см. backlog: 67 тестовых записей накопилось в puuk.db).

Первый импорт в процессе фиксирует путь; остальные тестовые модули
разделяют ту же временную БД (unittest discover выполняется одним процессом).
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(__file__))

_TEST_DB_DIR = os.environ.setdefault("PUUK_TESTS_TMP", tempfile.mkdtemp(prefix="puuk_tests_"))
os.environ.setdefault("PUUK_DB_PATH", os.path.join(_TEST_DB_DIR, "test_puuk.db"))
# Детерминированный пароль админа в изолированной тестовой БД (тесты логинятся как admin/admin)
os.environ.setdefault("PUUK_ADMIN_PASSWORD", "admin")
# Тесты не должны писать в рабочий Qdrant (он доступен с машины разработчика).
# Интеграционные точки доставки очереди отключены; тесты сервиса инжектят fake-клиент.
os.environ.setdefault("EMBEDDING_QUEUE_ENABLED", "false")
os.environ.setdefault("EMBEDDING_RECONCILE_ENABLED", "false")
# Периодическая доставка loudness из Qdrant тоже не должна стартовать в тестах.
os.environ.setdefault("LOUDNESS_SYNC_ENABLED", "false")

if 'config' in sys.modules:
    print("!!! CONFIG ALREADY LOADED at test_db_path import:", file=sys.stderr)
    import traceback
    for fr in traceback.extract_stack():
        if fr.filename.startswith('<frozen'):
            continue
        print(f"  {fr.filename}:{fr.lineno} in {fr.name}", file=sys.stderr)
