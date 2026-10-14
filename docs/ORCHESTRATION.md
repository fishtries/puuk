# Оркестрация OpenCode через Orca — памятка для puuk

Проверено 14.10.2026: OpenCode 1.19.0, Orca CLI/runtime 1.4.220.
Подробности конфигурации subagent, способы работы без Orca и источники:
[AGENT_ORCHESTRATION.md](AGENT_ORCHESTRATION.md).

## 1. Выбор механизма

- Для небольшой задачи внутри текущего OpenCode используйте именованный subagent с собственным `model` и вызов через `@junior` или `task`.
- Для отдельного процесса с контролем задач используйте Orca orchestration: Run, Task, Dispatch и цикл обработки сообщений.
- Для передачи владения без ожидания результата используйте handoff через worktree/terminal-команды Orca.

**Run** — пространство координации и inbox. **Task** — работа с критериями приёмки и зависимостями. **Dispatch** — одна авторитетная попытка задачи. Run сам не запускает готовые задачи: следующую волну выбирает координатор.

## 2. Окружение и справка

Выберите executable один раз и используйте его для всей работы:

1. Если задана `ORCA_CLI_COMMAND`, используйте её значение.
2. Иначе при `ORCA_DEV_REPO_ROOT` используйте `orca-dev`.
3. На Linux вне управляемого терминала используйте `orca-ide`.
4. Внутри Orca используйте `orca`.

В проверенной сессии `orca` разрешается в CLI shim. Вне этого окружения `/usr/bin/orca` может оказаться экранным диктором GNOME.

Команды ниже предполагают рабочий shim `orca`. До запуска прочитайте гайд установленной версии:

```bash
orca status --json
orca skills get orchestration
orca skills get orchestration --reference references/coordinator-loop.md
orca orchestration worker-start --help
opencode --version
opencode models
```

Используйте установленный и авторизованный агентский CLI. Наличие и авторизация Codex при этой проверке не исследовались.

## 3. Спецификация задачи

Каждая задача должна быть самодостаточной:

```text
Target: точные файлы, компонент или окружение.
Change: конкретный результат.
Constraints: инварианты, совместимость и границы изменений.
Ownership: какие файлы можно менять и как взаимодействовать с другими агентами.
Observable acceptance: команды, сценарии и артефакты, доказывающие результат.
Report: изменённые файлы, выполненные проверки, их результаты и блокеры.
```

Для puuk соблюдайте AGENTS.md: изолируйте тестовую БД через `PUUK_DB_PATH`, не изменяйте оригинальные аудиофайлы. Точные команды проверок выбирайте после изучения соответствующего компонента.

`--worktree current` разделяет файлы с координатором. Для параллельных правок нужны непересекающиеся области владения либо отдельные checkout. Незакоммиченные изменения текущего каталога нельзя предполагать перенесёнными в новый checkout.

## 4. Запуск и другая модель

### OpenCode с выбором модели из конфигурации

```bash
orca orchestration run-create --objective '<общая цель>' --json
orca orchestration worker-start \
  --spec '<полная спецификация>' \
  --worktree current --agent opencode --json
```

Начните всю независимую волну до ожидания результатов. Для зависимых задач используйте `task-create --deps <json_array>` и `task-list --ready --brief --json`.

`--agent opencode` выбирает launcher Orca. Модель нового процесса выбирается средствами OpenCode; модель координатора нельзя считать автоматически переданной worker.

### OpenCode с явным выбором другой модели

**`worker-start --agent opencode --model …` не поддерживается** в проверенной версии. Для выбора модели при конкретном запуске создайте агентский терминал, затем назначьте ему задачу:

```bash
orca orchestration run-create --objective '<общая цель>' --json
orca terminal create \
  --worktree current --title 'junior-deepseek' \
  --command 'opencode --model nyxos-deepseek/deepseek-v4.1-flash --agent build' \
  --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
orca orchestration worker-start \
  --spec '<полная спецификация>' \
  --worktree current --terminal <handle> --json
```

Копируйте `<handle>` из результата создания терминала. Каждый шаг зависит от успешного предыдущего. После wait продолжайте только при `satisfied: true`; timeout не означает готовность. Не добавляйте `--agent` или `--model` к назначению на существующий `--terminal`.

`worker-start --terminal` привязывает Dispatch к готовому агенту. Предсуществующий терминал может сохраняться при release; проверяйте receipt и отражайте фактическое решение о ресурсе в отчёте.

Для Claude, Codex, Cursor, Antigravity и Muse `worker-start` поддерживает `--model`; `--effort` требует `--model` и поддержки моделью. Сравнивайте `launch.requested` и `launch.effective`. ID из каталога OpenCode не доказывает доступность той же модели в другом CLI.

Для custom argv/топологии есть `dispatch --inject`, но он не создаёт supervised worker resource row: stop/release не управляют таким процессом. Перед использованием читайте `references/low-level-topology.md`.

## 5. Контроль и приёмка

```bash
orca orchestration check \
  --wait --types 'worker_done,escalation,question' --timeout-ms 60000 --json
orca orchestration worker-show --dispatch <dispatch-id> --json
orca orchestration worker-read --dispatch <dispatch-id> --limit 50 --json
orca orchestration worker-list --run <run-id> --include-remote --json
```

Различайте доказательства:

