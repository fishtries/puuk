These are deterministic byte fixtures for HTTP delivery and mutation tests, not
playable recordings. The .mp3 suffix exercises the existing MIME selection.

- sample_synthetic.mp3: bytes(range(256)) repeated 40 times.
- sample_replacement.mp3: bytes(255 - value for value in range(256)) repeated 40 times.
- tiny_synthetic.mp3: bytes(range(256)) once.

No original music is included. Tests that need a decodable recording generate
silence with ffmpeg in a disposable temporary directory instead.
