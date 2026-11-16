# Puuk: J1 — Аудит провайдера Yandex Cloud CDN и текущей инфраструктуры (Исправленная редакция)

**Дата:** 2026-11-16  
**Задача:** J1 (provider / infrastructure read-only audit)  
**Исполнитель:** Native Antigravity (`antigravity-manager/gemini-3.8-flash`)  
*(Примечание по окружению: первоначальный запуск через launcher OpenCode завершился с ошибкой ECONNREFUSED при попытке обращения к фоновому процессу; координатор и пользователь скорректировали среду на нативный Antigravity с моделью Gemini 3.8 Flash, подтвердив соответствие модели).*  
**Базовая ревизия:** `89ebc1c30b36837e584fbe72d51cdb0aed6303be` + инвентарь `docs/cdn/BASELINE_MANIFEST.json`  
**Статус:** Read-only аудит завершён; настройки провайдера и исходный код не изменялись, секреты не исследовались и не раскрываются.

---

## 1. Первичные авторитетные источники

Все спецификации, формулы и параметры проверены по официальной документации Yandex Cloud CDN:

1. **Защищенные токены (концепции):**  
   `https://yandex.cloud/ru/docs/cdn/concepts/secure-tokens`  
   (Markdown: `https://docs.yandex.cloud/ru/ru/cdn/concepts/secure-tokens.md`)
2. **Включение доступа по защищенному токену:**  
   `https://yandex.cloud/ru/docs/cdn/operations/resources/enable-secure-token`  
   (Markdown: `https://docs.yandex.cloud/ru/ru/cdn/operations/resources/enable-secure-token.md`)
3. **Кеширование контента (концепции):**  
   `https://yandex.cloud/ru/docs/cdn/concepts/caching`  
   (Markdown: `https://docs.yandex.cloud/ru/ru/cdn/concepts/caching.md`)
4. **Настройка кеширования ресурса:**  
   `https://yandex.cloud/ru/docs/cdn/operations/resources/configure-caching`  
   (Markdown: `https://docs.yandex.cloud/ru/ru/cdn/operations/resources/configure-caching.md`)
5. **Настройка SNI (пользовательского имени сервера):**  
   `https://yandex.cloud/ru/docs/cdn/operations/resources/configure-server-name`  
   (Markdown: `https://docs.yandex.cloud/ru/ru/cdn/operations/resources/configure-server-name.md`)
6. **Сегментация контента (slicing):**  
   `https://yandex.cloud/ru/docs/cdn/concepts/slicing`  
   (Markdown: `https://docs.yandex.cloud/ru/ru/cdn/operations/resources/enable-segmentation.md`)
7. **Кросс-доменные запросы CORS:**  
   `https://yandex.cloud/ru/docs/cdn/concepts/cors`  
   (Markdown: `https://docs.yandex.cloud/ru/ru/cdn/operations/resources/configure-cors.md`)
8. **Очистка кеша и квоты/лимиты:**  
   `https://yandex.cloud/ru/docs/cdn/concepts/limits`  
   (Markdown: `https://docs.yandex.cloud/ru/ru/cdn/operations/resources/purge-cache.md`, API: `https://docs.yandex.cloud/ru/ru/cdn/api-ref/Cache/purge.md`)
9. **Настройка HTTP-заголовков к источнику и клиенту:**  
   `https://yandex.cloud/ru/docs/cdn/operations/resources/configure-headers`  
   (Markdown: `https://docs.yandex.cloud/ru/ru/cdn/api-ref/Resource/update.md`)
10. **Локационные правила (Resource Rules):**  
    `https://yandex.cloud/ru/docs/cdn/concepts/location-rules`  
    (Markdown: `https://docs.yandex.cloud/ru/ru/cdn/api-ref/ResourceRules/index.md`)

---

## 2. Сводная таблица требований и поддержки провайдером

