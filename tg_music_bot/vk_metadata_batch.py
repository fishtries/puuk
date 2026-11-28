"""Durable, single-worker metadata refresh for imported VK collections."""
import asyncio
from collections import Counter
import json
import logging
from pathlib import Path
import secrets
import sqlite3
from tempfile import TemporaryDirectory
import time

from aiogram.exceptions import TelegramAPIError

from services import telegram_import_service as catalog
from release_metadata import vk_release_request


logger = logging.getLogger(__name__)
SEARCH_INTERVAL = 3.0


class VkMetadataBatch:
    def __init__(self, jobs, root, linked_owner, run_child, slots, notify):
        self.jobs = jobs
        self.root = root
        self.linked_owner = linked_owner
        self.run_child = run_child
        self.slots = slots
        self.notify = notify
        self.release_cover_url = None
        self.next_search = 0.0

    @staticmethod
    def positions(job, rows):
        if job['kind'] not in {'album', 'playlist'} or job['mode'] != 'server' or job['state'] != 'finished':
            return []
        seen = set()
        positions = []
        for row in rows:
            track_id = row['track_id']
            if row['state'] == 'done' and track_id and track_id not in seen:
                source = json.loads(row['source'])
                if source.get('type') == 'vk' and source.get('key', '').startswith('vk:track:'):
                    seen.add(track_id)
                    positions.append(row['position'])
        return positions

    async def run(self):
        with TemporaryDirectory(prefix='vk-release-cover-', dir=self.root) as directory:
            await self._run(Path(directory))

    async def _run(self, cover_directory):
        last_update = {}
        while True:
            entry = self.jobs.next_metadata_entry()
            if not entry:
                await asyncio.sleep(0.7)
                continue
            job_id = entry['job_id']
            async with self.slots:
                try:
                    state, editions = await self._process(entry, cover_directory)
                except (OSError, ValueError, RuntimeError, sqlite3.Error) as exc:
                    logger.warning('VK metadata batch %s position %s: %s',
                                   job_id, entry['position'], type(exc).__name__)
                    state, editions = 'failed', None
            self.jobs.finish_metadata_entry(job_id, entry['position'], state, editions)
            counts = Counter(row['state'] for row in self.jobs.metadata_entries(job_id))
            now = time.monotonic()
            if counts['pending'] and now - last_update.get(job_id, 0) < 3:
                continue
            if counts['pending']:
                last_update[job_id] = now
            else:
                last_update.pop(job_id, None)
            try:
                async with asyncio.timeout(10):
                    await self.notify(job_id)
            except (TelegramAPIError, OSError) as exc:
                logger.info('VK metadata batch %s status: %s', job_id, type(exc).__name__)

    async def _release_editions(self, job, rows, directory):
        batch = self.jobs.metadata_batch(job['id'])
        if batch['release_editions'] is not None:
            return json.loads(batch['release_editions'])
        request = vk_release_request(job['title'] or '', [
            {**json.loads(row['source']), 'position': row['position']}
            for row in rows if row['state'] == 'done'
        ]) if all(row['state'] == 'done' for row in rows) else None
        editions = {}
        if request:
            try:
                editions = await self.run_child('vk-release', directory, request, 38)
            except (OSError, RuntimeError, ValueError) as exc:
                logger.info('VK collection %s release lookup: %s', job['id'], type(exc).__name__)
        self.jobs.save_metadata_release(job['id'], editions)
        return editions

    async def _cover(self, edition, directory, cover_directory):
        if edition['source'] != 'MusicBrainz':
            return await self.run_child('catalog-cover', directory, edition, 16)
        cover = cover_directory / 'import-cover'
        if self.release_cover_url == edition['cover_url'] and cover.is_file():
            return str(cover)
        cover.unlink(missing_ok=True)
        result = await self.run_child('catalog-cover', cover_directory, edition, 16)
        if result:
            self.release_cover_url = edition['cover_url']
        return result

    async def _process(self, entry, cover_directory):
        job = self.jobs.job(entry['job_id'])
        user = self.linked_owner(job['user_id'], job['owner_id']) if job else None
        if not user or job['state'] != 'finished' or job['mode'] != 'server':
            return 'failed', None
        rows = self.jobs.positions(job['id'])
        row = next((row for row in rows if row['position'] == entry['position'] and row['state'] == 'done'), None)
        if row is None:
            return 'failed', None
        source = json.loads(row['source'])
        track_id, source_key = row['track_id'], source.get('key', '')
        track = catalog.vk_metadata_target(user, track_id, source_key)
        if not track:
            return 'restricted', None

        with TemporaryDirectory(prefix='vk-batch-', dir=self.root) as directory:
            directory = Path(directory)
            if entry['editions']:
                selected, = json.loads(entry['editions'])
                edition, before = selected['edition'], selected['before']
            else:
                request = {'title': source['title'], 'artist': source.get('artist') or track['artist'],
                           'duration': track['duration']}
                release = await self._release_editions(job, rows, directory)
                edition = release.get(str(entry['position']))
                if edition:
                    editions = [edition]
                else:
                    await asyncio.sleep(max(0, self.next_search - time.monotonic()))
                    self.next_search = time.monotonic() + SEARCH_INTERVAL
                    editions = await self.run_child('vk-metadata', directory, request, 24)
                if not editions:
                    return 'no_match', None
                before = {field: track[field] for field in (*catalog.CATALOG_REVISION_FIELDS, 'duration')}
                if len(editions) > 1 or editions[0].get('confirm'):
                    return 'review', [{'token': secrets.randbits(63), 'edition': item, 'before': before}
                                      for item in editions]
                edition = editions[0]
            cover = await self._cover(edition, directory, cover_directory)
            if not cover:
                return 'failed', None
            user = self.linked_owner(job['user_id'], job['owner_id'])
            if not user:
                return 'restricted', None
            keep_album = job['kind'] == 'album' or track['album_track_position'] is not None
            saved = await asyncio.to_thread(catalog.update_vk_metadata, user, track_id, source_key, before, edition,
                                            cover, keep_album=keep_album)
            return ('updated' if saved else 'failed'), None
