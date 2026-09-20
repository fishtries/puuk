# Навыки для разработки Puuk

Индекс помогает выбрать правильный навык. Активных навыков — 10, все
подобраны под профиль проекта: персональный музыкальный плеер
(FastAPI + Qdrant / aiogram / React 19 SPA).

---

## UI/UX — веб-клиент `app/web`

### Основной навык
**`puuk-ui/`** — стилизация, анимации, компоненты, темизация.
Начни с `SKILL.md` (роутер), дальше по файлам:
- `styling.md` — CSS Modules, токены, glassmorphism
- `animations.md` — Framer Motion, кривые Emil Kowalski, reduced motion
- `components.md` — React 19 + Zustand + TanStack Query паттерны
- `theming.md` — динамический `--accent-color` под обложку

### Поиск паттернов
**`puuk-ux-lite/`** — локальный BM25-поиск по скоупленному датасету
(13 стилей, media-палитры, музыкальная типографика, UX/react/web правила).

```bash
python3 .agents/skills/puuk-ux-lite/scripts/search.py "твой запрос" [--domain ...]
```

---

## Архитектура и качество кода

### Повседневная разработка
- **`clean-code/`** — читаемость, именование, функции, ошибки, тесты

### Архитектурные решения
- **`clean-architecture/`** — границы слоев, направление зависимостей
  (AudioEngine без React; FastAPI без бизнес-логики)
- **`a-philosophy-of-software-design/`** — сложность, глубина модулей, сокрытие информации

### Рефакторинг
- **`refactoring/`** — безопасное поведение-сохраняющее улучшение
- **`refactoring-guru/`** — каталог code smells и техник рефакторинга

### Специализированные
- **`code-complete/`** — качество конструкции: routines, переменные, защитное программирование
- **`release-it/`** — production-надежность: таймауты, ретраи, circuit breakers
- **`the-pragmatic-programmer/`** — DRY, ортогональность, автоматизация

Структура книжных навыков: `SKILL.md` → `{name}.mini.md` (рабочая версия)
→ `{name}.md` (полная, если mini не хватает) → `{name}.nano.md` (шпаргалка).

---

## Применение по компонентам проекта

### `app/web/` (React SPA)
| Задача | Навык |
|---|---|
| Новый компонент / стили / анимации / тема | `puuk-ui` |
| «Как правильно сделать X в UI?» | `puuk-ux-lite` (поиск) |
| Читаемость TS/React-кода | `clean-code.mini.md` |
| Вынос логики из UI в engine/store | `clean-architecture.mini.md` |
| Улучшение существующего компонента | `refactoring.mini.md` |

### `brain/` (FastAPI + SQLite + Qdrant)
| Задача | Навык |
|---|---|
| Роуты, сервисы, db.py | `clean-code` + `clean-architecture` |
| Стриминг, сканер, фоновые задачи | `release-it` (таймауты, отказы) |
| Рост сложности search/wave-логики | `a-philosophy-of-software-design` |
| Переработка сканера/тегов | `refactoring` + `code-complete` |

### `tg_music_bot/` (aiogram)
- Только `clean-code` — специфика aiogram важнее абстрактных паттернов.

---

## Архив

`.agents/skills-archive/` — 16 законсервированных навыков (см. README там):
enterprise-паттерны (DDD, PoEAA, DDIA), дизайн-агентство (logo/CIP/баннеры/слайды/бренд),
тяжелые аудит-инструменты (better-interface, legacy-code), полные
UI-исходники (ui-ux-pro-max 3.7 MB, ui-styling, design-system, anti-ui-slop,
improve-animations). Не загружаются автоматически; вернуть — просто скопировать
папку обратно в `.agents/skills/`.

---

## Когда навыки НЕ нужны

- Специфика фреймворков (декораторы FastAPI, фильтры aiogram) — официальная документация.
- Простые CRUD-операции и копирование существующих паттернов проекта — просто следуй стилю.
- Инфраструктура (Docker, Nginx) и алгоритмы Qdrant — domain-specific знания.
