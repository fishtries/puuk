import essentia.standard as es
import numpy as np

audio = np.random.randn(48000*30).astype(np.float32)

# Dynamic Complexity
dc, loud = es.DynamicComplexity()(audio)
print(f"Dynamic Complexity: {dc}, Loudness: {loud}")

# Energy
energy = es.Energy()(audio)
print(f"Energy: {energy}")

# Danceability
dance, _ = es.Danceability()(audio)
print(f"Danceability: {dance}")

# Inharmonicity (requires spectral peaks, let's use ZeroCrossingRate)
zcr = es.ZeroCrossingRate()(audio)
print(f"ZCR: {zcr}")
