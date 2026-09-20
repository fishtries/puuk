import torch
from transformers import Wav2Vec2FeatureExtractor
import numpy as np

processor = Wav2Vec2FeatureExtractor.from_pretrained("m-a-p/MERT-v1-330M", trust_remote_code=True)
y = np.random.randn(4320000) # 3 mins of audio
inputs = processor(y, sampling_rate=24000, return_tensors="pt")
print("Input shape:", inputs["input_values"].shape)
