# Components — React 19 + TypeScript + Zustand

Паттерны, извлечённые из существующих компонентов Puuk. Нарушение
архитектуры слоёв (WEB_CLIENT_ARCH.md) — блокер ревью.

## Порядок в компоненте

```tsx
import React, { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Play } from 'lucide-react';              // иконки — lucide-react
import { usePlayerStore } from '../../store/usePlayerStore';
import { getCoverUrl } from '../../api/tracks';
import styles from './FullPlayerModal.module.css';

export const FullPlayerModal: React.FC = () => {
  // 1. selectors Zustand — по одному значению за вызов
  // 2. TanStack Query / кастомные хуки (useLyrics)
  // 3. refs
  // 4. derived значения (const isPlaying = status === 'playing')
  // 5. effects
  // 6. handlers
  // 7. early returns / guards
  // 8. JSX
};
```

## Zustand — селекторы, не объекты

```tsx
// Хорошо: каждый селектор — примитив/стабильная ссылка
const currentTrack = usePlayerStore((s) => s.currentTrack);
const status = usePlayerStore((s) => s.status);

// Плохо: деструктуризация стейта — ререндер на каждое изменение
const { currentTrack, status } = usePlayerStore();
```

Сайд-эффекты аудио — только в store через события `audioEngine.on(...)`
(см. `usePlayerStore.ts`: `timeupdate`, `statuschange`, `ended`), никогда в компонентах.

## TanStack Query v5

- Серверные данные (треки, альбомы, плейлисты, поиск) — только через Query.
  Никаких `useEffect` + `fetch`.
- Ключи: `['tracks', id]`, `['wave-queue']`… Мутации с оптимистичным обновлением
  по образцу существующих (`toggleLikeTrack`).
- 401/CORS обрабатываются в `src/api/client.ts`, не в компонентах.

## Типы

- DTO строго типизированы в `src/types/` — никаких `any`, никаких локальных дублей интерфейсов.
- Маппинг серверных DTO → доменные типы — в `src/engine/` мапперах
  (пример: `mapWordLyricsPayloadDTO`), компоненты получают уже чистые данные.

## AudioEngine (слой 2, zero React)

- Класс `src/engine/AudioEngine.ts` — чистый TypeScript, без импортов React.
- UI вызывает методы движка только через actions store-а.
- Тайминги карaoke — от `timeupdate` движка, не от `setInterval` в компоненте.

## Хуки проекта

Перед созданием нового хука проверь `src/hooks/` (`useLyrics` и др.) —
вероятно, нужное уже есть.

## Правила

- Файл компонента — PascalCase, директория = имя компонента, внутри `.tsx` + `.module.css`.
- Условный рендеринг модалок — внутри `<AnimatePresence>`, exit-анимации обязательны.
- Никаких портов/DOM-манипуляций аудио: `document.querySelector('audio')` — запрещено.
- Списки: виртуализация длинных (библиотека/очередь) — критично для потока.
