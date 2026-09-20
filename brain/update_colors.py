import os
import io
from pathlib import Path
from qdrant_client import QdrantClient
from qdrant_client.models import PointStruct

client = QdrantClient(url="http://localhost:6333")
MUSIC_DIR = os.getenv("MUSIC_DIR", "/mnt/data/projects/puuk/music")

try:
    from mutagen.id3 import ID3, APIC
    from mutagen.mp4 import MP4
    from mutagen.flac import FLAC
    from colorthief import ColorThief
except ImportError:
    print("Missing packages")
    exit(1)

records, _ = client.scroll(collection_name="tracks", limit=10000, with_payload=True, with_vectors=False)
print(f"Found {len(records)} tracks.")

for r in records:
    if "cover_color" in r.payload:
        continue
        
    file_path = r.payload.get("file_path", "")
    if file_path and not file_path.startswith("/"):
        full_path = os.path.join(MUSIC_DIR, os.path.basename(file_path))
    else:
        full_path = file_path
        
    if not full_path or not os.path.isfile(full_path):
        continue
        
    ext = os.path.splitext(full_path)[1].lower()
    img_data = None
    
    try:
        if ext == ".mp3":
            tags = ID3(full_path)
            for tag in tags.values():
                if isinstance(tag, APIC):
                    img_data = tag.data
                    break
        elif ext in (".m4a", ".aac", ".mp4"):
            tags = MP4(full_path)
            covers = tags.get("covr", [])
            if covers:
                img_data = bytes(covers[0])
        elif ext == ".flac":
            tags = FLAC(full_path)
            if tags.pictures:
                img_data = tags.pictures[0].data
    except Exception as e:
        print(f"Error reading {file_path}: {e}")
        
    hex_color = "#1c1c1e"
    if img_data:
        try:
            with io.BytesIO(img_data) as f:
                color_thief = ColorThief(f)
                dominant_color = color_thief.get_color(quality=1)
                hex_color = '#%02x%02x%02x' % dominant_color
        except Exception as e:
            pass
            
    print(f"Updated {file_path} -> {hex_color}")
    
    payload = r.payload
    payload["cover_color"] = hex_color
    client.set_payload(
        collection_name="tracks",
        payload={"cover_color": hex_color},
        points=[r.id]
    )
    
print("Done!")