| # | Требование / Механизм | Поддержка Yandex Cloud CDN | Источник / Доказательство | Ограничения, риски и статус проверки |
|---|---|---|---|---|
| 1 | **Формула подписи (без IP)** | **Поддерживается штатно** | Документация `concepts/secure-tokens.md`; независимый синтетический тест OpenSSL/Python | Строка: `f"{expires}{path} {secret}"` (пробел перед секретом обязателен). Хеш MD5 (raw digest) -> URL-safe Base64 (замена `+` на `-`, `/` на `_`, удаление `=`). Query строго `md5` и `expires`. |
| 2 | **Формула подписи (с IP)** | **Поддерживается штатно** | Документация `concepts/secure-tokens.md` | Строка: `f"{expires}{path}{ip} {secret}"`. Для Puuk не используется из-за мобильных клиентов. |
| 3 | **Область действия (Scope)** | **Per-object scope (строго один URI-путь)** | Документация `concepts/secure-tokens.md` | Точный путь URI `$path` входит в MD5-хеш. Подпись для одного файла не подходит к другому. Подпись каталогов/wildcard (`*`) **не поддерживается**. |
| 4 | **Срок действия (Expiry)** | **Поддерживается штатно** | Документация `concepts/secure-tokens.md` | Целое число секунд Unix epoch. Провайдер гарантирует завершение передачи, начатой до наступления expiry. |
| 5 | **Проверка подписи ДО выдачи из кеша (Warm-Cache Auth)** | **Заявлено в концепциях провайдера; на практике — НЕ ПОДТВЕРЖДЕНО** | Документация `concepts/secure-tokens.md` | **Статус: Не подтверждено на live.** В текущей конфигурации Puuk `secure_key` и кеш не включены. Проверка отклонения невалидных/истёкших ссылок на прогретом кеше остаётся экспериментом этапа G3/S5. |
| 6 | **Исключение query из Cache Key (`queryParamsOptions`)** | **Поддерживается штатно** | Документация `configure-caching.md`, REST API `queryParamsOptions` | Режимы `ignoreQueryString`, `queryParamsWhitelist`, `queryParamsBlacklist`. Для общего кеша параметры `md5` и `expires` необходимо исключить из ключа (`queryParamsBlacklist`), сохранив их проверку edge-модулем токенов. Поведение edge требует верификации в S5. |
| 7 | **Сегментация больших файлов (`slice`)** | **Поддерживается штатно** | Документация `concepts/slicing.md`, `enable-segmentation.md` | Работает **только для файлов от 10 МБ**. Параллельные GET-запросы с `Range` к источнику блоками до 10 МБ. Источник обязан отдавать стабильные `ETag` и `Content-Length`. |
| 8 | **Range-запросы клиентов (RFC 7233)** | **Поддерживается на статическом фикстуре (709B)** | Bounded probe: `curl -sS -i -r 0-10 https://media.puuk.fun/` -> `HTTP 206`, `Content-Range: bytes 0-10/709` | **Ограничение проверки:** тест проведён только на тестовом фикстуре `index.html` (709 байт). Поведение на реальных аудиопотоках (сотни мегабайт, seek, 206/416) ещё не доказано и требует проверки на G2/G3. |
| 9 | **HEAD-запросы клиентов** | **Требует явной реализации на Origin** | Bounded probe: `curl -sS -i -I https://media.puuk.fun/api/stream/1` -> `HTTP 405 Method Not Allowed`, `allow: GET` | FastAPI по умолчанию не генерирует HEAD-хэндлер для GET-маршрутов. Маршрут доставки аудио на origin обязан поддерживать методы `GET` и `HEAD`. |
| 10 | **CORS и предварительные запросы OPTIONS** | **Ограниченная встроенная поддержка в CDN** | Документация `concepts/cors.md`; safe probe OPTIONS вернул заголовки от origin | Опция `options.cors` CDN управляет **только** `Access-Control-Allow-Origin`. CDN **не генерирует** ответы на OPTIONS. Origin обязан сам обрабатывать preflight OPTIONS и отдавать все CORS-заголовки. |
| 11 | **Лимиты и поведение очистки кеша (Purge)** | **Жёсткие технические лимиты провайдера** | Документация `concepts/limits.md`, API `Cache.Purge` | Лимит: **не более 1 запроса на очистку в минуту**; не более 10 путей в запросе. Возвращает LRO `Operation` (очистка занимает **до 15 минут**). Для сегментированных файлов требуется путь с суффиксом `*`. Синхронный purge в backend недопустим. |
| 12 | **Секретный заголовок к источнику (`staticRequestHeaders`)** | **Поддерживается конфигурацией; перезапись клиентского заголовка — НЕ ПОДТВЕРЖДЕНА** | Документация `configure-headers.md`, API `options.staticRequestHeaders` | CDN умеет инжектировать статический заголовок в запрос к источнику. Перезапись одноимённого заголовка клиента остаётся недоказанным предположением до экспериментов этапа G3/S5. |
| 13 | **Кастомный SNI (`customServerName`) и Host источника** | **Поддерживается штатно** | Документация `configure-server-name.md`, API `options.customServerName`, `hostOptions` | Позволяет задать TLS SNI при обращении CDN к HTTPS-источнику и переопределить HTTP-заголовок `Host` к источнику. |
| 14 | **Ограничение маршрутов медиадомена на CDN** | **В базовом ресурсе отсутствует (всё проксируется); доступны `ResourceRules`** | Safe probes: все маршруты SPA/API/Auth сейчас доступны через `media.puuk.fun` | В базовом CDN-ресурсе Yandex нет встроенного запрещающего файрвола. Локационные правила (`ResourceRules`) позволяют задавать regex (`^/cdn/audio/.*`), но надёжная изоляция требует выделенного origin virtual host. |

