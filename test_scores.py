from qdrant_client import QdrantClient
from qdrant_client.models import RecommendQuery, RecommendInput
import sys

client = QdrantClient("http://192.168.1.117:6333")

res = client.scroll(
    collection_name="tracks",
    limit=300,
    with_payload=True,
    with_vectors=False
)
target_id = None
base_bpm = None
for pt in res[0]:
    if "Feel It Still" in pt.payload.get("file_path", ""):
        target_id = pt.id
        base_bpm = pt.payload.get("bpm")
        break

print(f"Target ID: {target_id}, BPM: {base_bpm}")

results = client.query_points(
    collection_name="tracks",
    query=RecommendQuery(
        recommend=RecommendInput(positive=[target_id], negative=[])
    ),
    limit=10,
    with_payload=True,
)

for p in results.points:
    print(f"Score: {p.score:.4f} | BPM: {p.payload.get('bpm'):.1f} | Track: {p.payload.get('file_path')}")

