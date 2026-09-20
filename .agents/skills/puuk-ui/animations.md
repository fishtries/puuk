# Animations — Framer Motion + CSS

Правила Emil Kowalski (из improve-animations/AUDIT.md, заархивирован в
`.agents/skills-archive/`), адаптированные под стек Puuk. Кривые и durations
уже есть в `styles/variables.css` — используем их.

## Зачем анимировать

Только 5 причин: пространственная связь, индикация состояния, фидбек,
объяснение, предотвращение резкой смены. «Красиво» — не причина.

| Частота | Решение |
|---|---|
| 100+ раз/день (хоткеи, переключение вида) | Без анимации. Всегда. |
| Десятки раз/день (hover, навигация по списку) | Убрать или сократить до минимума |
| Иногда (модалки, drawer, тосты) | Стандартная анимация |
| Редко (onboarding, celebration) | Можно delight |

## Easing и duration — порядок решений

- Вход/выход → `--ease-out` (стартует быстро — ощущается отзывчивым)
- Движение/морфинг на экране → `--ease-in-out`
- Hover/цвет → `ease`
- Постоянное движение (прогресс, marquee) → `linear`
- `ease-in` на UI — всегда ошибка: медленный старт задерживает момент, на который смотрит пользователь.

Бюджеты: press 100–160ms · tooltip/popover 125–200ms · dropdown 150–250ms · модалки/drawer 200–500ms (`--duration-modal` = 420ms).

## Framer Motion паттерн модалки (эталон: FullPlayerModal.tsx)

```tsx
<AnimatePresence>
  {isFullscreen && (
    <motion.div
      className={styles.overlay}
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.98 }}
      ...
```

Ключевое:
- **Никогда `scale(0)`** — из ничего вещи не появляются. Диапазон `0.9–0.97` + `opacity: 0`.
- Модалки центрированы — `transform-origin: center` здесь корректен.
  Поповеры/дропдауны/тултипы масштабируются **от триггера**, не от центра.
- Разворот плеера — пружина: `{ type: "spring", duration: 0.5, bounce: 0.2 }`.
  Bounce 0.1–0.3; видимый отскок — только drag-to-dismiss и playful-моменты.

## Interruptibility

- Быстро повторяемые и прерываемые анимации (тосты, toggles, drag, expand/collapse)
  — **только transitions или springs**, никаких `@keyframes` (они перезапускаются с нуля).
- Drag-to-dismiss по скорости, не по дистанции: dismiss при
  `Math.abs(distance) / elapsedMs > ~0.11`.
- Асимметрия: сознательные фазы (press-and-hold, destructive confirm) медленные,
  ответ системы — мгновенный.

## Performance

- Анимируются **только** `transform` и `opacity`.
- Шортанды Framer Motion `x`/`y`/`scale` НЕ аппаратно-ускорены — на перегруженных
  экранах пиши полную строку: `animate={{ transform: "translateX(100px)" }}`.
- Transition-time `filter: blur()` ≤ 20px (особенно Safari; у нас blur 28px — только
  на статичном backdrop, не в transition).
- CSS/WAAPI бьют rAF-циклы на предсказуемом движении; springs — для жестов.

## Accessibility

```css
@media (prefers-reduced-motion: reduce) {
  .element { animation: fade 0.2s ease; } /* opacity/цвет остаются, движение — нет */
}
```

В JS: `useReducedMotion()` из Framer Motion, ветвление transform-значений.
Reduced motion ≠ ноль анимаций — убираем перемещения, оставляем фидбек.

## Cohesion

- 30–80ms stagger для групповых входов; stagger не блокирует взаимодействие.
- Резкий crossfade с двойной экспозицией маскируется `filter: blur(2px)` на время перехода.
- Личности продукта: puuk — «premium dark player», пружины сдержанные, без детской прыгучести.

## Чеклист ревью анимации

1. Есть ли причина из пяти? 2. Нет `ease-in`/`scale(0)`/`transition: all`?
3. < 300ms (или модалка ≤ 500ms)? 4. Прерывается корректно (transition/spring)?
5. Origin от триггера (для не-модалок)? 6. reduced-motion обработан?
7. Значения из токенов, не магические?
