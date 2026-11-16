acceptance-silence.mp3 is five seconds of locally generated silence, with no
sampled recording or user metadata. Its exact bytes are pinned by the closed
fixture helper:

81127 bytes; SHA-256 c7ae4cf635c5742e03e2647322cc268432198c011cfd8ab8ffccfc57bacddb86.

It was generated with:

```sh
ffmpeg -hide_banner -loglevel error -f lavfi -i anullsrc=r=44100:cl=stereo \
  -t 5 -c:a libmp3lame -b:a 128k acceptance-silence.mp3
```

Encoder versions can produce different byte hashes. Copy this reviewed artifact
to /home/fish/puuk-cdn-setup/acceptance-silence.mp3 for the recorded acceptance
run; do not substitute an existing recording or change the helper's hash to
accept an unknown file.
