import * as SecureStore from 'expo-secure-store';
import {
  restoreLocalSession,
  verifySession,
  checkAuth,
  setAuthToken,
  setSavedUser,
  getSavedUser,
  getCachedAuthToken,
  logout,
  addAuthListener,
  SERVER_URL,
} from '../api';

const mockStore = new Map();
const jwt = (id) => `header.${Buffer.from(JSON.stringify({ sub: String(id), exp: Date.now() / 1000 + 60 })).toString('base64url')}.signature`;

jest.mock('../../../offline/session', () => {
  const actual = jest.requireActual('../../../offline/session');
  let session;
  return {
    ...actual,
    createOfflineId: jest.fn(() => 'activation'),
    persistOfflineActivation: jest.fn(async () => {}),
    revokeOfflineActivation: jest.fn(async () => {}),
    getOfflineSession: () => session || null,
    closeOfflineSession: () => { const previous = session; session = null; return previous; },
    openOfflineSession: jest.fn(async (value, _expiry, current) => {
      if (!current()) return false;
      session = value;
      return true;
    }),
  };
});
jest.mock('../../../offline', () => ({ reconcileTransfers: jest.fn(async () => {}) }));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key) => mockStore.get(key) || null),
  setItemAsync: jest.fn(async (key, val) => {
    mockStore.set(key, String(val));
  }),
  deleteItemAsync: jest.fn(async (key) => {
    mockStore.delete(key);
  }),
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
}));