---

## 3. Статус текущих параметров CDN (Разделение доказанного и недоказанного)

В плане оркестрации (`docs/CDN_AND_SHARE_LINKS_ORCHESTRATION_PLAN.md`, раздел 3) зафиксирован исторический контекст:
> «В панели CDN: сертификат выпущен и подключён, HTTPS redirect включён, кеш CDN/браузера выключен, secure token выключен, cookies не игнорируются.»

**Статус аудита J1:**
- Данные значения являются **историческим контекстом плана и не подтверждены в рамках данной сессии через консоль управления или authenticated API** (утилита `yc` и сохранённые сервисные ключи в рабочем окружении отсутствуют).
- В отчёте эти параметры фиксируются как **неподтверждённые в live-режиме**.
- Актуальные параметры ресурса должны быть формально выгружены и задокументированы старшим инженером инфраструктуры (S5) перед внесением изменений.

---

## 4. Каноническая формула подписи и воспроизводимый синтетический тест

### 4.1. Спецификация алгоритма Yandex Cloud CDN

- **Входные данные:**
  - `expires`: Unix-время истечения (целое число секунд).
  - `path`: абсолютный путь к файлу на источнике, начиная с `/` (например, `/cdn/audio/00000000-0000-0000-0000-000000000001/v1`).
  - `secret`: секретный ключ ресурса (строка от 6 до 32 символов).
- **Каноническая строка:**
  ```text
  "{expires}{path} {secret}"
  ```
  *(Строго один пробел перед секретом; другие query-параметры не хешируются).*
- **Вычисление хеша и токена:**
  1. Бинарный дайджест MD5 от UTF-8 строки.
  2. Base64 кодирование бинарного дайджеста.
  3. URL-safe преобразование: замена `+` на `-`, `/` на `_`, удаление концевых знаков `=` и символов перевода строки `\n`.
  4. Формирование query: `?md5={token}&expires={expires}`.

### 4.2. Воспроизводимый синтетический тестовый вектор

Для независимой проверки алгоритма зафиксирован детерминированный синтетический тестовый вектор с известными входными данными:

- **Синтетические входные параметры:**
  - `HOSTNAME`: `https://media.puuk.fun`
  - `FILEPATH`: `/cdn/audio/00000000-0000-0000-0000-000000000001/v1`
  - `EXPIRES`: `1763251200`
  - `SECRET`: `k7W9xP2mQ5vL8nJ1`
- **Каноническая строка для хеширования:**
  ```text
  1763251200/cdn/audio/00000000-0000-0000-0000-000000000001/v1 k7W9xP2mQ5vL8nJ1
  ```

#### Проверка через OpenSSL:
Команда в терминале:
```bash
echo -n '1763251200/cdn/audio/00000000-0000-0000-0000-000000000001/v1 k7W9xP2mQ5vL8nJ1' \
  | openssl md5 -binary | openssl base64 | tr +/ -_ | tr -d =
```
**Результат OpenSSL:**
```text
NcMUu1kyDzVaG8fx-u-7WQ
```

