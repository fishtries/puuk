const actions = {
  start: 'Запрошен при запуске Волны.',
  append: 'Добавлен при пополнении очереди.',
  sync: 'Добавлен при пересборке очереди после синхронизации действий слушателя.',
  resume: 'Добавлен при обновлении очереди после локального воспроизведения.',
  after_reserve: 'Пришёл в ответ на запуск Волны, когда уже заиграл скачанный трек.',
  local_start: 'Подобран на устройстве при запуске Волны.',
  local_continue: 'Подобран на устройстве для продолжения Волны.',
};

const sources = {
  current: 'Подбор от текущего трека',
  taste: 'Начальная серия по истории и лайкам',
  random: 'Начальная серия от случайного трека',
  alternate: 'Серия от второй опоры',
  local_neighbors: 'Похожие треки из сохранённого плана',
  local_start: 'Стартовые треки сохранённого плана',
  local_library: 'Подбор из доступных скачанных треков',
};

export function describeWaveTrace(trace) {
  if (!trace) return undefined;
  const anchor = trace.anchor_title || trace.anchor_id;
  const positions = [
    ['в миксе', trace.mix_position],
    ['в ответе сервера', trace.server_position],
    ['после сортировки на iOS', trace.start_position],
  ].filter(([, position]) => Number.isInteger(position));
  return [
    actions[trace.action],
    sources[trace.source],
    anchor && `Опорный трек — ${anchor}.`,
    positions.map(([label, position]) => `№${position} ${label}`).join(' → '),
  ].filter(Boolean).join('\n') || undefined;
}
