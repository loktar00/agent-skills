---
name: comfyui-audio
description: Generate sound effects and music on ComfyUI — Stable Audio for SFX/ambience and ACE-Step for songs. Verified node graphs, sampler settings, and the missing-text-encoder trap. Use when a project needs generated audio (weapon sounds, footsteps, ambience, stings, music beds); pairs with the `comfyui` engine skill.
---

# Audio generation on ComfyUI

Verified 2026-08-27 against ComfyUI 0.30.0. Engine mechanics (endpoints, polling, error reading) are
in the `comfyui` skill.

Two models, different jobs:
- **Stable Audio** (`stable_audio.safetensors`) — short sound effects and ambience. Verified below.
- **ACE-Step** (`ace_step_1.5_turbo_aio.safetensors`) — full songs with structure, via
  `TextEncodeAceStepAudio` / `TextEncodeAceStepAudio1.5`. Use for music beds, not SFX.

## The trap: the checkpoint has no text encoder

`CheckpointLoaderSimple("stable_audio.safetensors")` returns MODEL and VAE but **CLIP is None**:

```
ERROR: clip input is invalid: None
If the clip is from a checkpoint loader node your checkpoint does not contain a valid clip or text encoder model.
```

Load the encoder separately: `CLIPLoader(clip_name="t5_base.safetensors", type="stable_audio")`.
Take MODEL and VAE from the checkpoint, CLIP from the loader.

## Verified Stable Audio graph (API format)

```python
{
 "0": {"class_type":"CLIPLoader","inputs":{"clip_name":"t5_base.safetensors","type":"stable_audio"}},
 "1": {"class_type":"CheckpointLoaderSimple","inputs":{"ckpt_name":"stable_audio.safetensors"}},
 "2": {"class_type":"CLIPTextEncode","inputs":{"text":PROMPT,"clip":["0",0]}},
 "3": {"class_type":"CLIPTextEncode","inputs":{"text":"music, speech","clip":["0",0]}},  # negative
 "4": {"class_type":"EmptyLatentAudio","inputs":{"seconds":4.0,"batch_size":1}},
 "5": {"class_type":"KSampler","inputs":{"seed":SEED,"steps":50,"cfg":5.0,
        "sampler_name":"dpmpp_3m_sde_gpu","scheduler":"exponential","denoise":1.0,
        "model":["1",0],"positive":["2",0],"negative":["3",0],"latent_image":["4",0]}},
 "6": {"class_type":"VAEDecodeAudio","inputs":{"samples":["5",0],"vae":["1",2]}},
 "7": {"class_type":"SaveAudio","inputs":{"audio":["6",0],"filename_prefix":"sfx"}}
}
```

- MODEL is `["1",0]`, VAE is `["1",2]` (checkpoint outputs are MODEL/CLIP/VAE — index 1 is the dead CLIP).
- `EmptyLatentAudio.seconds` sets clip length (1.0–1000.0). Ask for slightly MORE than you need and
  trim — the tail often carries the useful decay.
- `SaveAudio` writes FLAC; `SaveAudioMP3` / `SaveAudioOpus` also exist. Artifacts come back under
  the `audio` key in `/history` outputs (not `images`).
- ~6 s for a 4 s clip on the reference box.

## Prompting for SFX

Describe the **source, the acoustic space, and the tail** — the space is what makes it sit in a game
mix. Put musical/vocal content in the negative, or Stable Audio drifts toward music.

| Need | Prompt shape |
|---|---|
| Weapon | `single loud bolt-action rifle gunshot, dry crack, snowy open field, distant echo tail` |
| Impact | `bullet impact on wood plank, sharp splintering thud, close mic, short tail` |
| Footstep | `single boot step crunching in deep snow, close mic, dry, no reverb` |
| Ambience | `cold winter wind through bare trees and ruined village, continuous, distant artillery rumble` |
| Sting | `low ominous brass swell, military drum hit, short, cinematic` |

Practical: generate 3-4 seeds per sound and pick — SFX quality varies more per-seed than images do.
Normalise and trim afterwards (`ffmpeg -af loudnorm`, or `silenceremove` for leading silence), and
convert to a web-friendly format for browser games:
`ffmpeg -i in.flac -c:a libopus -b:a 96k out.opus` (or `-c:a aac` for Safari-safe `.m4a`).

## ACE-Step (music)

Use `TextEncodeAceStepAudio` (tags + lyrics inputs) rather than `CLIPTextEncode`, with the
`ace_step_1.5_turbo_aio` checkpoint. Pull `GET /templates/` for the shipped ACE-Step template and
transcribe it per the `comfyui` discovery protocol before use — it is NOT verified in this skill.