#### Проверка через Python:
```python
import base64
import hashlib

expires = 1763251200
filepath = "/cdn/audio/00000000-0000-0000-0000-000000000001/v1"
secret = "k7W9xP2mQ5vL8nJ1"
plaintext = f"{expires}{filepath} {secret}"

raw_md5 = hashlib.md5(plaintext.encode("utf-8")).digest()
token = base64.b64encode(raw_md5).decode("ascii").replace("+", "-").replace("/", "_").rstrip("=")
print("Token:", token)
```
**Результат Python:**
```text
NcMUu1kyDzVaG8fx-u-7WQ
```

**Итоговый URL:**
```text
https://media.puuk.fun/cdn/audio/00000000-0000-0000-0000-000000000001/v1?md5=NcMUu1kyDzVaG8fx-u-7WQ&expires=1763251200
```
Совпадение результатов OpenSSL и Python побайтовое и полностью воспроизводимое.

---

## 5. Доказательства безопасных сетевых проверок (Live Safe Probes)

Все сетевые проверки выполнялись строго в read-only режиме. Мутирующие POST-запросы с авторизационными данными **не отправлялись**.

### 5.1. DNS и TLS сертификат

- **DNS CNAME:**
  `media.puuk.fun` -> `a77ec7546eec5094.topology.gslb.yccdn.ru.` -> `188.72.112.1` (Yandex Cloud CDN Anycast Edge).
- **TLS:**
  Сертификат Let's Encrypt (CN: `media.puuk.fun`), действителен с `2026-11-15` по `2027-02-13`.

### 5.2. Аудит экспозиции API и Auth маршрутов через медиадомен

Для проверки того, какие пути проксируются через `media.puuk.fun`, были выполнены точные безопасные команды `curl`:

1. **Корень сайта (SPA):**
   ```bash
   curl -sS -i "https://media.puuk.fun/"
   ```
   *Результат:* `HTTP/2 200 OK`, `server: nginx`, `content-type: text/html`, `content-length: 709`, `cache-host: yccdn-m9-02`.  
   *Факт:* Медиадомен отдаёт клиентам интерфейс веб-приложения `web.puuk.fun`.

2. **API маршрут `/api/tracks`:**
   ```bash
   curl -sS -i "https://media.puuk.fun/api/tracks"
   ```
   *Результат:* `HTTP/2 401 Unauthorized`, `content-type: application/json`, `www-authenticate: Bearer`, `cache-host: yccdn-m9-03`, тело: `{"detail":"Требуется авторизация"}`.  
   *Факт:* Запрос к API через медиадомен доходит до origin FastAPI backend и возвращает стандартную ошибку авторизации.

3. **API маршрут стриминга `/api/stream/1` (GET):**
   ```bash
   curl -sS -i "https://media.puuk.fun/api/stream/1"
   ```
   *Результат:* `HTTP/2 401 Unauthorized`, `content-type: application/json`, `www-authenticate: Bearer`, `cache-host: yccdn-m9-01`, тело: `{"detail":"Требуется авторизация"}`.

4. **API маршрут стриминга `/api/stream/1` (HEAD):**
   ```bash
   curl -sS -i -I "https://media.puuk.fun/api/stream/1"
   ```
   *Результат:* `HTTP/2 405 Method Not Allowed`, `allow: GET`, `content-type: application/json`, `cache-host: yccdn-m9-14`.  
   *Факт:* Эндпоинт origin не поддерживает метод `HEAD`.

5. **Несуществующий API маршрут `/api/health`:**
   ```bash
   curl -sS -i "https://media.puuk.fun/api/health"
   ```
   *Результат:* `HTTP/2 404 Not Found`, `content-type: application/json`, `cache-host: yccdn-m9-16`, тело: `{"detail":"Not Found"}`.

6. **Несуществующий SPA маршрут `/nonexistent-route-audit`:**
   ```bash
   curl -sS -i "https://media.puuk.fun/nonexistent-route-audit"
   ```
   *Результат:* `HTTP/2 200 OK`, `content-type: text/html`, `content-length: 709` (SPA fallback origin Nginx).

