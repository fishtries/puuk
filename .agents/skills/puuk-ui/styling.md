# Styling — CSS Modules + CSS Variables

Паттерны из боевого кода Puuk. Справочник токенов: `app/web/src/styles/variables.css`.

## Токены — единственный источник значений

Палитра поверхностей (`--bg-app` → `--bg-surface-active`), акцент
(`--accent-color/-hover/-active/-subtle/-glow`), текст (`--text-primary/-secondary/-muted/-disabled`),
границы (`--border-subtle/-medium/-focus`), радиусы (`--radius-xs`…`--radius-pill`),
durations (`--duration-instant`…`--duration-modal`), easing (`--ease-out/-in-out/-spring/-drawer`),
тени (`--shadow-sm/-md/-lg/-glow`).

Запрещено: hex-литералы в компонентах, `border-radius: 12px` вместо
`var(--radius-md)`, самописные cubic-bezier.

Концентрические радиусы: `R_внешний = R_внутренний + padding` (комментарий в variables.css).

## Glassmorphism — паттерн из FloatingPlayerDock.module.css

Эталон стеклянной капсулы:

```css
.glassCapsule {
  background: rgba(26, 28, 34, 0.65);
  backdrop-filter: blur(28px) saturate(190%);
  -webkit-backdrop-filter: blur(28px) saturate(190%);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-top: 1px solid rgba(255, 255, 255, 0.2); /* верхний световой кант */
  border-radius: var(--radius-pill);
  box-shadow:
    0 16px 40px rgba(0, 0, 0, 0.5),
    0 4px 12px rgba(0, 0, 0, 0.3),
    inset 0 1px 1px rgba(255, 255, 255, 0.14); /* inset-подсветка */
  transition:
    border-color 200ms ease,
    box-shadow 200ms ease,
    transform 200ms ease;
}
```

Суть: полупрозрачный фон + двойная рамка (темнее внизу, светлее сверху) +
inset-подсветка. Не «random glassmorphism» — это выверенный капсульный стиль
плеера, единый для всех floating-элементов.

## CSS Modules

- Один `.module.css` рядом с `.tsx`, импорт `import styles from './X.module.css'`.
- Имена классов camelCase.
- Композиция через несколько классов, не через вложенность >2 уровней.
- Медиа-модификаторы состояния — через `data-*` атрибуты или отдельный класс,
  не через `:global`.

## Обязательные паттерны dark mode

Обложки/изображения — outline от «протекания» в чёрный:

```css
.cover { box-shadow: var(--image-outline); outline-offset: var(--image-outline-offset); }
```

Мягкие fade-края списков (паттерн KaraokeLyrics):

```css
overflow-y: auto;
mask-image: linear-gradient(to bottom, transparent 0%, black 12%, black 88%, transparent 100%);
```

## Hover/press состояния

- Hover: лёгкое поднятие фона `rgba(255,255,255,0.04)` или усиление границы.
- Press: `transform: scale(0.97)` с `transition: transform var(--duration-press) var(--ease-out)`.
- Hover-движение только внутри `@media (hover: hover) and (pointer: fine)` — тач шлёт ложные hover.

## Anti-patterns

- Inline-стили для базовых компонентов (прощение — только динамические значения из theming.md).
- `!important`.
- `transition: all` — перечисляй свойства явно.
- Вендорные префиксы вручную, кроме `-webkit-backdrop-filter` и `-webkit-mask-image`.
- Дублирование почти одинаковых кривых/длительностей — возьми токен или добавь новый в variables.css.
