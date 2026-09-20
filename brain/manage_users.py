#!/usr/bin/env python3
import sys
import argparse
import os

# Добавляем путь к brain в sys.path
sys.path.insert(0, os.path.dirname(__file__))

import db
from security import hash_password

def list_cmd(args):
    users = db.list_users()
    if not users:
        print("Пользователи не найдены.")
        return
    print(f"{'ID':<4} | {'Логин':<16} | {'Роль':<8} | {'Telegram ID':<14} | {'Создан'}")
    print("-" * 65)
    for u in users:
        tg_id = str(u['telegram_id']) if u['telegram_id'] else "-"
        print(f"{u['id']:<4} | {u['username']:<16} | {u['role']:<8} | {tg_id:<14} | {u['created_at']}")

def create_cmd(args):
    pwd_hash = hash_password(args.password) if args.password else None
    try:
        user_id = db.create_user(
            username=args.username,
            password_hash=pwd_hash,
            telegram_id=args.tg_id,
            role=args.role
        )
        print(f"Пользователь '{args.username}' успешно создан (ID: {user_id}, Роль: {args.role}).")
    except Exception as e:
        print(f"Ошибка создания пользователя: {e}")

def set_password_cmd(args):
    user = db.get_user_by_username(args.username)
    if not user:
        print(f"Пользователь '{args.username}' не найден.")
        return
    pwd_hash = hash_password(args.password)
    db.update_user_password(user["id"], pwd_hash)
    print(f"Пароль для '{args.username}' успешно обновлен.")

def link_tg_cmd(args):
    user = db.get_user_by_username(args.username)
    if not user:
        print(f"Пользователь '{args.username}' не найден.")
        return
    db.link_user_telegram(user["id"], args.tg_id)
    print(f"Telegram ID {args.tg_id} привязан к пользователю '{args.username}'.")

def delete_cmd(args):
    user = db.get_user_by_username(args.username)
    if not user:
        print(f"Пользователь '{args.username}' не найден.")
        return
    if user["id"] == 1:
        print("Нельзя удалить основного системного администратора (ID: 1).")
        return
    db.delete_user(user["id"])
    print(f"Пользователь '{args.username}' (ID: {user['id']}) удален.")

def main():
    parser = argparse.ArgumentParser(description="Puuk User Management CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # list
    subparsers.add_parser("list", help="Список всех пользователей")

    # create
    create_parser = subparsers.add_parser("create", help="Создать нового пользователя")
    create_parser.add_argument("--username", required=True, help="Имя пользователя")
    create_parser.add_argument("--password", help="Пароль пользователя")
    create_parser.add_argument("--role", default="user", choices=["user", "admin"], help="Роль (user или admin)")
    create_parser.add_argument("--tg-id", type=int, help="Telegram ID пользователя")

    # set-password
    pwd_parser = subparsers.add_parser("set-password", help="Сменить пароль пользователя")
    pwd_parser.add_argument("--username", required=True, help="Имя пользователя")
    pwd_parser.add_argument("--password", required=True, help="Новый пароль")

    # link-tg
    tg_parser = subparsers.add_parser("link-tg", help="Привязать Telegram ID к пользователю")
    tg_parser.add_argument("--username", required=True, help="Имя пользователя")
    tg_parser.add_argument("--tg-id", type=int, required=True, help="Telegram ID")

    # delete
    del_parser = subparsers.add_parser("delete", help="Удалить пользователя")
    del_parser.add_argument("--username", required=True, help="Имя пользователя")

    args = parser.parse_args()

    commands = {
        "list": list_cmd,
        "create": create_cmd,
        "set-password": set_password_cmd,
        "link-tg": link_tg_cmd,
        "delete": delete_cmd
    }
    commands[args.command](args)

if __name__ == "__main__":
    main()
