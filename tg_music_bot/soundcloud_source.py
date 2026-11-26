"""Keep recording facts that the stock yt-dlp SoundCloud adapter omits.

The extension is scoped to each YoutubeDL instance. It never patches installed
packages and preserves normal format/access checks performed by yt-dlp.
"""
from yt_dlp.extractor.soundcloud import SoundcloudIE, SoundcloudSearchIE


def publisher_fields(raw):
    publisher = raw.get('publisher_metadata') or {}
    user = raw.get('user') or {}
    explicit = publisher.get('explicit')
    return {
        'verified_uploader': user.get('username') if user.get('verified') is True else None,
        'explicit': explicit if isinstance(explicit, bool) else None,
        'publisher_artist': publisher.get('artist') if isinstance(publisher.get('artist'), str) else '',
        'publisher_album': publisher.get('album_title') if isinstance(publisher.get('album_title'), str) else '',
    }


class RecordingFields:
    def _extract_info_dict(self, info, *args, **kwargs):
        result = super()._extract_info_dict(info, *args, **kwargs)
        result.update(publisher_fields(info))
        return result


class RecordingSoundcloudIE(RecordingFields, SoundcloudIE):
    @classmethod
    def ie_key(cls):
        return SoundcloudIE.ie_key()


class RecordingSearchIE(RecordingFields, SoundcloudSearchIE):
    @classmethod
    def ie_key(cls):
        return SoundcloudSearchIE.ie_key()


def register(ydl):
    ydl.add_info_extractor(RecordingSoundcloudIE())
    ydl.add_info_extractor(RecordingSearchIE())
