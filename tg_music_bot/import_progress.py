"""Download progress shared between the audio subprocess and its status card."""
import time


STAGES = {
    'search': 'Ищу нужную запись',
    'download': 'Скачиваю аудио',
    'check': 'Проверяю аудио',
    'prepare': 'Готовлю файл',
}


def progress_bar(percent):
    filled = percent // 10
    return f"{'█' * filled}{'░' * (10 - filled)} {percent}%"


def byte_percent(downloaded, total):
    if isinstance(total, (int, float)) and total > 0 and isinstance(downloaded, (int, float)):
        return max(0, min(100, int(downloaded * 100 / total)))
    return None


def ytdlp_progress(report):
    def hook(data):
        if data['status'] == 'downloading':
            total = data.get('total_bytes') or data.get('total_bytes_estimate')
            report('download', byte_percent(data.get('downloaded_bytes'), total))
        elif data['status'] == 'finished':
            report('check')
    return hook


def progress_reporter(path):
    last = None
    next_write = 0.0

    def report(stage, percent=None):
        nonlocal last, next_write
        now = time.monotonic()
        if last is not None and (stage, percent) == last:
            return
        if last is not None and stage == last[0] and now < next_write:
            return
        temporary = path.with_suffix('.tmp')
        try:
            temporary.write_text(f'{stage} {percent if percent is not None else "-"}')
            temporary.replace(path)
        except OSError:
            return
        last = stage, percent
        next_write = now + 0.5

    return report


def read_progress(path):
    try:
        stage, raw = path.read_text().split()
        percent = None if raw == '-' else int(raw)
        if stage in STAGES and (percent is None or 0 <= percent <= 100):
            return STAGES[stage], percent
    except (OSError, ValueError):
        pass
    return STAGES['search'], None
