# Provenance

Byte-copies of the repository audio placeholders (procedurally generated
original CC0 work — see `audio/AUDIO_DESIGN.md` v1.0 §"Placeholder notice"):

- `music/*.ogg` ← copied verbatim from `audio/music/*.ogg`
- `sfx/*.ogg`   ← copied verbatim from `audio/sfx/*.ogg`

Licensed recordings will land later under the SAME filenames (plus `.m4a`
AAC fallbacks with the same basenames). Re-copy from `audio/` when they do;
never rename these files — the loader resolves `basename + extension`
(see `client/src/audio/files.ts`).
