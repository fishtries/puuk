# Skills Archive

Законсервированные навыки. Не загружаются автоматически — при необходимости скопируйте обратно в `.agents/skills/`.

Дата архивации: 2026-09-18 (рефакторинг под профиль проекта Puuk).

## enterprise-patterns/

Корпоративные архитектурные паттерны. Puuk — персональный музыкальный плеер
(SQLite + Qdrant, монолитный FastAPI), enterprise-масштабирование не планируется.

- `domain-driven-design/` — DDD (Evans)
- `domain-driven-design-distilled/` — краткий DDD (Vernon)
- `implementing-domain-driven-design/` — практический DDD (Vernon)
- `patterns-of-enterprise-application-architecture/` — PoEAA (Fowler)
- `designing-data-intensive-applications/` — DDIA (Kleppmann)

Вернуть, если: появятся сложные доменные модели (лицензирование, каталогизация с правилами) или распределенное хранение.

## design-agency/

Инструменты дизайн-студии. Gemini API в проекте есть, но MVP сфокусирован на продукте.

- `design/` — агрегатор: logo (55 стилей), CIP (50 deliverables), иконки (SVG)
- `banner-design/` — баннеры для соцсетей/ads/print
- `slides/` — HTML-презентации с Chart.js
- `brand/` — брендинг, tone of voice

Вернуть, если: нужен логотип Puuk, питч-дек, промо-материалы для релиза.

## audit-tools/

- `better-interface/` — комплексный аудит интерфейса (1307 строк, 5 доменов).
  Избыточен для итеративной разработки MVP. Легкие аналоги включены в `puuk-ui/`.
- `working-effectively-with-legacy-code/` — работа с легаси. Кодовая база
  молодая, для безопасных улучшений достаточно `refactoring/`.

Вернуть, если: стабилизация v1 и большой аудит UI перед релизом; появление
запущенного легаси-модуля.

## ux-source/

- `ui-ux-pro-max/` — полный оригинал (3.7 MB dataset). Заменен на
  `puuk-ux-lite/` (176 KB). Если lite-версии не хватает данных — скопируй
  нужный CSV отсюда в `puuk-ux-lite/data/` и верни домен в `CSV_CONFIG`
  (`scripts/core.py`) и в `_DOMAIN_KEYWORDS`.

## ui-source-material/

Исходники, из которых собран навык `puuk-ui/`:

- `ui-styling/` — паттерны shadcn/Tailwind перенесены в puuk-ui только как
  семантика (в проекте CSS Modules); уникальные правила вошли в `styling.md`.
- `design-system/` — трехслойная архитектура токенов; для Puuk токены уже
  зафиксированы в `app/web/src/styles/variables.css`.
- `anti-ui-slop/` — 720 строк принципов, сжаты до «пяти принципов» в puuk-ui/SKILL.md.
- `improve-animations/` — AUDIT.md (8 категорий Emil Kowalski) и PLAN-TEMPLATE.md
  перенесены в puuk-ui/animations.md (без workflow-части про сабагентов).

Вернуть целиком, если: уйдешь от CSS Modules на Tailwind+shadcn (ui-styling),
захочешь формальных аудитов анимаций с планами для субагентов (improve-animations).

