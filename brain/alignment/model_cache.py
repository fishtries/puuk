"""Whisper model singleton: CUDA preloading, device selection, HF snapshot cache."""
import ctypes
import logging
import os
import sys

logger = logging.getLogger(__name__)

# Preload NVIDIA CUDA libraries so CTranslate2 finds libcublas.so on Linux
_site_packages = os.path.join(
    os.path.dirname(os.path.dirname(__file__)),
    "venv",
    "lib",
    f"python{sys.version_info.major}.{sys.version_info.minor}",
    "site-packages",
)
_cu13_dir = os.path.join(_site_packages, "nvidia", "cu13", "lib")
_cudnn_dir = os.path.join(_site_packages, "nvidia", "cudnn", "lib")

for _lib_path in [
    os.path.join(_cu13_dir, "libcublasLt.so.13"),
    os.path.join(_cu13_dir, "libcublas.so.13"),
    os.path.join(_cu13_dir, "libcublas.so.12"),
    os.path.join(_cudnn_dir, "libcudnn.so.9"),
    os.path.join(_cudnn_dir, "libcudnn_ops.so.9"),
    os.path.join(_cudnn_dir, "libcudnn_cnn.so.9"),
]:
    if os.path.isfile(_lib_path):
        try:
            ctypes.CDLL(_lib_path, mode=ctypes.RTLD_GLOBAL)
        except Exception as _e:
            logger.debug(f"Could not preload {_lib_path}: {_e}")

_existing_ld = os.environ.get("LD_LIBRARY_PATH", "")
_extra_paths = [p for p in [_cu13_dir, _cudnn_dir] if os.path.isdir(p)]
if _extra_paths:
    os.environ["LD_LIBRARY_PATH"] = ":".join(_extra_paths) + (f":{_existing_ld}" if _existing_ld else "")


# Global model cache for fast sequential requests
_whisper_model = None
_cached_model_name = None


def get_whisper_model(model_name: str = "large-v3-turbo"):
    """
    Returns cached instance of WhisperModel.
    """
    global _whisper_model, _cached_model_name
    if _whisper_model is None or _cached_model_name != model_name:
        from faster_whisper import WhisperModel
        import ctranslate2

        has_cuda = False
        try:
            has_cuda = ctranslate2.get_cuda_device_count() > 0
        except Exception:
            has_cuda = False

        device = "cuda" if has_cuda else "cpu"
        compute_type = "float16" if device == "cuda" else "int8"

        cache_snapshot = os.path.expanduser(
            "~/.cache/huggingface/hub/models--dropbox-dash--faster-whisper-large-v3-turbo/snapshots/0a363e9161cbc7ed1431c9597a8ceaf0c4f78fcf"
        )
        if model_name == "large-v3-turbo" and os.path.isdir(cache_snapshot) and os.path.isfile(os.path.join(cache_snapshot, "model.bin")):
            model_path = cache_snapshot
        else:
            model_path = model_name

        logger.info(f"Loading faster-whisper ({model_path}) on {device} ({compute_type})...")
        try:
            _whisper_model = WhisperModel(model_path, device=device, compute_type=compute_type)
            _cached_model_name = model_name
        except Exception as err:
            if device == "cuda":
                logger.warning(f"CUDA initialization failed ({err}), falling back to CPU (int8)...")
                _whisper_model = WhisperModel(model_path, device="cpu", compute_type="int8")
                _cached_model_name = model_name
            else:
                raise
        logger.info("faster-whisper model loaded successfully.")
    return _whisper_model