*Важное замечание по безопасности:* Ранее отмеченные в сырых логах ответы `405` для POST не доказывают прохождение запроса в роутер FastAPI, так как HTTP-методы могут блокироваться на уровне Nginx или настроек CDN (`options.allowedHttpMethods`). Авторизационные POST-запросы в рамках read-only аудита **не отправлялись**, предположения о поведении внутренних POST-роутеров удалены.

### 5.3. Range-запросы на статическом фикстуре (709B)

1. **Запрос диапазона байт:**
   ```bash
   curl -sS -i -r 0-10 "https://media.puuk.fun/"
   ```
   *Результат:* `HTTP/2 206 Partial Content`, `content-range: bytes 0-10/709`, `content-length: 11`, `cache-host: yccdn-m9-18`.
2. **Запрос невыполнимого диапазона:**
   ```bash
   curl -sS -i -r 50000-60000 "https://media.puuk.fun/"
   ```
   *Результат:* `HTTP/2 416 Requested Range Not Satisfiable`, `content-range: bytes */709`.

**Ограничение доказательства:** Эксперимент доказывает, что CDN и origin корректно обрабатывают заголовки `Range` и возвращают `206` / `416` для статического текстового фикстура (709 байт). Он **не доказывает** корректность передачи аудиопотоков (многомегабайтные бинарные файлы, seek в плеере, параллельные сегменты slicing). Полноценная проверка стриминга должна проводиться на G2/G3 с реальными медиафайлами.

### 5.4. CORS Preflight (OPTIONS)

```bash
curl -sS -i -X OPTIONS \
  -H "Origin: https://web.puuk.fun" \
  -H "Access-Control-Request-Method: GET" \
  "https://media.puuk.fun/api/stream/1"
```
*Результат:* `HTTP/2 200 OK`, `access-control-allow-origin: https://web.puuk.fun`, `access-control-allow-credentials: true`, `access-control-allow-headers: Accept, ..., Range`.  
*Запрос с неразрешённым Origin (`https://evil.com`):* `HTTP/2 400 Bad Request`, тело: `Disallowed CORS origin`.  
*Вывод:* Ответ формируется `CORSMiddleware` origin-сервера. Встроенная настройка CORS CDN не обрабатывает preflight самостоятельно.

---

## 6. Архитектурные требования к изоляции Origin и аутентификации

### 6.1. Проблема недостаточной изоляции по заголовку Host

В текущей инфраструктуре CDN-ресурс обращается к источнику с IP `128.69.178.203`.
Если в настройках CDN-ресурса не включена прямая передача клиентского Host (`forwardHostHeader: false`) или задан `hostOptions.host: "web.puuk.fun"`, то запросы от CDN к серверу-источнику будут приходить с заголовком:
```text
Host: web.puuk.fun
```
В такой ситуации простая проверка `server_name media.puuk.fun` в Nginx на стороне сервера **не сработает**, так как Nginx увидит `Host: web.puuk.fun` и направит запрос в основной виртуальный хост веб-интерфейса и API.

### 6.2. Требуемая архитектура изоляции Origin (Рекомендация для S1 и S5)

Для надёжной изоляции медиа-трафика требуется многоуровневая защита:

```mermaid
flowchart TD
    Client["Клиент (Web / iOS)"] -->|HTTPS media.puuk.fun/cdn/audio/...| CDN["Yandex Cloud CDN Edge"]
    CDN -->|"HTTPS upstream\nSNI: origin-media.puuk.fun\nHost: origin-media.puuk.fun\nX-Puuk-Origin-Secret: <secret>"| Nginx["Origin Nginx (128.69.178.203)"]
    
    subgraph OriginServer["Сервер Puuk"]
        Nginx -->|"1. Dedicated Virtual Host\nserver_name origin-media.puuk.fun"| VHostCheck{"Совпадение VHost?"}
        VHostCheck -->|Нет / Чужой Host| Deny403["403 Forbidden (Catch-All)"]
        VHostCheck -->|Да| PathCheck{"Path == /cdn/audio/* ?"}
        PathCheck -->|Нет (/api/*, /, etc.)| Deny404["404 Not Found (Default Deny)"]
        PathCheck -->|Да| ProxyToApp["Proxy to FastAPI Unix Socket / 127.0.0.1:8000"]
        
        ProxyToApp --> BackendAuth{"FastAPI Delivery Route:\nhmac.compare_digest(\nheader_secret, config_secret)"}
        BackendAuth -->|Не совпадает / Пусто| Auth403["HTTP 403 Forbidden\n(Constant-Time)"]
        BackendAuth -->|Совпадает| StreamAudio["Отдача аудиофайла\n(FileResponse / Range / HEAD)"]
    end
```

