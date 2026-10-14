# Навыки для разработки Puuk

Активных skills — 5, подобраны под профиль проекта: персональный музыкальный плеер (FastAPI + Qdrant / aiogram / React / React Native Expo).

---

## Проектные навыки

### puuk-ui (веб и iOS)
Короткий навигатор к [общему дизайн-документу](../../docs/design/DESIGN.md) и справочникам платформ. Использовать для оформления, компоновки плеера, жестов, анимаций и темы под обложку. Читать только разделы, относящиеся к задаче.

### puux-ux
Общие принципы сценариев, обратной связи, состояний, доступности и непрерывности взаимодействия для веба и iOS. Использовать при проектировании или разборе поведения интерфейса; для обычной реализации принятого сценария не требуется.

Принятые решения — `docs/design/DESIGN.md`; способы реализации — справочник целевой платформы. Прежний BM25-справочник сохранён в `.agents/skills-archive/ux-source/puuk-ux-lite/`.

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
| Сценарии, обратная связь, состояния и доступность | `puux-ux` |
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
