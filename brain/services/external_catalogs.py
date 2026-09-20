"""External metadata providers: LRCLIB, syncedlyrics, iTunes, Deezer."""
import requests

LRCLIB_SEARCH_URL = "https://lrclib.net/api/search"
ITUNES_SEARCH_URL = "https://itunes.apple.com/search"
DEEZER_SEARCH_URL = "https://api.deezer.com/search"


def fetch_lrclib_by_track(title: str, artist: str, timeout: int = 5):
    """Возвращает сырой список результатов LRCLIB для пары track/artist."""
    res = requests.get(
        LRCLIB_SEARCH_URL,
        params={"track_name": title, "artist_name": artist},
        timeout=timeout
    )
    if res.status_code != 200:
        return []
    data = res.json()
    return data if isinstance(data, list) else []


def pick_first_synced_lrc(results: list) -> str | None:
    """Первый валидный synced LRC из выдачи LRCLIB."""
    for r in results:
        synced = r.get("syncedLyrics")
        if synced:
            return synced
    return None


def search_lyrics_providers(q: str) -> list:
    """Полнотекстовый поиск текстов: LRCLIB -> fallback syncedlyrics. Совместимый формат ответа."""
    if not q or not q.strip():
        return []
    clean_q = q.strip()
    results = []
    try:
        res = requests.get(
            LRCLIB_SEARCH_URL,
            params={"q": clean_q},
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                "Connection": "close",
                "Accept": "application/json",
            },
            timeout=8,
        )
        if res.status_code == 200:
            raw_list = res.json()
            if isinstance(raw_list, list):
                for item in raw_list:
                    track_name = item.get("trackName") or item.get("name") or ""
                    artist_name = item.get("artistName") or ""
                    album_name = item.get("albumName") or ""
                    synced = item.get("syncedLyrics") or ""
                    plain = item.get("plainLyrics") or ""
                    results.append({
                        "id": item.get("id"),
                        "track_name": track_name,
                        "artist_name": artist_name,
                        "album_name": album_name,
                        "duration": item.get("duration") or 0,
                        "synced_lyrics": synced,
                        "plain_lyrics": plain,
                        "trackName": track_name,
                        "artistName": artist_name,
                        "albumName": album_name,
                        "syncedLyrics": synced,
                        "plainLyrics": plain,
                    })
    except Exception as e:
        print("LRCLIB search error:", e)

    # Fallback to syncedlyrics library if LRCLIB returned nothing
    if not results:
        try:
            import syncedlyrics
            found = syncedlyrics.search(clean_q, synced_only=False)
            if found:
                results.append({
                    "id": 1,
                    "track_name": clean_q,
                    "artist_name": "",
                    "album_name": "",
                    "duration": 0,
                    "synced_lyrics": found if "[" in found else "",
                    "plain_lyrics": found if "[" not in found else "",
                    "trackName": clean_q,
                    "artistName": "",
                    "albumName": "",
                    "syncedLyrics": found if "[" in found else "",
                    "plainLyrics": found if "[" not in found else "",
                })
        except Exception as e:
            print("syncedlyrics fallback error:", e)

    return results


def search_metadata_providers(q: str) -> list:
    """Поиск метаданных (title, artist, album, year, artwork) из iTunes и Deezer."""
    if not q or not q.strip():
        return []

    results = []
    # 1. iTunes Search API
    try:
        res = requests.get(
            ITUNES_SEARCH_URL,
            params={"term": q.strip(), "entity": "song", "limit": 10},
            headers={"User-Agent": "Mozilla/5.0 (PuukMusic/1.0)"},
            timeout=8
        )
        if res.status_code == 200:
            for item in res.json().get("results", []):
                raw_art = item.get("artworkUrl100", "")
                cover_url = raw_art.replace("100x100bb", "1000x1000bb") if raw_art else ""
                year = item.get("releaseDate", "")[:4] if item.get("releaseDate") else ""
                genre = item.get("primaryGenreName", "")
                track_num = str(item.get("trackNumber", "")) if item.get("trackNumber") else ""
                disc_num = str(item.get("discNumber", "")) if item.get("discNumber") else ""
                results.append({
                    "title": item.get("trackName", ""),
                    "artist": item.get("artistName", ""),
                    "album": item.get("collectionName", ""),
                    "album_artist": item.get("artistName", ""),
                    "year": year,
                    "genre": genre,
                    "track_number": track_num,
                    "disc_number": disc_num,
                    "cover_url": cover_url,
                    "source": "iTunes"
                })
    except Exception as e:
        print("iTunes search error:", e)

    # 2. Deezer fallback if iTunes gave few results
    if len(results) < 3:
        try:
            res = requests.get(
                DEEZER_SEARCH_URL,
                params={"q": q.strip(), "limit": 8},
                headers={"User-Agent": "Mozilla/5.0 (PuukMusic/1.0)"},
                timeout=8
            )
            if res.status_code == 200:
                for item in res.json().get("data", []):
                    cover_url = item.get("album", {}).get("cover_xl") or item.get("album", {}).get("cover_big") or ""
                    results.append({
                        "title": item.get("title", ""),
                        "artist": item.get("artist", {}).get("name", ""),
                        "album": item.get("album", {}).get("title", ""),
                        "album_artist": item.get("artist", {}).get("name", ""),
                        "year": "",
                        "genre": "",
                        "track_number": "",
                        "disc_number": "",
                        "cover_url": cover_url,
                        "source": "Deezer"
                    })
        except Exception as e:
            print("Deezer search error:", e)

    return results