| Сигнал | Что подтверждает |
|---|---|
| `accepted: true` / `input_accepted` | Ввод принят; начало хода ещё не доказано |
| `turn_started` | Агент начал ход |
| heartbeat / `live` | Наблюдаемая активность или живой агент |
| TUI idle | Готовность или простой интерфейса |
| Принятый `worker_done` | Авторитетное завершение попытки с явным outcome |
| Diff, воспроизводимые проверки, acceptance | Соответствие проверяемым требованиям |

Orca проверяет authority жизненного цикла, а качество результата проверяет координатор. `worker_done --outcome succeeded` не гарантирует, что тесты выполнены или требования соблюдены.

При получении результата:

1. Сопоставьте Task/Dispatch с ожидаемой актуальной попыткой.
2. Прочитайте реальные изменения и отчёт; проверьте границы ownership.
3. Проверьте каждый acceptance-критерий и при необходимости воспроизведите проверки.
4. Для независимой приёмки создайте отдельную review Task с зависимостью от реализации. Исправления после review оформляйте новой задачей.
5. Ответьте на все вопросы и обработайте весь FIFO batch Delivery, затем примите решение о ресурсе и подтвердите обработку.

Вопросы отвечаются через `reply --id <message-id> --body '<ответ>' --json`. `check` без ack повторяет выданный batch; фильтр типов не разрешает пропускать остальные сообщения. `--peek` — просмотр, не продвижение inbox.

## 6. Обязанности worker

Worker следует своему **live injected preamble**, который задаёт executable, отправителя, Task/Dispatch и необходимые capability-флаги.

- Выполняет только назначенную задачу.
- Задаёт блокирующие вопросы через предусмотренный preamble `ask`; после timeout продолжает тот же вопрос по message ID.
- Читает follow-up inbox на естественных checkpoints и перед завершением.
- Отправляет `worker_done` ровно один раз из назначенного контекста, с явным `--outcome succeeded` или `failed` и кратким отчётом.
- Добавляет `--files-modified` и `--report-path` только для реальных файлов/артефактов.
- После completion завершает ход и ждёт новой задачи.

Принятый `worker_done` автоматически завершает Task и Dispatch. Не вызывайте вслед за ним `task-update --status completed`.

## 7. Неясная доставка и восстановление

Тишина, пустое ожидание и `unverifiable` — checkpoints, а не доказательства сбоя. Не досылайте spec автоматически через 20–30 секунд и не запускайте дублирующего исполнителя из-за отсутствия ответа.

После трёх пустых ожиданий прочитайте `worker-list --run <run-id> --include-remote --json`: `projection.liveness`, `projection.attention` и буквальный `projection.nextAction.argv`. Живой PTY в `worker-show` не всегда означает живого агента.

При неясном результате мутации исследуйте receipt и operation identity:

```bash
orca orchestration request-show --request <request-id> --json
orca skills get orchestration --reference references/recovery-and-cleanup.md
```

Повторяйте операцию только согласно recovery receipt с `--retry-request <request-id>`. Не подменяйте такой replay новым send/start.

Retry допустим для доказанно failed/stopped попытки, с той же Task и явным placement:

```bash
orca orchestration worker-start \
  --task <task-id> --retry-of <dispatch-id> \
  --worktree current --agent opencode --json
```

Положительное доказательство выхода агента требует дальнейшего восстановления по гайду; само по себе оно не разрешает release. При `outcome_unknown` сначала исследуйте состояние и следуйте recovery-командам. Capability из истории терминала не используйте для отправки completion координатором от имени worker.

## 8. Завершение и ресурсы

После принятого success/failure settlement выберите одно действие:

- **Reuse:** назначьте следующую Task тому же доказанному handle через `worker-start --terminal`, указав worktree этого терминала.
- **Retain:** используйте `worker-retain`, если пользователь явно хочет сохранить settled worker.
- **Release:** вызовите `worker-release`; он архивирует вывод и освобождает принадлежащий попытке ресурс согласно ownership.

```bash
orca orchestration worker-release --dispatch <dispatch-id> --json
orca orchestration check --ack <delivery-id> --json
orca orchestration worker-list \
  --run <run-id> --terminal-state reclaimable --json
```

Release возможен после succeeded и failed settlement, а также по явному recovery receipt неудавшегося запуска. Timeout, heartbeat, TUI idle и stale/rejected completion не разрешают cleanup. При `release_pending`/`release_unknown` следуйте receipt; не заменяйте release командой `terminal close`.

Предсуществующие, переиспользованные и перешедшие пользователю терминалы могут сохраняться. Итоговый отчёт должен называть outcome каждой задачи, доказательства, оставшиеся блокеры и состояние ресурсов.

## 9. Чек-лист координатора

- [ ] Прочитан гайд установленной версии, runtime доступен.
- [ ] Выбран Run и самодостаточные спецификации задач.
- [ ] Проверены launcher, модель и области владения файлами.
- [ ] Запущена вся независимая волна.
- [ ] Обработаны вопросы и результаты всех ожидаемых Dispatch.
- [ ] Проверены изменения и критерии приёмки.
- [ ] Для каждого settled worker принято решение reuse/retain/release.
- [ ] Delivery подтверждены после обработки, нет ресурсов без решения.
- [ ] Пользователю сообщены результаты, доказательства и блокеры.

Проверка этой памятки основана на CLI help, version-matched guides и разрешении конфигурации OpenCode. End-to-end запуск worker другой модели в рамках исследования не выполнялся.
