import { useState, useEffect } from 'react';

/**
 * Background sync state manager for tracking critical home/session operations:
 * - /api/auth/me session verification
 * - Catalog tracks pagination (initial/refresh)
 * - Personalized genre recommendations (genre mixes)
 * - Recently listened history
 *
 * Requirements:
 * - Parallel operations tracked independently: completion of one doesn't hide remaining
 * - Abort / cancellation is not an error
 * - Fresh cache hits do not simulate network loading
 * - Late responses after logout / user switch / server change are ignored
 * - Error of one resource does not disappear because another succeeded
 * - Deduplicated retries without endless polling or app restart
 */

class SyncStateManager {
  constructor() {
    this.operations = new Map();
    this.listeners = new Set();
    this.generation = 0;
    this.isRetrying = false;
  }

  getGeneration() {
    return this.generation;
  }

  startOperation(id, options = {}) {
    const prev = this.operations.get(id);
    const retryFn = options.retryFn || prev?.retryFn;
    this.operations.set(id, {
      id,
      status: 'loading',
      error: null,
      retryFn,
      startedAt: Date.now(),
      generation: this.generation,
    });
    this.notify();
  }

  finishOperation(id, result = {}) {
    const op = this.operations.get(id);
    if (!op || op.generation !== this.generation) {
      return;
    }

    if (result.success) {
      this.operations.set(id, {
        ...op,
        status: 'success',
        error: null,
        finishedAt: Date.now(),
      });
    } else {
      const err = result.error || {};
      const status = result.status ?? err.status ?? null;
      const isServer = Boolean(
        result.isServer ||
        (typeof status === 'number' && status >= 500 && status <= 599),
      );
      const isNetwork = Boolean(result.isNetwork || err.isNetwork);
      const isTimeout = Boolean(result.isTimeout || err.isTimeout);
      const message =
        result.message ||
        err.message ||
        (isServer ? 'Сервер временно недоступен' : 'Ошибка сети');

      this.operations.set(id, {
        ...op,
        status: 'error',
        error: {
          status,
          isServer,
          isNetwork,
          isTimeout,
          message,
          cause: err,
        },
        finishedAt: Date.now(),
      });
    }

    this.notify();
  }

  cancelOperation(id) {
    const op = this.operations.get(id);
    if (!op || op.generation !== this.generation) {
      return;
    }
    if (op.status === 'loading') {
      this.operations.set(id, {
        ...op,
        status: 'idle',
      });
      this.notify();
    }
  }

  registerRetry(id, retryFn) {
    const op = this.operations.get(id);
    if (op) {
      op.retryFn = retryFn;
    } else {
      this.operations.set(id, {
        id,
        status: 'idle',
        error: null,
        retryFn,
        generation: this.generation,
      });
    }
  }

  clearError(id) {
    const op = this.operations.get(id);
    if (op && op.status === 'error') {
      this.operations.set(id, {
        ...op,
        status: 'idle',
        error: null,
      });
      this.notify();
    }
  }

  reset() {
    this.generation += 1;
    this.operations.clear();
    this.isRetrying = false;
    this.notify();
  }

  getState() {
    let isLoading = false;
    let hasError = false;
    let isServerUnavailable = false;
    let isNetworkError = false;
    const errors = [];
    const loadingOps = [];

    for (const [id, op] of this.operations.entries()) {
      if (op.generation !== this.generation) continue;
      if (op.status === 'loading') {
        isLoading = true;
        loadingOps.push(id);
      } else if (op.status === 'error' && op.error) {
        hasError = true;
        errors.push({ id, error: op.error });
        if (op.error.isServer) {
          isServerUnavailable = true;
        }
        if (op.error.isNetwork) {
          isNetworkError = true;
        }
      }
    }

    return {
      isLoading,
      hasError: hasError && !isLoading,
      isServerUnavailable,
      isNetworkError,
      loadingOperations: loadingOps,
      errors,
      totalOperations: this.operations.size,
    };
  }

  async retryFailed() {
    if (this.isRetrying) {
      return;
    }

    const failedOps = [];
    for (const [, op] of this.operations.entries()) {
      if (
        op.generation === this.generation &&
        op.status === 'error' &&
        typeof op.retryFn === 'function'
      ) {
        failedOps.push(op);
      }
    }

    if (failedOps.length === 0) {
      return;
    }

    this.isRetrying = true;
    try {
      await Promise.all(
        failedOps.map(async (op) => {
          try {
            await op.retryFn();
          } catch {
            // Errors are handled by the retryFn via finishOperation
          }
        }),
      );
    } finally {
      this.isRetrying = false;
    }
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify() {
    const state = this.getState();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch (err) {
        console.error('[SyncStateManager] Listener error:', err);
      }
    }
  }
}

export const syncStateManager = new SyncStateManager();

export function useSyncStatus() {
  const [status, setStatus] = useState(() => syncStateManager.getState());

  useEffect(() => {
    const unsub = syncStateManager.subscribe((newStatus) => {
      setStatus(newStatus);
    });
    return unsub;
  }, []);

  return status;
}
