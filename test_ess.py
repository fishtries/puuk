import essentia.standard as es
import numpy as np

audio = np.random.randn(48000*30).astype(np.float32)

dissonance = es.Dissonance()(audio)
print("Dissonance:", dissonance)

key, scale, strength = es.KeyExtractor()(audio)
print(f"Key: {key}, Scale: {scale}, Strength: {strength}")

pitch = es.PitchSalience()(audio)
print("Pitch Salience:", pitch)
