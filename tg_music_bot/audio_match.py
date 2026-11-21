"""Compare a provider's reference excerpt at the original playback speed."""
from pathlib import Path
import subprocess
from urllib.parse import urlsplit

import numpy as np
import requests


SAMPLE_RATE = 8000
WINDOW = 4 * SAMPLE_RATE
MAX_PREVIEW_BYTES = 2 * 1024 * 1024


def fetch_spotify_preview(url: str, target: Path) -> None:
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or not (parsed.hostname or '').endswith('.scdn.co'):
        raise ValueError('Spotify не предоставил проверяемый фрагмент')
    with requests.get(url, timeout=(5, 12), stream=True, allow_redirects=False) as response:
        if response.status_code != 200:
            raise ValueError('Фрагмент Spotify недоступен')
        size = 0
        with target.open('wb') as output:
            for chunk in response.iter_content(65536):
                size += len(chunk)
                if size > MAX_PREVIEW_BYTES:
                    raise ValueError('Фрагмент Spotify слишком большой')
                output.write(chunk)


def _decode(path: Path, seconds: int) -> np.ndarray:
    pcm = subprocess.run(
        ['ffmpeg', '-v', 'error', '-nostdin', '-i', str(path), '-map', '0:a:0',
         '-t', str(seconds), '-ac', '1', '-ar', str(SAMPLE_RATE),
         '-af', 'highpass=f=80,lowpass=f=3200', '-f', 'f32le', '-'],
        check=True, capture_output=True, timeout=45,
    ).stdout
    return np.frombuffer(pcm, dtype='<f4').astype(np.float64)


def _alignment(signal: np.ndarray, excerpt: np.ndarray) -> tuple[int, float]:
    size = len(excerpt)
    excerpt = excerpt - excerpt.mean()
    norm = np.linalg.norm(excerpt)
    if norm <= 1e-6:
        return 0, 0.0
    fft_size = 1 << (len(signal) + size - 2).bit_length()
    spectrum = np.fft.rfft(signal, fft_size) * np.fft.rfft(excerpt[::-1], fft_size)
    numerator = np.fft.irfft(spectrum, fft_size)[size - 1:len(signal)]
    sums = np.concatenate(([0.0], np.cumsum(signal)))
    squares = np.concatenate(([0.0], np.cumsum(signal * signal)))
    energy = squares[size:] - squares[:-size] - (sums[size:] - sums[:-size]) ** 2 / size
    correlation = numerator / (norm * np.sqrt(np.maximum(energy, 1e-12)))
    offset = int(np.argmax(np.abs(correlation)))
    return offset, float(correlation[offset])


def matches_excerpt(reference: Path, candidate: Path, duration: float) -> bool:
    excerpt = _decode(reference, 60)
    signal = _decode(candidate, min(1800, int(duration) + 10))
    if len(excerpt) < 3 * WINDOW:
        raise ValueError('Фрагмент Spotify слишком короткий для сверки')
    if len(signal) < len(excerpt):
        return False
    starts = (0, (len(excerpt) - WINDOW) // 2, len(excerpt) - WINDOW)
    matches = [_alignment(signal, excerpt[start:start + WINDOW]) for start in starts]
    offsets = [offset - start for (offset, _), start in zip(matches, starts)]
    correlations = [score for _, score in matches]
    return (max(offsets) - min(offsets) <= SAMPLE_RATE * 0.05
            and (min(correlations) >= 0.80 or max(correlations) <= -0.80))
