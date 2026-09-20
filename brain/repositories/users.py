"""User accounts and Telegram OTP auth codes."""
from datetime import datetime, timezone

from repositories.base import get_connection


def create_user(username: str, password_hash: str = None, telegram_id: int = None, role: str = "user") -> int:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO users (username, password_hash, telegram_id, role)
        VALUES (?, ?, ?, ?)
    """, (username, password_hash, telegram_id, role))
    conn.commit()
    user_id = cursor.lastrowid
    conn.close()
    return user_id

def get_user_by_id(user_id: int) -> dict | None:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def get_user_by_username(username: str) -> dict | None:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE username = ?", (username,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def get_user_by_telegram_id(telegram_id: int) -> dict | None:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE telegram_id = ?", (telegram_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None

def update_user_password(user_id: int, password_hash: str):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, user_id))
    conn.commit()
    conn.close()

def link_user_telegram(user_id: int, telegram_id: int):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("UPDATE users SET telegram_id = ? WHERE id = ?", (telegram_id, user_id))
    conn.commit()
    conn.close()

def list_users() -> list[dict]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT id, username, telegram_id, role, created_at FROM users ORDER BY id ASC")
    users = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return users

def delete_user(user_id: int) -> bool:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM users WHERE id = ?", (user_id,))
    affected = cursor.rowcount > 0
    conn.commit()
    conn.close()
    return affected

# --- Одноразовые коды авторизации (Telegram OTP) ---

def create_auth_code(user_id: int, code: str, expires_at: str) -> int:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO auth_codes (user_id, code, expires_at, used)
        VALUES (?, ?, ?, 0)
    """, (user_id, code, expires_at))
    conn.commit()
    code_id = cursor.lastrowid
    conn.close()
    return code_id

def verify_and_consume_auth_code(code: str) -> dict | None:
    """
    Проверяет 6-значный одноразовый код.
    Если валиден, не истек и не использован — помечает использованным и возвращает пользователя.
    """
    conn = get_connection()
    cursor = conn.cursor()
    now_iso = datetime.now(timezone.utc).isoformat()
    cursor.execute("""
        SELECT ac.id as code_id, ac.expires_at, ac.used, u.*
        FROM auth_codes ac
        JOIN users u ON ac.user_id = u.id
        WHERE ac.code = ? AND ac.used = 0
        ORDER BY ac.created_at DESC
        LIMIT 1
    """, (code,))
    row = cursor.fetchone()
    if not row:
        conn.close()
        return None

    expires_at_str = row["expires_at"]
    if expires_at_str < now_iso:
        conn.close()
        return None

    code_id = row["code_id"]
    cursor.execute("UPDATE auth_codes SET used = 1 WHERE id = ?", (code_id,))
    conn.commit()

    user_dict = {
        "id": row["id"],
        "username": row["username"],
        "telegram_id": row["telegram_id"],
        "role": row["role"],
        "created_at": row["created_at"]
    }
    conn.close()
    return user_dict
