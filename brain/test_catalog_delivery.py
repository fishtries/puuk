"""Catalog transfer tests with generated artwork and no external services."""
import io
from pathlib import Path
import tempfile

from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.responses import JSONResponse, Response
from PIL import Image
from mutagen.id3 import ID3, APIC
from services.catalog_compression import CatalogCompressionMiddleware
from services.cover_extractor import extract_cover_preview


def test_catalog_compression_negotiates_and_preserves_audio_and_mutations():
    app = FastAPI()
    app.add_middleware(CatalogCompressionMiddleware)
    payload = {'tracks': ['generated track'] * 2000}
    @app.get('/api/tracks')
    def tracks():
        return JSONResponse(payload, headers={'Cache-Control': 'private, no-store'})
    @app.get('/api/stream/example')
    def stream():
        return Response(b'a' * 2000, media_type='audio/mpeg', headers={'Content-Range': 'bytes 0-1999/3000'}, status_code=206)
    @app.post('/api/tracks')
    def mutate():
        return payload
    with TestClient(app) as client:
        response = client.get('/api/tracks', headers={'Accept-Encoding': 'gzip'})
        assert response.json() == payload
        assert response.headers['Content-Encoding'] == 'gzip'
        assert int(response.headers['Content-Length']) < len(response.content) // 4
        assert response.headers['Cache-Control'] == 'private, no-store'
        assert 'Accept-Encoding' in response.headers['Vary']
        assert 'Content-Encoding' not in client.get('/api/tracks', headers={'Accept-Encoding': 'identity'}).headers
        audio = client.get('/api/stream/example')
        assert audio.status_code == 206 and audio.content == b'a' * 2000
        assert 'Content-Encoding' not in audio.headers
        assert 'Content-Encoding' not in client.post('/api/tracks').headers


def test_previews_are_small_and_invalidate_without_changing_source():
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / 'generated.mp3'
        def write(color):
            image = Image.new('RGB', (1600, 1200), color)
            output = io.BytesIO()
            image.save(output, 'PNG')
            tags = ID3()
            tags.add(APIC(mime='image/png', type=3, data=output.getvalue()))
            tags.save(path)
        write('red')
        before = path.read_bytes()
        data, mime = extract_cover_preview(str(path), 256, 1)
        assert mime == 'image/jpeg'
        with Image.open(io.BytesIO(data)) as image:
            assert image.size == (256, 192)
        assert path.read_bytes() == before
        assert extract_cover_preview(str(path), 256, 1)[0] == data
        write('blue')
        assert extract_cover_preview(str(path), 256, 1)[0] != data
