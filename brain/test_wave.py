import os
from qdrant_client import QdrantClient

# --- Конфигурация ---
SERVER_IP = os.getenv("SERVER_IP", "192.168.1.117")
QDRANT_URL = os.getenv("QDRANT_URL", f"http://192.168.1.117:6333")
COLLECTION_NAME = "tracks"

# ID целевого трека. В scan.py используются UUID-строки,
# поэтому берём первый доступный трек через scroll.
# Можно подставить конкретный UUID, если знаешь его.
TARGET_ID = None  # будет определён автоматически ниже

def main():
    client = QdrantClient(url=QDRANT_URL)

    # Если TARGET_ID не задан, берём первый трек из коллекции
    if TARGET_ID is None:
        records, _ = client.scroll(
            collection_name=COLLECTION_NAME,
            limit=1,
            with_payload=True,
            with_vectors=False,
        )
        if not records:
            print("❌ Коллекция пуста. Сначала запусти scan.py и heavy_worker.py.")
            return
        target = records[0]
        target_id = target.id
    else:
        results = client.retrieve(
            collection_name=COLLECTION_NAME,
            ids=[TARGET_ID],
            with_payload=True,
        )
        if not results:
            print(f"❌ Трек с ID={TARGET_ID} не найден в коллекции.")
            return
        target = results[0]
        target_id = target.id

    target_path = target.payload.get("file_path", "???")
    target_bpm = target.payload.get("bpm", "???")

    print(f"\n🎵 Ищем треки, похожие на: {target_path} (BPM: {target_bpm})\n")

    # Поиск похожих треков через query_points (recommend)
    from qdrant_client.models import RecommendQuery, RecommendInput
    results = client.query_points(
        collection_name=COLLECTION_NAME,
        query=RecommendQuery(recommend=RecommendInput(positive=[target_id], negative=[])),
        limit=5,
        with_payload=True,
    )
    recommendations = results.points

    if not recommendations:
        print("😕 Похожих треков не найдено.")
        return

    print("=" * 60)
    print("  🌊 Моя волна — Топ-5 похожих треков")
    print("=" * 60)

    for i, rec in enumerate(recommendations, start=1):
        score = round(rec.score, 3)
        path = rec.payload.get("file_path", "???")
        bpm = rec.payload.get("bpm", "???")
        print(f"  {i}. [{score:.3f}] {path}  (BPM: {bpm})")

    print("=" * 60)
    print()

if __name__ == "__main__":
    main()
