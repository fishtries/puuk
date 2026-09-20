import yt_dlp
import os

ydl_opts = {
    'format': 'bestaudio/best',
    'outtmpl': '%(title)s.%(ext)s',
    'writethumbnail': True,
    'postprocessors': [
        {
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'mp3',
            'preferredquality': '320',
        },
        {
            'key': 'EmbedThumbnail',
        },
        {
            'key': 'FFmpegMetadata',
        }
    ],
    'quiet': False,
}
with yt_dlp.YoutubeDL(ydl_opts) as ydl:
    ydl.extract_info("https://soundcloud.com/octobersveryown/drake-0-to-100", download=True)
