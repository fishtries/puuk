# Навыки для разработки Puuk

Активных skills — 5, подобраны под профиль проекта: персональный музыкальный плеер (FastAPI + Qdrant / aiogram / React Native Expo).

---

## Проектные навыки

### puuk-ui (iOS только)
Стилизация, анимации (Reanimated), компоненты React Native, специфика iOS-клиента.
Начни с `SKILL.md` (роутер), дальше по файлам:
- `styling.md` — стили, цвета, типографика
- `animations.md` — Reanimated, springs, reduced motion
- `components.md` — React Native + Expo паттерны
- `theming.md` — динамическая тема под обложку

### puuk-ux-lite
Локальный BM25-поиск по скоупленному датасету (13 стилей, media-палитры, музыкальная типографика, UX правила).

```bash
python3 .agents/skills/puuk-ux-lite/scripts/search.py "твой запрос" [--domain ...]
```

---

## Книжные навыки

Загружать явно при необходимости. Структура: `SKILL.md` → `{name}.mini.md` (рабочая версия) → `{name}.md` (полная) → `{name}.nano.md` (шпаргалка).

### release-it
**Когда:** SFTP-интеграция heavy_worker, стриминг, фоновые задачи, retry-логика, Qdrant-интеграция.
**Не для:** обычных CRUD-операций и локальных изменений.

### refactoring
**Когда:** изменение структуры кода с сохранением поведения, подготовка к новой функции через перестройку существующего кода.
**Не для:** новых функций (это не рефакторинг) и косметических правок стиля.

### a-philosophy-of-software-design
**Когда:** проектирование публичного API модуля, декомпозиция крупного компонента, выбор абстракции при росте сложности.
**Не для:** локальных правок, переименований, обычной реализации функций.

---

## Применение по компонентам проекта

### `brain/` (FastAPI + SQLite + Qdrant)
| Задача | Skill |
|---|---|
| Роуты, сервисы, репозитории | Общие знания модели, локальный стиль кода |
| SFTP, стриминг, фоновые задачи, retry | `release-it` |
| Рост сложности wave/search-логики, новые API | `a-philosophy-of-software-design` |
| Переработка существующего модуля | `refactoring` |

### `tg_music_bot/` (aiogram)
Только официальная документация aiogram — специфика фреймворка важнее абстрактных паттернов.

### `app/ios/puuk-ios/` (Expo SDK 57)
| Задача | Skill |
|---|---|
| Компоненты, стили, анимации | `puuk-ui` |
| «Как правильно сделать X в UI?» | `puuk-ux-lite` (поиск) |
| Улучшение существующего компонента | `refactoring` |

---

## Архив

`.agents/skills-archive/` — 15 законсервированных навыков:

**Книжные (общие):**
- `clean-code`, `code-complete`, `clean-architecture`, `the-pragmatic-programmer`, `refactoring-guru`

**Enterprise-паттерны:**
- `domain-driven-design`, `implementing-domain-driven-design`, `domain-driven-design-distilled`, `patterns-of-enterprise-application-architecture`, `designing-data-intensive-applications`

**Дизайн-агентство:**
- `design/`, `banner-design/`, `slides/`, `brand/`

**UI-аудиты:**
- `better-interface`, `working-effectively-with-legacy-code`

**UI-исходники:**
- `ui-ux-pro-max`, `ui-styling`, `design-system`, `anti-ui-slop`, `improve-animations`

Вернуть skill — просто скопировать папку обратно в `.agents/skills/`. См. README в архиве.

---

## Когда skills НЕ нужны

- Специфика фреймворков (FastAPI decorators, aiogram filters, Expo API) — официальная документация.
- Простые задачи и копирование существующих паттернов проекта — следуй локальному стилю.
- Инфраструктура (SSH, rsync, systemd) и алгоритмы Qdrant — domain-specific знания.
