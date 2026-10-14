# iOS Client — Agent Instructions

React Native (Expo SDK 57). Читай версионную документацию при изменении Expo API, native-конфигурации или зависимостей: https://docs.expo.dev/versions/v57.0.0/

Дизайн: [общие решения](../../../docs/design/DESIGN.md) и [реализация iOS](../../../docs/design/ios.md). Для визуальных изменений использовать `puuk-ui`.

## Проверки

```bash
cd app/ios/puuk-ios/
npm run test        # Jest тесты (15 тестов: utils, lyrics, cover utils)
npx eslint .        # статический анализ
expo export         # проверка сборки bundle (должен быть ~3.8MB)
```

CI собирает unsigned IPA через GitHub Actions (`.github/workflows/build-ios-unsigned.yml`).

## Структура

- **`App.js`** — composition root, navigation setup
- **`navigation/`** — RootNavigator, MainTabs
- **`components/`** — UI компоненты
- **`fullplayer/`** — компоненты полноэкранного плеера
- **`lyrics/`** — LRC-тексты (AppleLyricsView, AnimatedLyricLine)
- **`hooks/`** — usePlayerController (управление плеером)
- **`utils/`** — lrcParser, coverImageUtils
- **`styles/`** — общие стили
- **`__tests__/`** — Jest тесты

## Ключевые правила

- Expo SDK 57 (`package.json`). При изменении native-зависимостей проверяй совместимость с SDK.
- `scripts/patch-expo-audio.js` (postinstall) — патч для Expo Audio. Не удалять без проверки.
- Фоновое воспроизведение и Lock Screen настроены через `expo-audio` + `setActiveForLockScreen`.
- Авторизация: SecureStore для токенов, мгновенное восстановление из локального кэша.
- Media-tickets для обложек в Lock Screen (параметр `?token=` в URL).
