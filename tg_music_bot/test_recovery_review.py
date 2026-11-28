import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

from import_jobs import ImportJobs
from recovery_candidates import find_recovery_candidates
from recovery_review import RecoveryReview
from source_selection import Candidate


def test_recovery_prefers_matches_and_includes_labeled_alternatives(monkeypatch):
    same = Candidate('00000000001', 'Black Milk', ('Massive Attack',), 380)
    live = Candidate('00000000002', 'Black Milk (Live)', ('Massive Attack',), 381)
    cover = Candidate('00000000003', 'Black Milk', ('Someone Else',), 380)
    wrong_length = Candidate('00000000004', 'Black Milk', ('Massive Attack',), 250)
    unrelated = Candidate('00000000005', 'Black Coffee (Live)', ('Massive Attack',), 380)

    def soundcloud(_, *, observed):
        observed.extend([live, cover, wrong_length, unrelated, same, same])
        return [], []

    monkeypatch.setattr('recovery_candidates.find_soundcloud_candidates', soundcloud)
    monkeypatch.setattr('recovery_candidates.find_candidates', lambda *_, **__: ([], []))
    source = {'title': 'Black Milk', 'artist': 'Massive Attack', 'duration': 380}
    result = find_recovery_candidates(source)
    assert [(option['provider_id'], option['description']) for option in result['options']] == [
        (same.video_id, 'Подходит по названию, исполнителю и длительности'),
        (live.video_id, 'Другая версия'),
    ]
    assert find_recovery_candidates({**source, 'duration': None})['options'][0]['description'] == (
        'Совпадают название и исполнитель'
    )


def test_recovery_reuses_audio_and_queues_exact_position(tmp_path):
    async def verify():
        jobs = ImportJobs(tmp_path / 'queue.db')
        job_id, _ = jobs.submit(11, 1, 99, 20, {'url': 'album'}, 'server')
        jobs.set_message(job_id, 21)
        jobs.claim_snapshot()
        tracks = [{'title': title, 'artist': 'Artist'} for title in ('Ready', 'Missing', 'Still missing')]
        jobs.snapshot(job_id, 'Album', 'album', tracks)
        jobs.claim_position()
        jobs.downloaded(job_id, 1, {'sha256': 'ready'})
        jobs.delivered(job_id, 1, 'ready')
        for position in (2, 3):
            jobs.claim_position()
            jobs.skip(job_id, position, 'Точная версия не подтверждена')
        jobs.settle(job_id)

        options = [
            {'title': title, 'description': 'Другая версия', 'artist': 'Artist', 'duration': 185,
             'provider': 'youtube', 'provider_id': ident, 'key': f'youtube:{ident}',
             'url': f'https://www.youtube.com/watch?v={ident}'}
            for title, ident in [('Original', '00000000001'), ('Remaster', '00000000002')]
        ]

        async def child(action, directory, *_):
            if action == 'recovery-options':
                return {'options': options, 'unavailable': False}
            clip = directory / 'preview.mp3'
            clip.write_bytes(b'preview')
            return clip

        bot = AsyncMock()
        bot.send_audio.return_value = SimpleNamespace(message_id=22)
        dirty = set()
        review = RecoveryReview(bot, jobs, tmp_path, child, dirty.add, lambda *_: {'id': 1})
        callback = SimpleNamespace(message=SimpleNamespace(chat=SimpleNamespace(id=99), message_id=21),
                                   from_user=SimpleNamespace(id=11), answer=AsyncMock())
        await review.handle(callback, jobs.job(job_id), 'recover', 0)
        assert '02. Artist — Missing' in bot.send_audio.await_args.kwargs['caption']
        first_keyboard = bot.send_audio.await_args.kwargs['reply_markup'].inline_keyboard
        first_add = int(first_keyboard[0][0].callback_data.rsplit(':', 1)[1])
        next_token = int(first_keyboard[1][0].callback_data.rsplit(':', 1)[1])
        callback.message.message_id = 22

        await review.handle(callback, jobs.job(job_id), 'revnext', next_token)
        bot.send_audio.assert_awaited_once()
        assert bot.edit_message_media.await_args.kwargs['message_id'] == 22
        assert 'Remaster' in bot.edit_message_media.await_args.args[0].caption
        await review.handle(callback, jobs.job(job_id), 'revadd', first_add)
        assert jobs.positions(job_id)[1]['state'] == 'skipped'

        current = bot.edit_message_media.await_args.kwargs['reply_markup'].inline_keyboard
        new_add = int(current[0][0].callback_data.rsplit(':', 1)[1])
        await review.handle(callback, jobs.job(job_id), 'revadd', new_add)
        assert dirty == {job_id}
        assert [row['state'] for row in jobs.positions(job_id)] == ['done', 'pending', 'skipped']
        assert json.loads(jobs.positions(job_id)[1]['source'])['replacement']['candidate'] == options[1]
        assert 'Добавляю в позицию № 2' in bot.edit_message_caption.await_args.kwargs['caption']

        jobs.claim_position()
        jobs.downloaded(job_id, 2, {'sha256': 'selected'})
        jobs.delivered(job_id, 2, 'selected')
        follower = asyncio.create_task(review.run())
        try:
            async with asyncio.timeout(4):
                while '03. Artist — Still missing' not in bot.edit_message_media.await_args.args[0].caption:
                    await asyncio.sleep(.03)
        finally:
            follower.cancel()
            await asyncio.gather(follower, return_exceptions=True)
        buttons = bot.edit_message_media.await_args.kwargs['reply_markup'].inline_keyboard
        close = int(buttons[-1][-1].callback_data.rsplit(':', 1)[1])
        await review.handle(callback, jobs.job(job_id), 'revback', close)
        bot.delete_message.assert_awaited_once_with(99, 22)
        assert jobs.preview_message(99, 11) is None

    asyncio.run(verify())
