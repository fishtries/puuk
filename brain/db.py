"""Compatibility facade over repositories/.

Historical public API: `import db; db.<function>()`.
Every symbol is re-exported unchanged from domain repositories so that
callers (api, routers, services, bot, tests) keep working untouched.

New code should import from `repositories` directly.
"""
from repositories.base import get_connection
from repositories.schema import init_db, apply_migrations, _ensure_columns
from repositories.users import (
    create_user,
    get_user_by_id,
    get_user_by_username,
    get_user_by_telegram_id,
    update_user_password,
    link_user_telegram,
    list_users,
    delete_user,
    create_auth_code,
    verify_and_consume_auth_code,
)
from repositories.interactions import (
    add_favorite,
    remove_favorite,
    is_favorite,
    get_user_favorites,
    get_favorite_track_ids,
    add_history,
    get_user_history,
    add_dislike,
    remove_dislike,
    get_user_dislike_ids,
)
from repositories.albums import (
    get_all_albums,
    add_or_get_album,
    get_album_tracks,
)
from repositories.tracks import (
    get_all_tracks,
    get_track,
    search_tracks,
    search_all,
    add_or_update_track,
    update_track_cover_color,
    update_track_lyrics,
    update_track_lyrics_data,
    set_track_synced_reference,
    set_track_reference_search_status,
    update_track_metadata,
    update_track_metadata_from_audio,
    log_mutation_journal,
    update_mutation_journal,
    get_uncommitted_mutations,
)
from repositories.playlists import (
    get_all_playlists,
    create_playlist,
    get_playlist,
    get_playlist_tracks,
    add_track_to_playlist,
    remove_track_from_playlist,
    delete_playlist,
    update_playlist,
)
from repositories.lyrics_jobs import (
    set_lyrics_job,
    get_lyrics_job,
    delete_lyrics_job,
    get_next_pending_lyrics_job,
    get_pending_lyrics_jobs,
)
from repositories.wave import (
    get_user_embedding,
    set_user_embedding,
    get_user_embedding_metadata,
    add_wave_feedback,
    get_user_listening_history,
    get_recent_artists,
    update_track_stats,
    get_user_profile_stats,
    get_wave_stats_summary,
)

# init_db runs on import (historical behavior relied upon by bot/scripts).
init_db()