describe('Session Lifecycle & Decoupled Launch', () => {
  const originalFetch = global.fetch;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockStore.clear();
    await logout();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('Сохранённая сессия открывает интерфейс, пока /api/auth/me ещё не завершён', async () => {
    const token = jwt(42);
    mockStore.set('puuk_auth_session_v1', JSON.stringify({
      token, user: { id: 42, username: 'tester' },
      owner: { origin: SERVER_URL, userId: '42' }, activationId: 'existing',
    }));

    // 2. Локальное восстановление сессии возвращает пользователя и токен мгновенно без сети
    global.fetch = jest.fn();
    const localSession = await restoreLocalSession();

    expect(localSession.hasToken).toBe(true);
    expect(localSession.hasUser).toBe(true);
    expect(localSession.user).toEqual({ id: 42, username: 'tester' });
    expect(localSession.token).toBe(token);
    // Сеть ещё не вызывалась!
    expect(global.fetch).not.toHaveBeenCalled();

    // 3. Запускаем фоновую проверку сессии с задержкой ответа от сервера
    let resolveServerResponse;
    const serverPromise = new Promise((resolve) => {
      resolveServerResponse = resolve;
    });

    global.fetch = jest.fn().mockImplementation(() => serverPromise);

    const backgroundVerification = verifySession();
    while (!global.fetch.mock.calls.length) await Promise.resolve();

    // Интерфейс уже работает с локальным пользователем, пока запрос висит в фоне
    expect(localSession.user.username).toBe('tester');
    expect(global.fetch).toHaveBeenCalledTimes(1);

    // Завершаем сетевой запрос
    resolveServerResponse({
      ok: true,
      status: 200,
      json: async () => ({ id: 42, username: 'tester_updated' }),
    });

    const verifyResult = await backgroundVerification;
    expect(verifyResult.success).toBe(true);
    expect(verifyResult.user.username).toBe('tester_updated');
    expect(await getSavedUser()).toEqual({
      id: 42,
      username: 'tester_updated',
    });
  });

  test('Сетевая ошибка и 5xx не разлогинивают пользователя', async () => {
    await setAuthToken('valid-token');
    await setSavedUser({ id: 10, username: 'offline_user' });

    // Слушатель смены авторизации
    const authListener = jest.fn();
    const unsub = addAuthListener(authListener);

    // 1. Сетевая ошибка (Failed to fetch)
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const netResult = await verifySession();
    expect(netResult.success).toBe(false);
    expect(netResult.isNetwork).toBe(true);
    // Токен и пользователь не сброшены
    expect(getCachedAuthToken()).toBe('valid-token');
    expect(await getSavedUser()).toEqual({ id: 10, username: 'offline_user' });
    expect(authListener).not.toHaveBeenCalledWith(null);

    // 2. Ошибка сервера 500
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    const serverResult500 = await verifySession();
    expect(serverResult500.success).toBe(false);
    expect(serverResult500.isServer).toBe(true);
    expect(getCachedAuthToken()).toBe('valid-token');
    expect(await getSavedUser()).toEqual({ id: 10, username: 'offline_user' });
    expect(authListener).not.toHaveBeenCalledWith(null);

    // 3. Ошибка сервера 503
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 503,
    });

    const serverResult503 = await verifySession();
    expect(serverResult503.success).toBe(false);
    expect(serverResult503.isServer).toBe(true);
    expect(getCachedAuthToken()).toBe('valid-token');
    expect(await getSavedUser()).toEqual({ id: 10, username: 'offline_user' });
    expect(authListener).not.toHaveBeenCalledWith(null);

    unsub();
  });

  test('401 переводит на вход (сбрасывает сессию и пользователя)', async () => {
    await setAuthToken('expired-token');
    await setSavedUser({ id: 1, username: 'expired_user' });

    const authListener = jest.fn();
    const unsub = addAuthListener(authListener);

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
    });

    const result = await verifySession();
    expect(result.success).toBe(false);
    expect(result.status).toBe(401);
    expect(result.isAuth).toBe(true);

    // Токен и пользователь очищены в SecureStore и памяти
    expect(getCachedAuthToken()).toBeNull();
    expect(await getSavedUser()).toBeNull();
    expect(authListener).toHaveBeenCalledWith(null);

    unsub();
  });

  test('Отсутствие токена не запускает проверку сессии', async () => {
    // Сохранённый пользователь без токена
    mockStore.set(
      'puuk_auth_user',
      JSON.stringify({ id: 99, username: 'ghost_user' }),
    );
    global.fetch = jest.fn();

    const localSession = await restoreLocalSession();
    expect(localSession.hasToken).toBe(false);
    expect(localSession.hasUser).toBe(false);
    expect(localSession.user).toBeNull();

    // checkAuth также не вызывает сеть
    const checkAuthResult = await checkAuth();
    expect(checkAuthResult).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('Поздний ответ после logout не возвращает пользователя', async () => {
    await setAuthToken('token-to-logout');
    await setSavedUser({ id: 7, username: 'user_logging_out' });

    let resolveFetch;
    global.fetch = jest.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );

    // Запускаем фоновую проверку
    const verifyPromise = verifySession();
    while (!resolveFetch) await Promise.resolve();

    // Пользователь нажимает «Выйти» во время фонового запроса
    await logout();
    expect(getCachedAuthToken()).toBeNull();
    expect(await getSavedUser()).toBeNull();

    // Поздний ответ от сервера возвращает 200 OK
    resolveFetch({
      ok: true,
      status: 200,
      json: async () => ({ id: 7, username: 'user_logging_out_fresh' }),
    });

    const result = await verifyPromise;
    // Результат помечен как прерванный / не применён
    expect(result.aborted).toBe(true);
    // Пользователь НЕ восстановился!
    expect(getCachedAuthToken()).toBeNull();
    expect(await getSavedUser()).toBeNull();
  });

  test('Есть токен, но пользователь не сохранён: восстанавливает профиль или даёт ошибку с повтором', async () => {
    mockStore.delete('puuk_auth_session_v1');
    mockStore.set('puuk_auth_token', jwt(55));
    mockStore.set('puuk_auth_user', JSON.stringify({ id: 99, username: 'unbound' }));
    // An unbound saved profile can't open the offline index.
    const localSession = await restoreLocalSession();
    expect(localSession.hasToken).toBe(true);
    expect(localSession.hasUser).toBe(false);

    // 1. Успешное восстановление
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ id: 55, username: 'restored_user' }),
    });

    const verifySuccess = await verifySession();
    expect(verifySuccess.success).toBe(true);
    expect(verifySuccess.user.username).toBe('restored_user');
    expect(await getSavedUser()).toEqual({
      id: 55,
      username: 'restored_user',
    });

    // 2. Ошибка 500 при отсутствии сохраненного пользователя
    await logout();
    await setAuthToken('token-only-2');
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    const verifyFail = await verifySession();
    expect(verifyFail.success).toBe(false);
    expect(verifyFail.isServer).toBe(true);
    // Токен остаётся сохранённым, чтобы пользователь мог повторить
    expect(getCachedAuthToken()).toBe('token-only-2');
  });
});
