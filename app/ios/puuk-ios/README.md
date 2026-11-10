# Puuk iOS

Нативный Expo SDK 58 клиент. Expo Web удалён; браузерный клиент находится в `app/web/`.

## Запуск на iOS

На Mac с Xcode, из этого каталога:

```sh
npm ci
npx pod-install
npx expo run:ios
```

После изменения нативных зависимостей нужна пересборка приложения. Перезапуск
Metro не добавляет отсутствующие ExpoAsset/ExpoConstants в установленный binary.
Podfile подключает Expo через `use_expo_modules!`; проверка обнаружения модулей:

```sh
npx expo-modules-autolinking resolve --platform ios
```

Если установлено приложение от другой версии SDK, пересоберите и установите его
из текущего проекта. Для запуска Metro отдельно используйте:

```sh
npx expo start --clear
```

Ошибка `main has not been registered` после ошибки ExpoAsset вторична: загрузка
JS прервалась до регистрации корневого компонента. Сначала восстановите нативные
модули. Не отключайте обязательные Expo-модули и не подменяйте их web-заглушками.
