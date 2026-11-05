import { syncStateManager } from '../syncState';

describe('SyncStateManager - background operations & indicator logic', () => {
  beforeEach(() => {
    syncStateManager.reset();
  });

  test('параллельные операции учитываются независимо: завершение одной не скрывает оставшиеся', () => {
    expect(syncStateManager.getState().isLoading).toBe(false);

    // Запускаем две параллельные операции
    syncStateManager.startOperation('auth');
    syncStateManager.startOperation('catalog');

    let state = syncStateManager.getState();
    expect(state.isLoading).toBe(true);
    expect(state.loadingOperations).toEqual(
      expect.arrayContaining(['auth', 'catalog']),
    );

    // Завершаем auth успешно
    syncStateManager.finishOperation('auth', { success: true });

    state = syncStateManager.getState();
    // Общее состояние ВСЁ ЕЩЁ loading, так как catalog ещё выполняется!
    expect(state.isLoading).toBe(true);
    expect(state.loadingOperations).toEqual(['catalog']);

    // Завершаем catalog успешно
    syncStateManager.finishOperation('catalog', { success: true });

    state = syncStateManager.getState();
    expect(state.isLoading).toBe(false);
    expect(state.hasError).toBe(false);
  });

  test('ошибка одного ресурса не исчезает только потому, что другой успешно загрузился', () => {
    syncStateManager.startOperation('genre_mixes');
    syncStateManager.startOperation('catalog');

    // genre_mixes завершается с ошибкой 500
    syncStateManager.finishOperation('genre_mixes', {
      success: false,
      status: 500,
      isServer: true,
      message: 'Сервер временно недоступен',
    });

    let state = syncStateManager.getState();
    // catalog всё ещё крутится
    expect(state.isLoading).toBe(true);

    // catalog завершается успешно
    syncStateManager.finishOperation('catalog', { success: true });

    state = syncStateManager.getState();
    // Загрузка завершена, но ошибка genre_mixes НЕ исчезла!
    expect(state.isLoading).toBe(false);
    expect(state.hasError).toBe(true);
    expect(state.isServerUnavailable).toBe(true);
    expect(state.errors).toHaveLength(1);
    expect(state.errors[0].id).toBe('genre_mixes');
    expect(state.errors[0].error.status).toBe(500);

    // Запускаем ещё одну операцию history и завершаем успешно
    syncStateManager.startOperation('history');
    syncStateManager.finishOperation('history', { success: true });

    state = syncStateManager.getState();
    // Ошибка genre_mixes всё ещё на месте!
    expect(state.hasError).toBe(true);
    expect(state.errors[0].id).toBe('genre_mixes');
  });

  test('отмена запроса не считается ошибкой соединения', () => {
    syncStateManager.startOperation('recently_listened');

    expect(syncStateManager.getState().isLoading).toBe(true);

    // Пользователь переключил вкладку или запрос отменён AbortController
    syncStateManager.cancelOperation('recently_listened');

    const state = syncStateManager.getState();
    expect(state.isLoading).toBe(false);
    expect(state.hasError).toBe(false);
    expect(state.errors).toHaveLength(0);
  });

  test('поздний ответ после выхода/сброса не восстанавливает старое состояние', () => {
    syncStateManager.startOperation('catalog');

    // Произошёл logout или смена сервера
    syncStateManager.reset();

    // Поздний ответ от старой операции
    syncStateManager.finishOperation('catalog', {
      success: false,
      status: 503,
      message: 'Old error',
    });

    const state = syncStateManager.getState();
    expect(state.isLoading).toBe(false);
    expect(state.hasError).toBe(false);
    expect(state.errors).toHaveLength(0);
  });

  test('повтор запускает неудавшуюся операцию и снимает ошибку по её результату', async () => {
    let catalogAttempts = 0;
    const retryCatalog = jest.fn(async () => {
      catalogAttempts += 1;
      syncStateManager.startOperation('catalog', { retryFn: retryCatalog });
      if (catalogAttempts === 1) {
        syncStateManager.finishOperation('catalog', {
          success: false,
          status: 500,
          isServer: true,
        });
      } else {
        syncStateManager.finishOperation('catalog', { success: true });
      }
    });

    // Первая попытка — ошибка
    await retryCatalog();

    let state = syncStateManager.getState();
    expect(state.hasError).toBe(true);
    expect(state.isServerUnavailable).toBe(true);

    // Вызываем повтор через syncStateManager.retryFailed()
    await syncStateManager.retryFailed();

    state = syncStateManager.getState();
    expect(state.hasError).toBe(false);
    expect(state.isLoading).toBe(false);
    expect(catalogAttempts).toBe(2);
  });

  test('повтор не создаёт дубли при повторных нажатиях', async () => {
    let executionCount = 0;
    let resolveRetry;
    const pendingRetryPromise = new Promise((resolve) => {
      resolveRetry = resolve;
    });

    const longRetry = jest.fn(async () => {
      executionCount += 1;
      await pendingRetryPromise;
      syncStateManager.finishOperation('slow_op', { success: true });
    });

    syncStateManager.startOperation('slow_op', { retryFn: longRetry });
    syncStateManager.finishOperation('slow_op', {
      success: false,
      status: 500,
    });

    // Запускаем первый повтор
    const p1 = syncStateManager.retryFailed();
    // Быстрое второе и третье нажатие пользователем во время первого повтора
    const p2 = syncStateManager.retryFailed();
    const p3 = syncStateManager.retryFailed();

    expect(executionCount).toBe(1);

    resolveRetry();
    await Promise.all([p1, p2, p3]);

    expect(executionCount).toBe(1);
    expect(syncStateManager.getState().hasError).toBe(false);
  });
});
