/**
 * Network-aware preload policy.
 * Maps the device network state (expo-network) to safe preload limits
 * for the PreloadScheduler:
 * - Wi-Fi / Ethernet: maxConcurrent 2, lookahead 2
 * - Cellular: maxConcurrent 1, lookahead 1
 * - Unknown / offline / error: maxConcurrent 1, lookahead 1 (safe for mobile data)
 * Сеть никогда не расширяет сконфигурированные лимиты планировщика — только сужает.
 */

import { getNetworkStateAsync, addNetworkStateListener } from 'expo-network';

export const NETWORK_POLICY = {
  WIFI: { type: 'wifi', maxConcurrent: 2, lookahead: 2 },
  CELLULAR: { type: 'cellular', maxConcurrent: 1, lookahead: 1 },
  UNKNOWN: { type: 'unknown', maxConcurrent: 1, lookahead: 1 },
};

export const SAFE_NETWORK_POLICY = NETWORK_POLICY.UNKNOWN;

const WIFI_TYPES = new Set(['WIFI', 'ETHERNET']);
const CELLULAR_TYPES = new Set(['CELLULAR']);

/**
 * Преобразует NetworkState (expo-network) в политику предзагрузки.
 * Offline никогда не расширяет лимиты: возвращается безопасная политика
 * (maxConcurrent 1 / lookahead 1), а факт отсутствия связи сообщается отдельно
 * через policy.isConnected (metadata для диагностики и остановки старта задач).
 * @param {Object|null} state - { type, isConnected, isInternetReachable }
 * @returns {{ type: string, maxConcurrent: number, lookahead: number, isConnected?: boolean }}
 */
export function classifyNetworkPolicy(state) {
  if (!state || typeof state !== 'object') {
    return SAFE_NETWORK_POLICY;
  }
  if (state.isConnected === false || state.isInternetReachable === false) {
    return SAFE_NETWORK_POLICY;
  }
  const type = String(state.type || '').toUpperCase();
  if (WIFI_TYPES.has(type)) return NETWORK_POLICY.WIFI;
  if (CELLULAR_TYPES.has(type)) return NETWORK_POLICY.CELLULAR;
  return NETWORK_POLICY.UNKNOWN;
}

/**
 * Возвращает true, если политика разрешает старт фоновых загрузок.
 * Offline (isConnected:false) — ноль задач; undefined считается online для совместимости.
 * @param {Object|null} policy
 * @returns {boolean}
 */
export function isPolicyOnline(policy) {
  return !policy || policy.isConnected !== false;
}

let currentPolicy = SAFE_NETWORK_POLICY; // SAFE baseline before async network detection completes
let observationStarted = false;
const listeners = new Set();

/**
 * Строит публичную политику из NetworkState: базовые лимиты из classifyNetworkPolicy
 * плюс metadata isConnected (false = сеть недоступна, старт фоновых задач запрещён).
 * @param {Object|null} state
 * @returns {{ type: string, maxConcurrent: number, lookahead: number, isConnected: boolean }}
 */
export function buildNetworkPolicy(state) {
  const base = classifyNetworkPolicy(state);
  const offline = Boolean(
    state &&
    typeof state === 'object' &&
    (state.isConnected === false || state.isInternetReachable === false),
  );
  return offline ? { ...base, isConnected: false } : base;
}

function applyPolicy(state) {
  const next = buildNetworkPolicy(state);
  const changed =
    !currentPolicy ||
    next.type !== currentPolicy.type ||
    next.isConnected !== currentPolicy.isConnected;
  currentPolicy = next;
  if (changed) {
    for (const listener of Array.from(listeners)) {
      try {
        listener(currentPolicy);
      } catch (err) {
        console.warn('[NetworkPolicy] listener error:', err);
      }
    }
  }
  return currentPolicy;
}

/**
 * Последняя известная политика сети (синхронно).
 * Возвращает SAFE_NETWORK_POLICY по умолчанию (maxConcurrent: 1, lookahead: 1).
 * @returns {{ type: string, maxConcurrent: number, lookahead: number }}
 */
export function getCurrentNetworkPolicy() {
  return currentPolicy || SAFE_NETWORK_POLICY;
}

/**
 * Запрашивает актуальное состояние сети и обновляет политику.
 * При ошибке (нативный модуль недоступен и т.п.) применяется безопасная политика.
 * @returns {Promise<{ type: string, maxConcurrent: number, lookahead: number }>}
 */
export async function getNetworkPolicy() {
  try {
    const state = await getNetworkStateAsync();
    return applyPolicy(state);
  } catch {
    return applyPolicy(null);
  }
}

/**
 * Подписка на смену политики сети.
 * @param {Function} listener (policy) => void
 * @returns {Function} unsubscribe
 */
export function subscribeNetworkPolicy(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Следит за сменой состояния сети на протяжении жизни приложения (best effort).
 * Безопасно вызывать повторно.
 */
export function startNetworkObserving() {
  if (observationStarted) return;
  observationStarted = true;
  try {
    if (typeof addNetworkStateListener === 'function') {
      addNetworkStateListener((state) => {
        applyPolicy(state);
      });
    }
  } catch (err) {
    console.warn(
      '[NetworkPolicy] Failed to observe network state:',
      err?.message,
    );
  }
}

startNetworkObserving();
getNetworkPolicy().catch(() => {});
