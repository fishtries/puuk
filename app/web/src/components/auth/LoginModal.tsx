import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Send, Lock, KeyRound } from 'lucide-react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useAuthStore } from '../../store/useAuthStore';
import styles from './LoginModal.module.css';

export const LoginModal: React.FC = () => {
  const isLoginOpen = usePlayerStore((state) => state.isLoginOpen);
  const setIsLoginOpen = usePlayerStore((state) => state.setIsLoginOpen);

  const [authMode, setAuthMode] = useState<'code' | 'password'>('code');
  const [telegramCode, setTelegramCode] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  const { login, loginWithTelegramCode, isLoading, error: authError } = useAuthStore();

  const handleClose = () => {
    setIsLoginOpen(false);
    setLocalError(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    try {
      if (authMode === 'code') {
        if (!telegramCode.trim()) {
          setLocalError('Введите одноразовый код из Telegram');
          return;
        }
        await loginWithTelegramCode(telegramCode.trim());
      } else {
        if (!username.trim() || !password) {
          setLocalError('Заполните имя пользователя и пароль');
          return;
        }
        await login({ username: username.trim(), password });
      }
      handleClose();
    } catch {
      // Handled by store
    }
  };

  return (
    <AnimatePresence>
      {isLoginOpen && (
        <div className={styles.backdrop} onClick={handleClose}>
          <motion.div
            className={styles.modal}
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.95, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 16 }}
            transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}
            role="dialog"
            aria-modal="true"
            aria-label="Вход в аккаунт"
          >
            <header className={styles.header}>
              <h2 className={styles.title}>Авторизация в Puuk</h2>
              <button
                type="button"
                className={styles.closeBtn}
                onClick={handleClose}
                aria-label="Закрыть окно"
              >
                <X size={18} />
              </button>
            </header>

            <div className={styles.modeTabs}>
              <button
                type="button"
                className={`${styles.modeTab} ${authMode === 'code' ? styles.activeModeTab : ''}`}
                onClick={() => setAuthMode('code')}
              >
                <KeyRound size={15} />
                <span>Код из Telegram</span>
              </button>
              <button
                type="button"
                className={`${styles.modeTab} ${authMode === 'password' ? styles.activeModeTab : ''}`}
                onClick={() => setAuthMode('password')}
              >
                <Lock size={15} />
                <span>Логин / Пароль</span>
              </button>
            </div>

            <form onSubmit={handleSubmit} className={styles.form}>
              {authMode === 'code' ? (
                <div className={styles.fieldGroup}>
                  <label className={styles.label}>Одноразовый код из бота</label>
                  <input
                    type="text"
                    placeholder="Например: 849201"
                    value={telegramCode}
                    onChange={(e) => setTelegramCode(e.target.value)}
                    className={styles.input}
                    autoFocus
                    maxLength={10}
                  />
                  <span className={styles.hint}>
                    Отправьте команду <code>/login</code> боту в Telegram для получения кода
                  </span>
                </div>
              ) : (
                <>
                  <div className={styles.fieldGroup}>
                    <label className={styles.label}>Имя пользователя</label>
                    <input
                      type="text"
                      placeholder="Username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      className={styles.input}
                      autoFocus
                    />
                  </div>
                  <div className={styles.fieldGroup}>
                    <label className={styles.label}>Пароль</label>
                    <input
                      type="password"
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className={styles.input}
                    />
                  </div>
                </>
              )}

              {(localError || authError) && (
                <div className={styles.errorAlert}>
                  {localError || authError}
                </div>
              )}

              <button
                type="submit"
                className={styles.submitBtn}
                disabled={isLoading}
              >
                <Send size={16} />
                <span>{isLoading ? 'Проверка...' : 'Войти в систему'}</span>
              </button>
            </form>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
