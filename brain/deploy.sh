#!/bin/bash
set -euo pipefail

# Динамическое определение путей
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_DIR="${SCRIPT_DIR}/"

# Конфигурация (с возможностью переопределения через переменные окружения)
SERVER_IP="${SERVER_IP:-192.168.1.117}"
SERVER_PORT="${SERVER_PORT:-59348}"
SERVER_USER="${SERVER_USER:-fish}"
REMOTE_DIR="${REMOTE_DIR:-/home/fish/apps/puuk/brain/}"

# Опции
DO_INSTALL=false
DO_DELETE=false
DRY_RUN=false

show_help() {
    echo "Использование: ./deploy.sh [ОПЦИИ]"
    echo ""
    echo "Опции:"
    echo "  -i, --install    Установить/обновить зависимости на сервере после синхронизации (через SSH)"
    echo "  --delete         Удалить на сервере файлы, которых больше нет локально"
    echo "  -n, --dry-run    Пробный запуск rsync без реальной передачи файлов"
    echo "  -h, --help       Показать эту справку"
    echo ""
    echo "Переменные окружения:"
    echo "  SERVER_IP        IP сервера (по умолчанию: $SERVER_IP)"
    echo "  SERVER_PORT      SSH-порт (по умолчанию: $SERVER_PORT)"
    echo "  SERVER_USER      Пользователь SSH (по умолчанию: $SERVER_USER)"
    echo "  REMOTE_DIR       Путь на сервере (по умолчанию: $REMOTE_DIR)"
    exit 0
}

# Парсинг аргументов
while [[ $# -gt 0 ]]; do
    case "$1" in
        -i|--install)
            DO_INSTALL=true
            shift
            ;;
        --delete)
            DO_DELETE=true
            shift
            ;;
        -n|--dry-run)
            DRY_RUN=true
            shift
            ;;
        -h|--help)
            show_help
            ;;
        *)
            echo "Неизвестный параметр: $1"
            show_help
            ;;
    esac
done

echo "================================================"
echo "🚀 Puuk Brain Deploy"
echo "Сервер:       $SERVER_USER@$SERVER_IP:$SERVER_PORT"
echo "Удаленный:    $REMOTE_DIR"
echo "Локальный:    $LOCAL_DIR"
if [ "$DRY_RUN" = true ]; then
    echo "Режим:        DRY RUN (пробный запуск)"
fi
echo "================================================"

RSYNC_ARGS=(
    -avz
    --info=progress2
    -e "ssh -p $SERVER_PORT -o ConnectTimeout=10"
    --exclude 'venv/'
    --exclude '.venv/'
    --exclude '__pycache__/'
    --exclude '*.pyc'
    --exclude '.git/'
    --exclude 'temp_audio/'
    --exclude '.tmp*'
    --exclude '*.log'
    --exclude '.DS_Store'
    --exclude '*.db'
    --exclude '*.db-journal'
    --exclude '*.db-wal'
    --exclude '*.db-shm'
    --exclude 'puuk.db'
)

if [ "$DO_DELETE" = true ]; then
    RSYNC_ARGS+=(--delete)
fi

if [ "$DRY_RUN" = true ]; then
    RSYNC_ARGS+=(-n)
fi

echo "📦 Синхронизация файлов brain..."
rsync "${RSYNC_ARGS[@]}" "$LOCAL_DIR" "$SERVER_USER@$SERVER_IP:$REMOTE_DIR"

BOT_LOCAL_DIR="${SCRIPT_DIR}/../tg_music_bot/"
if [ -d "$BOT_LOCAL_DIR" ]; then
    BOT_REMOTE_DIR="$(dirname "${REMOTE_DIR%/}")/tg_music_bot/"
    echo ""
    echo "🤖 Синхронизация Telegram-бота ($BOT_LOCAL_DIR -> $BOT_REMOTE_DIR)..."
    BOT_RSYNC_ARGS=(
        -avz
        --info=progress2
        -e "ssh -p $SERVER_PORT -o ConnectTimeout=10"
        --exclude 'venv/'
        --exclude '.venv/'
        --exclude '__pycache__/'
        --exclude '*.pyc'
        --exclude '.env'
    )
    rsync "${BOT_RSYNC_ARGS[@]}" "$BOT_LOCAL_DIR" "$SERVER_USER@$SERVER_IP:$BOT_REMOTE_DIR"
    
    if [ "$DRY_RUN" = false ]; then
        echo "🔄 Перезапуск Telegram-бота..."
        ssh -p "$SERVER_PORT" "$SERVER_USER@$SERVER_IP" 'kill $(pgrep -f "[t]g_music_bot/venv/bin/python bot.py") 2>/dev/null || true'
    fi
fi

echo "✅ Синхронизация завершена успешно!"

# Установка зависимостей на сервере при флаге --install
if [ "$DO_INSTALL" = true ] && [ "$DRY_RUN" = false ]; then
    echo ""
    echo "🔧 Установка зависимостей на сервере..."
    ssh -p "$SERVER_PORT" "$SERVER_USER@$SERVER_IP" bash -c "'
        set -e
        cd \"$REMOTE_DIR\"
        if [ ! -d \"venv\" ]; then
            echo \"Создание виртуального окружения venv...\"
            python3 -m venv venv
        fi
        echo \"Обновление pip и установка requirements.txt...\"
        ./venv/bin/pip install --upgrade pip
        ./venv/bin/pip install -r requirements.txt
        echo \"Зависимости brain успешно установлены!\"

        BOT_DIR=\"\$(dirname \"${REMOTE_DIR%/}\")/tg_music_bot\"
        if [ -d \"\$BOT_DIR\" ] && [ -f \"\$BOT_DIR/requirements.txt\" ]; then
            echo \"Обновление зависимостей tg_music_bot...\"
            if [ ! -d \"\$BOT_DIR/venv\" ]; then
                python3 -m venv \"\$BOT_DIR/venv\"
            fi
            \"\$BOT_DIR/venv/bin/pip\" install --upgrade pip
            \"\$BOT_DIR/venv/bin/pip\" install -r \"\$BOT_DIR/requirements.txt\"
            echo \"Зависимости tg_music_bot успешно установлены!\"
        fi
    '"
fi

echo ""
echo "------------------------------------------------"
echo "📋 Команды для запуска на сервере:"
echo "ssh -p $SERVER_PORT $SERVER_USER@$SERVER_IP"
echo "cd $REMOTE_DIR"
echo ""
echo "# Запуск API бэкенда (порт 8000):"
echo "source venv/bin/activate && python api.py"
echo ""
echo "# Запуск фонового сканера треков:"
echo "source venv/bin/activate && python scan.py"
echo "------------------------------------------------"
