from qdrant_client import QdrantClient
import os

SERVER_IP = os.getenv("SERVER_IP", "192.168.1.117")
QDRANT_URL = os.getenv("QDRANT_URL", f"http://{SERVER_IP}:6333")
COLLECTION_NAME = "tracks"

client = QdrantClient(url=QDRANT_URL)

try:
    client.delete_collection(collection_name=COLLECTION_NAME)
    print(f"Collection '{COLLECTION_NAME}' successfully deleted.")
except Exception as e:
    print(f"Failed to delete collection: {e}")
