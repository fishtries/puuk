---
name: puuk-ux-lite
description: "Scoped UI/UX search for the Puuk music player (React 19 + CSS Modules + Framer Motion). BM25 search over curated local data: 13 styles, media palettes, music typography, UX guidelines, motion presets, React/web best practices. Use for targeted questions about styles, colors, UX outcomes, animations, or React/web implementation details."
---

# puuk-ux-lite

Локальный поиск UI/UX-паттернов, скоупленный под музыкальный плеер Puuk.
Это урезанный форк `ui-ux-pro-max`: движок тот же (BM25), датасет отфильтрован
до media/entertainment-профиля.

## Когда использовать

| Задача | Пример запроса | Домен |
|---|---|---|
| Выбор стиля компонента | "glassmorphism capsule", "dark mode OLED" | `style` |
| Палитра под фичу | "music streaming palette", "dark accent colors" | `color` |
| Конкретный UX-исход | "focus not obscured", "drag reorder list" | `ux` |
| Типографика | "cinema dark display font" | `typography` |
| Анимация | "stagger reveal", "skeleton loader", "parallax" | `gsap` (концепты переносимы на Framer Motion) |
| React-производительность | "list rerender", "memoization", "bundle size" | `react` / `--stack react` |
| Формы и веб-паттерны | "autocomplete input", "virtualize long list" | `web` |

## Как искать

```bash
python3 .agents/skills/puuk-ux-lite/scripts/search.py "<query>" [--domain <domain>]
python3 .agents/skills/puuk-ux-lite/scripts/search.py "<query>" --stack react
```

Правила запросов:

1. **Один доминирующий интент**, 2–5 значимых слов + один контекст
   (платформа, компонент, взаимодействие). Не смешивать чеклисты.
2. Для a11y ищи **семантический исход** первым: `"error summary validation" --domain ux`,
   `"focus not obscured" --domain ux`, `"dragging movements" --domain ux`.
3. Пустой результат — **повтори раз** с более узкой формулировкой или явным
   `--domain`. Если снова пусто — так и скажи: «в базе совпадений нет» —
   и используй общие знания, помечая их как общие. Не выдавай домыслы за данные.

## Контекст проекта Puuk (учитывай при интерпретации результатов)

- **Стек:** Vite + React 19 + TypeScript strict, Framer Motion, Zustand, TanStack Query.
- **Стили:** CSS Modules + CSS Variables. Tailwind/shadcn НЕ используются —
  примеры кода из датасета с Tailwind-классами читай как семантику, не как
  готовый код.
- **Иконки:** lucide-react (иконочный домен удален — см. docs lucide).
- **Дизайн-система уже зафиксирована** в `app/web/src/styles/variables.css`
  (палитра, радиусы, easing-кривые Emil Kowalski, durations). Не предлагай
  альтернативные дизайн-системы — ищи точечные ответы.

## Что удалено относительно ui-ux-pro-max и где брать взамен

| Удалено | Замена |
|---|---|
| `google-fonts.csv` (747 KB) | `--domain typography` (7 подобранных пар) + fonts.google.com |
| `icons.csv` + phosphor json | документация lucide-react (уже в зависимостях) |
| `charts.csv`, `landing.csv` | не применимы к плееру (нет лендингов/дашбордов) |
| Стеки кроме react | проект моно-стековый |
| `--design-system` режим + dials | токены уже есть в `variables.css` |

Оригинал лежит в `.agents/skills-archive/` (см. ui-ux-pro-max) — при необходимости
скопируй оттуда недостающий CSV и верни домен в `CSV_CONFIG` в `scripts/core.py`.
