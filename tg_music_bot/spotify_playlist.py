"""Read playlist pages as Spotify's public guest player loads them."""
import base64
import json
import time
from urllib.parse import parse_qs, urlsplit

from music_browser import music_browser


INCOMPLETE = 'Spotify не показал полный список. Можно прислать ссылки на отдельные треки.'
_TRACK_ROWS = '[data-testid="tracklist-row"]'


def _pages(browser, uri, pending):
    from selenium.common.exceptions import WebDriverException

    for entry in browser.get_log('performance'):
        event = json.loads(entry['message'])['message']
        method, params = event['method'], event['params']
        if method == 'Network.requestWillBeSent':
            request = params['request']
            url = urlsplit(request['url'])
            if (url.scheme, url.netloc, url.path) != ('https', 'api-partner.spotify.com', '/pathfinder/v2/query'):
                continue
            try:
                if post_data := request.get('postData'):
                    query = json.loads(post_data)
                else:
                    fields = parse_qs(url.query)
                    query = {'operationName': fields.get('operationName', [''])[0],
                             'variables': json.loads(fields.get('variables', ['{}'])[0])}
            except ValueError:
                continue
            variables = query.get('variables') or {}
            if (query.get('operationName') in {'fetchPlaylist', 'fetchPlaylistContents'}
                    and variables.get('uri') == uri):
                pending[params['requestId']] = variables.get('offset')
        elif method == 'Network.loadingFinished' and params['requestId'] in pending:
            offset = pending.pop(params['requestId'])
            try:
                response = browser.execute_cdp_cmd('Network.getResponseBody', {'requestId': params['requestId']})
                body = base64.b64decode(response['body']) if response.get('base64Encoded') else response['body']
                data = json.loads(body)
            except (WebDriverException, ValueError):
                continue
            playlist = (data.get('data') or {}).get('playlistV2') or {}
            if playlist.get('__typename') == 'Playlist':
                yield offset, playlist


def read_public_playlist(ident, max_positions):
    uri = f'spotify:playlist:{ident}'
    pending, rows = {}, {}
    total = None
    metadata = None
    with music_browser('Spotify') as browser:
        browser.execute_cdp_cmd('Network.enable', {'maxTotalBufferSize': 16 * 1024 * 1024,
                                                   'maxResourceBufferSize': 2 * 1024 * 1024,
                                                   'maxPostDataSize': 4096})
        browser.get(f'https://open.spotify.com/playlist/{ident}')
        deadline = time.monotonic() + 90
        progress_deadline = time.monotonic() + 15
        last_position = 0
        while time.monotonic() < min(deadline, progress_deadline):
            for offset, playlist in _pages(browser, uri, pending):
                content = playlist.get('content') or {}
                count, items = content.get('totalCount'), content.get('items')
                if type(count) is int and count > max_positions:
                    raise ValueError(f'В Puuk можно импортировать до {max_positions} позиций из одного плейлиста')
                if (type(count) is not int or count <= 0 or (total is not None and count != total)
                        or type(offset) is not int or offset < 0
                        or (content.get('pagingInfo') or {}).get('offset') != offset
                        or not isinstance(items, list) or not items or offset + len(items) > count):
                    raise ValueError(INCOMPLETE)
                total = count
                if playlist.get('uri') == uri and playlist.get('name'):
                    if metadata and metadata.get('revisionId') != playlist.get('revisionId'):
                        raise ValueError(INCOMPLETE)
                    metadata = playlist
                for position, item in enumerate(items, offset):
                    previous = rows.get(position)
                    if previous is None:
                        rows[position] = item
                        progress_deadline = time.monotonic() + 12
                    elif previous != item:
                        raise ValueError(INCOMPLETE)

            if metadata and len(rows) == total:
                ordered = [rows[position] for position in range(total)]
                uids = [item.get('uid') for item in ordered]
                if not all(isinstance(uid, str) and uid for uid in uids) or len(set(uids)) != total:
                    raise ValueError(INCOMPLETE)
                return metadata, ordered

            # Scroll the currently rendered rows so the guest player loads the next page.
            position = browser.execute_script("""
                const rows = document.querySelectorAll(arguments[0]);
                const last = rows[rows.length - 1];
                last?.scrollIntoView({block: 'end'});
                return Number(last?.closest('[aria-rowindex]')?.getAttribute('aria-rowindex') || 0);
            """, _TRACK_ROWS)
            if position > last_position:
                last_position = position
                progress_deadline = time.monotonic() + 12
            time.sleep(0.35)
    raise ValueError(INCOMPLETE)
