import os
from qdrant_client import QdrantClient
from qdrant_client.models import RecommendQuery, RecommendInput
SERVER_IP = os.getenv("SERVER_IP", "192.168.1.117")
client = QdrantClient(url=f"http://{SERVER_IP}:6333")

records, _ = client.scroll(collection_name="tracks", limit=3, with_vectors=True, with_payload=True)
if not records:
    print("No records found.")
else:
    for i, r in enumerate(records):
        print(f"Track {i}: {r.payload.get('file_path')}")
        v = r.vector
        print(f"  Vector dim: {len(v) if v else 'None'}")
        if v:
            print(f"  Vector stats: min={min(v):.4f}, max={max(v):.4f}, mean={sum(v)/len(v):.4f}")

    # check distance between track 0 and others
    print("\nSimilarity to Track 0:")
    results = client.query_points(
        collection_name="tracks",
        query=records[0].id,
        limit=5,
        with_payload=True
    )
    for p in results.points:
        print(f"  Score: {p.score:.4f} -> {p.payload.get('file_path')}")
