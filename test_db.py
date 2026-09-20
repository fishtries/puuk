from qdrant_client import QdrantClient
from qdrant_client.http.models import Filter, FieldCondition, MatchValue

client = QdrantClient("http://192.168.1.117:6333")
unprocessed = client.count(collection_name="tracks", count_filter=Filter(must=[FieldCondition(key="needs_embedding", match=MatchValue(value=True))]))
processed = client.count(collection_name="tracks", count_filter=Filter(must=[FieldCondition(key="needs_embedding", match=MatchValue(value=False))]))
print(f"Unprocessed: {unprocessed.count}, Processed: {processed.count}")
