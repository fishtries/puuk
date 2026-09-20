from qdrant_client import QdrantClient
from qdrant_client.models import RecommendQuery, RecommendInput
import sys

client = QdrantClient("http://192.168.1.117:6333")
res = client.scroll(collection_name="tracks", limit=300, with_payload=True, with_vectors=False)
target_id = None
base_bpm = None
for pt in res[0]:
    if "Feel It Still" in pt.payload.get("file_path", ""):
        target_id = pt.id
        base_bpm = pt.payload.get("bpm")
        break

results = client.query_points(
    collection_name="tracks",
    query=RecommendQuery(recommend=RecommendInput(positive=[target_id], negative=[])),
    limit=50,
    with_payload=True,
)

scored = []
for p in results.points:
    t_bpm = p.payload.get("bpm", base_bpm)
    if t_bpm == 0: t_bpm = base_bpm
    diff1 = abs(t_bpm - base_bpm)
    diff2 = abs(t_bpm - base_bpm*2)
    diff3 = abs(t_bpm - base_bpm/2)
    bpm_diff = min(diff1, diff2, diff3)
    
    adjusted = p.score - (bpm_diff * 0.005)
    scored.append((adjusted, p.score, t_bpm, p.payload.get("file_path")))

scored.sort(key=lambda x: x[0], reverse=True)
for adj, orig, bpm, name in scored[:10]:
    print(f"Adj: {adj:.4f} | Orig: {orig:.4f} | BPM: {bpm:.1f} | Track: {name}")

