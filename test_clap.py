from transformers import ClapModel, ClapProcessor
import torch
import numpy as np

processor = ClapProcessor.from_pretrained("laion/clap-htsat-unfused")
model = ClapModel.from_pretrained("laion/clap-htsat-unfused")

y = np.random.randn(48000 * 10)
inputs = processor(audios=y, return_tensors="pt", sampling_rate=48000)
with torch.no_grad():
    out = model.get_audio_features(**inputs)

print("Output shape:", out.shape)
print("Vector dim:", len(out[0].tolist()))
