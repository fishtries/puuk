# Orca Orchestration — как запускать дочерних агентов (puuk)

Практическая памятка для агентов-координаторов, которые запускают
воркеров через Orca. Документ дополняет официальный гайд
(`orca skills get orchestration`) — здесь только правила и грабли
конкретного окружения puuk.

---

## TL;DR

1. **Всегда `--agent opencode`.** `codex` на этой машине не установлен и
   не авторизован — воркеры с ним молча зависают.
2. **Не доверяй авто-инжекту промпта.** После `worker-start` через ~20-30 с
   проверь, что в TUI появился ход. Если нет — доставь спеку вручную
   через `orca terminal send --terminal <handle> --text "<spec>" --enter`.
3. Токен `--dispatch-capability` воркеру при ручной доставке не достаётся —
   его можно вытащить из `terminal-history` воркера (см. ниже) и закрыть
   диспатч самому.

---

## 1. Окружение

Внутри Orca-терминала безопасен обычный `orca` (в PATH есть cli-shim).
Вне Orca на Linux — только `orca-ide`, иначе запустится GNOME Orca
(экранный диктор). Перед командами полезно:

```bash
orca status --json
```

Версионный гайд:

```bash
orca skills get orchestration            # компактный кернел
orca skills get orchestration --full     # + все reference-файлы
orca skills get orchestration --reference references/recovery-and-cleanup.md
```

---

## 2. Канонический цикл

```bash
orca orchestration run-create --objective "<цель>" --json
orca orchestration worker-start --spec "<spec>" --worktree current --agent opencode --json
orca orchestration check --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json
# после принятого worker_done: reuse | worker-retain | worker-release
```

Spec задачи обязан содержать: **Target / Change / Constraints / Ownership /
Observable acceptance** — иначе воркер «жив», но результат не проверить.

### Правила ожидания

- `unverifiable` / timeout / пустой результат — это **checkpoint, а не провал**.
- Только позитивное доказательство (`exited` liveness, наблюдаемый exit,
  пустой финальный ход без `worker_done`) даёт право на stop/abandon/retry.
- После 3 пустых ожиданий подряд — не ждать вслепую, а идти по
  `worker-list --include-remote --json` и буквальному `projection.nextAction.argv`.
- Retry только доказанно упавшей попытки:
  `worker-start --task <id> --retry-of <dispatch_id> --worktree current --agent opencode`.

---

## 3. Грабли: агенты зависают в `turn_start_unobserved`

**Симптом:** `worker-start` вернул `ready`, эффект `dispatch_input: accepted`,
но в TUI агента пусто, курсор замер, сессия в провайдере не создаётся.

**Причина №1 — codex не установлен.** У `codex` нет бинарника в PATH
(ни bash, ни fish) и нет `auth.json`. Воркер стартовать не может.
Решение: **не использовать `--agent codex`**, а запускать `--agent opencode`
(или другой установленный агент). Проверка установленных агентов:
`fish -lc 'type -q opencode; and echo ok'`.

**Причина №2 — гонка инжекта промпта в TUI (opencode).** Orca запускает
TUI и отдельно вбивает в него промпт-прографию. Вставка уходит сразу после
команды запуска — **до** того, как TUI смонтирует поле ввода, и теряется.
В логе терминала это видно так: `opencode\r` и следующая за ней вставка
до появления `[?1049h` (alternate screen).

### Как проверить и обойти

```bash
orca orchestration worker-show --dispatch <dispatch_id> --json   # stage/observation
orca terminal send --terminal <handle> --text "<spec>" --enter   # ручная доставка
```

Ручная доставка подтверждена рабочей: агент выполняется и отвечает.
Handle воркера: `orca orchestration worker-show --dispatch <id> --json`
→ `dispatch.assigneeHandle`.

---

## 4. `--dispatch-capability` при ручной доставке

`worker_done` принимается только с токеном `--dispatch-capability`, который
Orca кладёт в промпт-прографию. Если промпт доставлялся вручную, воркер
токена не получил и **не может поселиться** (`dispatch_capability_invalid`).

Токен хранится только хэшем в `orchestration.db`; открытый вид есть лишь
в записанной прографии. Найти его можно в `terminal-history` воркера:

```bash
grep -a -o 'dispatch-capability dcap_[A-Za-z0-9_-]*' \
  ~/.config/orca/terminal-history/*<worker-pane-hash>/output.log | head -1
```

Проверить, что токен тот самый (сверить с `capability_hash` диспатча):

```bash
sqlite3 ~/.config/orca/orchestration.db \
  "SELECT id, capability_hash FROM dispatch_contexts WHERE id='<dispatch_id>';"
python3 -c "import hashlib;print(hashlib.sha256(b'<dcap_token>').hexdigest())"
```

Если хэши совпали — можно закрыть диспатч координатором:

```bash
orca orchestration send \
  --from <worker_handle> --to run:<run_id> \
  --type worker_done --subject "..." --body "<3 предложения: что сделано, что найдено, что осталось>" \
  --task-id <task_id> --dispatch-id <dispatch_id> \
  --dispatch-capability <dcap_token> --outcome succeeded --json
```

Успех виден по `lifecycle.action: "completed"`. После завершения токен
автоматически отзывается — запоздалые `worker_done` от воркера будут
справедливо отклонены (`capability is revoked`), это нормально.

---

## 5. Завершение и уборка

- Принятый `worker_done` сам селит Task — **не** вызывай `task-update`.
- `worker-release` после успеха. Если в терминал был ручной ввод, Orca
  оставит его как `user_takeover` — это безопасно, панель закрывается руками.
- Перед концом хода: `orca orchestration check --ack <delivery_id>` для
  каждого доставленного сообщения (сначала обработать, потом ack).
- Убедиться, что не осталось `reclaimable` терминалов:
  `orca orchestration worker-list --run <run_id> --terminal-state reclaimable --json`.

---

## 6. Чек-лист координатора

- [ ] `orca status --json` — рантайм жив
- [ ] `run-create` (или `run-use`)
- [ ] `worker-start --agent opencode` для всей волны
- [ ] через 20-30 с — `worker-show`; при простое дослать спеку `terminal send`
- [ ] `check --wait`; пустые ожидания — checkpoint
- [ ] обработать и заакать каждое сообщение
- [ ] при ручной доставке — восстановить `dcap_`-токен и закрыть диспатч
- [ ] release/retain/reuse для каждого терминала
