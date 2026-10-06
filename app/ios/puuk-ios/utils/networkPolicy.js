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
 * @param {Object|null} state - { type, isConnected, isInternetReachable }
 * @returns {{ type: string, maxConcurrent: number, lookahead: number }}
 */
export function classifyNetworkPolicy(state) {
  if (!state || typeof state !== 'object') return NETWORK_POLICY.UNKNOWN;
  if (state.isConnected === false || state.isInternetReachable === false) {
    return NETWORK_POLICY.UNKNOWN;
  }
  const type = String(state.type || '').toUpperCase();
  if (WIFI_TYPES.has(type)) return NETWORK_POLICY.WIFI;
  if (CELLULAR_TYPES.has(type)) return NETWORK_POLICY.CELLULAR;
  return NETWORK_POLICY.UNKNOWN;
}

let currentPolicy = SAFE_NETWORK_POLICY; // SAFE baseline before async network detection completes
let observationStarted = false;
const listeners = new Set();

function applyPolicy(state) {
  const next = classifyNetworkPolicy(state);
  const changed = !currentPolicy || next.type !== currentPolicy.type;
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
    console.warn('[NetworkPolicy] Failed to observe network state:', err?.message);
  }
}

startNetworkObserving();
getNetworkPolicy().catch(() => {});
