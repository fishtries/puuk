"""Каталог настроений («You'll like this») для генерации mood-плейлистов.

Каждое настроение задаётся seed-ключевыми словами, которые матчатся против
artist / title / genre / album треков из SQLite. По совпавшим трекам строится
mood-вектор (среднее CLAP-эмбеддингов) — см. services/mood_recommendation_service.py.
"""

MOODS: dict[str, dict] = {
    "chill": {
        "title": "Chill",
        "description": "Спокойная музыка для отдыха и перезагрузки",
        "seed_keywords": ["ambient", "chill", "downtempo", "lo-fi", "lofi", "acoustic", "mellow"],
    },
    "energetic": {
        "title": "Energy",
        "description": "Больше ритма и движения",
        "seed_keywords": ["dance", "edm", "house", "techno", "electro", "upbeat", "trance"],
    },
    "focus": {
        "title": "Focus",
        "description": "Музыка для концентрации и работы",
        "seed_keywords": ["instrumental", "classical", "piano", "study", "concentration", "minimal"],
    },
    "happy": {
        "title": "Happy",
        "description": "Яркая и жизнерадостная музыка",
        "seed_keywords": ["pop", "funk", "disco", "upbeat", "indie", "summer"],
    },
    "sad": {
        "title": "Melancholy",
        "description": "Грустные и меланхоличные композиции",
        "seed_keywords": ["sad", "melanchol", "ballad", "slow", "blues", "emotional"],
    },
    "night": {
        "title": "Night",
        "description": "Атмосфера позднего вечера",
        "seed_keywords": ["jazz", "night", "soul", "r&b", "rnb", "smooth", "nocturne"],
    },
}

DEFAULT_MOODS = ["chill", "energetic", "focus"]