1. **Выделенный Origin Virtual Host:**
   - Настроить отдельное доменное имя источника (например, `origin-media.puuk.fun`) либо настроить в CDN параметры:
     - `options.customServerName: "origin-media.puuk.fun"` (SNI)
     - `options.hostOptions.host: "origin-media.puuk.fun"` (HTTP Host к источнику)
   - В Nginx на сервере сконфигурировать отдельный `server` блок для `origin-media.puuk.fun`.
   - В этом блоке реализовать политику **Default Deny / Catch-All**:
     - Разрешён **только** префикс пути `/cdn/audio/` и служебный preflight `OPTIONS`.
     - Все остальные пути (`/api/*`, `/`, `/track/*`, `/admin/*`) должны безусловно возвращать `404 Not Found` или `403 Forbidden`.

2. **Авторитетная аутентификация в Backend (Constant-Time):**
   - **Запрещено полагаться на проверку секрета в Nginx через простое сравнение строк** (например, `if ($http_x_puuk_origin_secret != "...")`). Такое сравнение в Nginx уязвимо к timing-атакам и легко нарушается при изменениях конфигурации.
   - **Авторитетная проверка секрета возлагается строго на FastAPI backend** в модуле защищённой доставки аудио:
     ```python
     import hmac
     
     def verify_cdn_origin_secret(provided_secret: str, expected_secret: str) -> bool:
         if not provided_secret or not expected_secret:
             return False
         return hmac.compare_digest(provided_secret.encode("utf-8"), expected_secret.encode("utf-8"))
     ```
   - Запросы с отсутствующим или неверным секретом немедленно отклоняются с HTTP 403 Forbidden.

3. **Запрет доверия заголовкам Host / X-Forwarded-\*:**
   - Заголовки `Host`, `X-Forwarded-Host`, `X-Forwarded-For`, `X-Real-IP` никогда не должны наделять клиента правами доступа и не должны использоваться для принятия решений об авторизации.
   - Внутренний роут `/cdn/audio/...` проверяет только криптографически стойкий общий секрет `X-Puuk-Origin-Secret`.

---

## 7. Нерешённые вопросы и эксперименты этапа G3/S5

Ниже перечислены пункты, которые **не могут быть доказаны read-only аудитом** и выносятся в обязательную программу закрытого стенда G3/S5:

1. **Эксперимент 1: Валидация подписи на прогретом кеше (Warm-Cache Token Validation)**
   - *Цель:* Доказать, что запрос к закешированному файлу с неверной или истёкшей подписью отбрасывается edge-сервером CDN с кодом 403 и не отдаёт данные из кеша.
   - *Метод на S5:* Прогреть тестовый файл валидным токеном; повторить запрос с тем же URI, но поддельным параметром `md5` и истёкшим `expires`. Зафиксировать отсутствие запроса в access-логах origin.

2. **Эксперимент 2: Перезапись заголовка `staticRequestHeaders`**
   - *Цель:* Доказать, что если злоумышленник отправит со стороны клиента заголовок `X-Puuk-Origin-Secret: forged_value`, edge-узел Yandex CDN безусловно перезапишет его на сконфигурированный статический секрет или удалит.
   - *Метод на S5:* Отправить запрос с поддельным заголовком через CDN и зафиксировать в Nginx origin фактически полученное значение.

3. **Эксперимент 3: Взаимодействие `queryParamsBlacklist` и Secure Token**
   - *Цель:* Подтвердить, что исключение `md5` и `expires` из ключа кеша не препятствует их валидации модулем токенов CDN.
   - *Метод на S5:* Сгенерировать два валидных токена с разным `expires` для одного файла; убедиться, что второй запрос даёт Cache HIT, но третий запрос с невалидным токеном получает 403.
