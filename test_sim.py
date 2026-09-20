import torch
from transformers import AutoModel, Wav2Vec2FeatureExtractor
import librosa

processor = Wav2Vec2FeatureExtractor.from_pretrained("m-a-p/MERT-v1-330M", trust_remote_code=True)
model = AutoModel.from_pretrained("m-a-p/MERT-v1-330M", trust_remote_code=True)
model.eval()

def get_emb(path):
    y, sr = librosa.load(path, sr=24000, duration=30) # only 30 sec
    inputs = processor(y, sampling_rate=24000, return_tensors="pt")
    with torch.no_grad():
        out = model(**inputs)
    v = out.last_hidden_state.mean(dim=1)[0]
    return v

# Try 2 different tracks, see their similarity
import os
import glob
files = glob.glob(os.getenv("MUSIC_DIR", "/mnt/data/projects/puuk/music") + "/*.mp3")
v1 = get_emb(files[0])
v2 = get_emb(files[1])
cos = torch.nn.functional.cosine_similarity(v1.unsqueeze(0), v2.unsqueeze(0))
print(f"Similarity MERT 30s: {cos.item()}")
