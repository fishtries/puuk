"""
Word-level Karaoke (Enhanced LRC) Generator using faster-whisper.
Utilizes Whisper large-v3-turbo on CUDA with word-level timestamps.
"""

import os
import sys
import ctypes
import logging
from typing import Optional

logger = logging.getLogger(__name__)

# Preload NVIDIA CUDA 13 / cuDNN libraries into global symbol table
_site_packages = os.path.join(os.path.dirname(__file__), "venv", "lib", f"python{sys.version_info.major}.{sys.version_info.minor}", "site-packages")
_cu13_dir = os.path.join(_site_packages, "nvidia", "cu13", "lib")
_cudnn_dir = os.path.join(_site_packages, "nvidia", "cudnn", "lib")

for _lib_path in [
    os.path.join(_cu13_dir, "libcublasLt.so.13"),
    os.path.join(_cu13_dir, "libcublas.so.13"),
    os.path.join(_cudnn_dir, "libcudnn.so.9"),
    os.path.join(_cudnn_dir, "libcudnn_ops.so.9"),
    os.path.join(_cudnn_dir, "libcudnn_cnn.so.9"),
]:
    if os.path.isfile(_lib_path):
        try:
            ctypes.CDLL(_lib_path, mode=ctypes.RTLD_GLOBAL)
        except Exception as _e:
            logger.debug(f"Could not preload {_lib_path}: {_e}")

_model = None

def get_whisper_model():
    """
    Returns a cached singleton instance of WhisperModel.
    Uses large-v3-turbo with float16 precision on CUDA.
    """
    global _model
    if _model is None:
        try:
            from faster_whisper import WhisperModel
            import ctranslate2

            has_cuda = False
            try:
                has_cuda = ctranslate2.get_cuda_device_count() > 0
            except Exception:
                try:
                    import torch
                    has_cuda = torch.cuda.is_available()
                except Exception:
                    has_cuda = False

            device = "cuda" if has_cuda else "cpu"
            compute_type = "float16" if device == "cuda" else "int8"

            logger.info(f"Loading faster-whisper (large-v3-turbo) on {device} ({compute_type})...")
            cache_snapshot = os.path.expanduser("~/.cache/huggingface/hub/models--dropbox-dash--faster-whisper-large-v3-turbo/snapshots/0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf")
            if os.path.isdir(cache_snapshot) and os.path.isfile(os.path.join(cache_snapshot, "model.bin")):
                model_name_or_path = cache_snapshot
            else:
                model_name_or_path = "large-v3-turbo"

            try:
                _model = WhisperModel(model_name_or_path, device=device, compute_type=compute_type)
            except Exception as cuda_err:
                if device == "cuda":
                    logger.warning(f"Failed to load WhisperModel on CUDA ({cuda_err}), falling back to CPU (int8)...")
                    _model = WhisperModel(model_name_or_path, device="cpu", compute_type="int8")
                else:
                    raise

            logger.info("faster-whisper model loaded successfully.")
        except Exception as e:
            logger.error(f"Failed to initialize faster-whisper model: {e}", exc_info=True)
            raise
    return _model


def format_lrc_time(seconds: float) -> str:
    """
    Converts seconds (float) to strict LRC timestamp format: MM:SS.mmm
    Guarantees exactly 3 millisecond digits.
    
    Examples:
        format_lrc_time(12.34) -> "00:12.340"
        format_lrc_time(75.502) -> "01:15.502"
    """
    if seconds is None or seconds < 0:
        seconds = 0.0
    total_ms = int(round(seconds * 1000))
    ms = total_ms % 1000
    total_sec = total_ms // 1000
    sec = total_sec % 60
    minutes = total_sec // 60
    return f"{minutes:02d}:{sec:02d}.{ms:03d}"


def generate_word_level_lrc(audio_path: str, language: Optional[str] = None) -> str:
    """
    Generates Enhanced LRC with word-level timing from an audio file.
    
    Args:
        audio_path: Absolute or relative path to the audio file
        language: 'ru', 'en' or None (auto-detect)
        
    Returns:
        Enhanced LRC string in format:
        [MM:SS.mmm]<MM:SS.mmm>word1<MM:SS.mmm> <MM:SS.mmm>word2<MM:SS.mmm>
    """
    if not os.path.isfile(audio_path):
        raise FileNotFoundError(f"Audio file not found at: {audio_path}")
        
    model = get_whisper_model()
    
    transcribe_kwargs = {
        "beam_size": 5,
        "word_timestamps": True,
    }
    if language and language.lower() not in ("auto", "none"):
        transcribe_kwargs["language"] = language.lower()
        
    logger.info(f"Starting word-level transcription for: {audio_path} (language={language})")
    segments, info = model.transcribe(audio_path, **transcribe_kwargs)
    
    lrc_lines = []
    
    for segment in segments:
        line_start = format_lrc_time(segment.start)
        
        words = getattr(segment, "words", None)
        if words and len(words) > 0:
            word_tokens = []
            for w in words:
                clean_text = w.word.strip()
                if not clean_text:
                    continue
                w_start = format_lrc_time(w.start)
                w_end = format_lrc_time(w.end)
                word_tokens.append(f"<{w_start}>{clean_text}<{w_end}>")
            
            if word_tokens:
                line_content = " ".join(word_tokens)
                lrc_lines.append(f"[{line_start}]{line_content}")
            else:
                lrc_lines.append(f"[{line_start}]{segment.text.strip()}")
        else:
            text = segment.text.strip()
            if text:
                lrc_lines.append(f"[{line_start}]{text}")
                
    result_lrc = "\n".join(lrc_lines)
    logger.info(f"Generated {len(lrc_lines)} Enhanced LRC lines for {audio_path}")
    return result_lrc
