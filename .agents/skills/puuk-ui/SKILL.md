---
name: puuk-ui
description: "UI skill for the Puuk music player web client: CSS Modules styling, Framer Motion animations, React 19 + Zustand patterns, dynamic theming under track cover. Consolidates styling, animation, component and theming rules grounded in the actual codebase. Use when building or styling player components, animating UI, or working with the accent-color theme engine."
---

# puuk-ui

UI-навык для веб-клиента Puuk (`app/web`). Консолидирует правила стилизации,
анимаций, компонентов и темизации из реального кода проекта.

**Стек:** Vite + React 19 + TS strict, CSS Modules, Framer Motion, Zustand, TanStack Query, lucide-react.

**Архитектурный закон** (docs/WEB_CLIENT_ARCH.md): UI никогда не трогает
HTMLAudioElement/AudioContext напрямую — только через `AudioEngine` / Zustand.

## Роутинг

| Задача | Читать |
|---|---|
| Новый компонент, стили, glassmorphism, токены | [styling.md](styling.md) |
| Анимации, springs, жесты, reduced motion | [animations.md](animations.md) |
| Структура компонента, хуки, Zustand, Query | [components.md](components.md) |
| Динамический `--accent-color` под обложку | [theming.md](theming.md) |

## Пять принципов (выжимка anti-ui-slop)

1. **Authored, not generated.** Каждый компонент отвечает на вопрос «что здесь
   идея?». Никаких card-in-card, pill-ов без функции, декоративных градиентов.
2. **Иерархия через типографику и вес, не через рамки.** Не всё одинаково важно —
   и не должно выглядеть одинаково.
3. **Движение имеет цель** (пространство, состояние, фидбек) — «красиво» не цель.
   На элементах, нажимаемых 100+ раз в день, анимации нет вообще.
4. **Dark mode нативный.** Поверх `#08090d` обложкам нужен `--image-outline`,
   иначе они «протекают» в темноту.
5. **Restraint.** Если элемент только украшает — убрать. Если решение принято
   только потому что «красиво» — пересмотреть.

## Быстрые правила

- Токены из `styles/variables.css` — никаких magic numbers цветов/длительностей/радиусов.
- Easing: вход/выход `--ease-out`, движение на экране `--ease-in-out`,
  press `--duration-press`, модалки `--duration-modal` (420ms max).
- Держи UI-анимации < 300ms; press feedback `scale(0.97)`.
- `prefers-reduced-motion` обязателен для любого движения.
- Анимируются только `transform`/`opacity`; никакого `transition: all`.
