"""Compress read-only catalog JSON without buffering or recompressing audio."""
import re
from starlette.middleware.gzip import GZipMiddleware

_CATALOG = re.compile(r'/api/(?:tracks|albums|artists|playlists)(?:/[^/]+)?\Z')
_LISTS = {'/api/history', '/api/favorites', '/api/library/tracks',
          '/api/recommendations/youll-like-this'}


class CatalogCompressionMiddleware:
    def __init__(self, app):
        self.app = app
        self.compressed = GZipMiddleware(app, minimum_size=1024, compresslevel=5)

    async def __call__(self, scope, receive, send):
        path = scope.get('path', '')
        selected = (scope['type'] == 'http' and scope.get('method') == 'GET'
                    and (path in _LISTS or _CATALOG.fullmatch(path)))
        await (self.compressed if selected else self.app)(scope, receive, send)
