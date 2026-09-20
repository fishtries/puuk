import torch
from transformers import ClapModel, ClapProcessor
import numpy as np

processor = ClapProcessor.from_pretrained("laion/clap-htsat-fused")
model = ClapModel.from_pretrained("laion/clap-htsat-fused")

y = np.random.randn(48000 * 3)
inputs = processor(audio=y, sampling_rate=48000, return_tensors="pt")
with torch.no_grad():
    outputs = model.get_audio_features(**inputs)
    print("outputs type:", type(outputs))
    if hasattr(outputs, 'pooler_output'):
        print("pooler_output shape:", outputs.pooler_output.shape)
    elif hasattr(outputs, 'shape'):
        print("shape:", outputs.shape)
