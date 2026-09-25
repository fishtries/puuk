"""Модуль автоматической классификации жанров через Essentia Discogs-400.

Использует предобученную модель genre_discogs400-discogs-effnet-1 и
сопоставляет предсказания с каноническими жанрами каталога Puuk.
"""
import json
import logging
import os
from typing import Any, Dict, List, Optional

import numpy as np

from services.genre_normalization import normalize_genre

logger = logging.getLogger(__name__)

# Дефолтные пороги классификации
AUTO_GENRE_MIN_CONFIDENCE = float(os.getenv("AUTO_GENRE_MIN_CONFIDENCE", "0.20"))
AUTO_GENRE_TOP_K = int(os.getenv("AUTO_GENRE_TOP_K", "3"))


class AudioGenreClassifier:
    """Изолированный классификатор жанров на базе Essentia TensorflowPredict2D."""

    def __init__(
        self,
        model_path: Optional[str] = None,
        labels_path: Optional[str] = None,
        min_confidence: float = AUTO_GENRE_MIN_CONFIDENCE,
        top_k: int = AUTO_GENRE_TOP_K,
    ):
        self.min_confidence = min_confidence
        self.top_k = top_k
        self.labels: List[str] = []
        self.genre_model = None
        self.model_name = "genre_discogs400-discogs-effnet-1"

        if labels_path and os.path.exists(labels_path):
            try:
                with open(labels_path, "r", encoding="utf-8") as f:
                    meta = json.load(f)
                if isinstance(meta, dict) and "classes" in meta:
                    self.labels = meta["classes"]
                elif isinstance(meta, list):
                    self.labels = meta
                logger.info(f"Загружено {len(self.labels)} классов жанров из {labels_path}")
            except Exception as e:
                logger.error(f"Не удалось загрузить файл меток жанров {labels_path}: {e}")

        if model_path and os.path.exists(model_path):
            try:
                import essentia.standard as es
                self.genre_model = es.TensorflowPredict2D(
                    graphFilename=model_path,
                    input="serving_default_model_Placeholder",
                    output="PartitionedCall:0",
                )
                logger.info(f"Модель классификации жанров успешно загружена из {model_path}")
            except Exception as e:
                logger.error(f"Ошибка инициализации TensorflowPredict2D для {model_path}: {e}")
                self.genre_model = None

    def predict(self, embeddings: Any) -> List[Dict[str, Any]]:
        """Предсказывает top-k жанров для входных эмбеддингов трека.

        Принимает:
        - массив фреймовых эмбеддингов шейпа (N, 1280) или (1280,)
        - либо готовый массив предсказаний шейпа (N, 400) или (400,)

        Возвращает список словарей:
        [
            {"name": "Deep House", "confidence": 0.82},
            {"name": "House", "confidence": 0.64},
            ...
        ]
        """
        if embeddings is None:
            return []

        try:
            arr = np.asarray(embeddings, dtype=np.float32)
        except Exception as e:
            logger.warning(f"Не удалось преобразовать входные данные в numpy array: {e}")
            return []

        if arr.size == 0:
            return []

        if arr.ndim == 1:
            arr = np.expand_dims(arr, axis=0)

        if arr.ndim != 2:
            logger.warning(f"Неожиданная размерность эмбеддингов: {arr.shape}")
            return []

        # Защита от NaN / Inf во входных данных
        arr = np.nan_to_num(arr, nan=0.0, posinf=0.0, neginf=0.0)

        num_features = arr.shape[1]
        frame_predictions: Optional[np.ndarray] = None

        if num_features == 1280:
            if self.genre_model is None:
                logger.warning("Модель классификатора не инициализирована для 1280-мерных эмбеддингов")
                return []
            try:
                frame_predictions = self.genre_model(arr)
            except Exception as e:
                logger.error(f"Ошибка инференса классификатора жанров: {e}")
                return []
        elif num_features == 400:
            # На вход уже переданы предсказания (или 400-мерные вероятности)
            frame_predictions = arr
        else:
            logger.warning(f"Неожиданный размер признаков: {num_features} (ожидается 1280 или 400)")
            return []

        if frame_predictions is None or frame_predictions.size == 0:
            return []

        frame_predictions = np.nan_to_num(frame_predictions, nan=0.0, posinf=0.0, neginf=0.0)

        # Временная агрегация по всем патчам (фреймам) трека
        mean_scores = np.mean(frame_predictions, axis=0)
        if len(mean_scores) != len(self.labels):
            logger.warning(
                f"Несовпадение количества предсказаний ({len(mean_scores)}) и меток ({len(self.labels)})"
            )
            return []

        sorted_indices = np.argsort(mean_scores)[::-1]
        results: List[Dict[str, Any]] = []
        seen_names = set()

        for idx in sorted_indices:
            score = float(mean_scores[idx])
            if score < self.min_confidence:
                break

            raw_label = self.labels[idx]
            # Discogs-400 таксономия: "RootGenre---Subgenre"
            if "---" in raw_label:
                style_name = raw_label.split("---", 1)[1].strip()
            else:
                style_name = raw_label.strip()

            norm_name = normalize_genre(style_name)
            if not norm_name:
                continue

            key = norm_name.casefold()
            if key in seen_names:
                continue

            seen_names.add(key)
            results.append({
                "name": norm_name,
                "confidence": round(score, 4),
            })

            if len(results) >= self.top_k:
                break

        return results
