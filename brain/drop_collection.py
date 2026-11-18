from qdrant_client import QdrantClient

from config import COLLECTION_NAME, QDRANT_CONNECTION

client = QdrantClient(**QDRANT_CONNECTION)

try:
    client.delete_collection(collection_name=COLLECTION_NAME)
    print(f"Collection '{COLLECTION_NAME}' successfully deleted.")
except Exception as e:
    print(f"Failed to delete collection: {e}")
