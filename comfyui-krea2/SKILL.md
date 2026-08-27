---
name: comfyui-krea2
description: Generate images on ComfyUI with the Krea2 models (krea2_turbo, krea2_raw) — the exact verified node graph, sampler settings and the two traps that silently ruin output. Use when generating images, game textures, or reference art on ComfyUI and Krea2 is the chosen model; pairs with the `comfyui` engine skill.
---

# Krea2 on ComfyUI

Verified 2026-08-27 against ComfyUI 0.30.0. Engine mechanics (endpoints, polling, error reading)
are in the `comfyui` skill — this is the model adapter only.

## Krea2 is NOT a FLUX model

That assumption costs an hour. Krea2 uses a **12-layer Qwen3-VL text-encoder stack**
(12 × 2560 = 30720 conditioning features). Feeding it FLUX's T5+CLIP (4096) fails with:

```
Krea2 expects conditioning with 12x2560=30720 features (a 12-layer Qwen3-VL stack) but got 4096.
```

And it needs the **Qwen image VAE**, not FLUX's `ae.safetensors`. The wrong VAE does NOT error —
it decodes to flat mauve fabric-like mush that looks like a bad seed. If output is degenerate but
the job succeeded, check the VAE first.

## Verified graph (API format)

```python
UNET = "krea2_turbo_fp8_scaled.safetensors"   # or krea2_raw.safetensors (slower, higher fidelity)
CLIP = "qwen3vl_4b_fp8_scaled.safetensors"    # type MUST be "krea2"
VAE  = "qwen_image_vae.safetensors"           # NOT ae.safetensors

{
 "1": {"class_type":"UNETLoader",     "inputs":{"unet_name":UNET,"weight_dtype":"default"}},
 "2": {"class_type":"CLIPLoader",     "inputs":{"clip_name":CLIP,"type":"krea2"}},
 "3": {"class_type":"VAELoader",      "inputs":{"vae_name":VAE}},
 "4": {"class_type":"CLIPTextEncode", "inputs":{"text":PROMPT,"clip":["2",0]}},
 "5": {"class_type":"ConditioningZeroOut","inputs":{"conditioning":["4",0]}},   # negative
 "6": {"class_type":"EmptyLatentImage","inputs":{"width":1024,"height":1024,"batch_size":1}},
 "7": {"class_type":"KSampler","inputs":{"seed":SEED,"steps":8,"cfg":1.0,
        "sampler_name":"euler","scheduler":"simple","denoise":1.0,
        "model":["1",0],"positive":["4",0],"negative":["5",0],"latent_image":["6",0]}},
 "8": {"class_type":"VAEDecode","inputs":{"samples":["7",0],"vae":["3",0]}},
 "9": {"class_type":"SaveImage","inputs":{"filename_prefix":"out","images":["8",0]}}
}
```

Node choices that are NOT free to vary:
- `EmptyLatentImage` — **not** `EmptySD3LatentImage`.
- `ConditioningZeroOut` off the positive is the template's negative; an empty `CLIPTextEncode` also
  works but zero-out is what ships.
- Turbo wants **cfg 1.0 and ~8 steps** with `euler`/`simple`. Raising cfg on a turbo model degrades
  it; raising steps mostly wastes time.

## Performance

~6 s for 1024² at 8 steps on the reference box (~4 s at 768²). Cheap enough to iterate on prompts
and regenerate whole asset sets rather than fight one image.

## Optional style LoRA

`krea2_darkbrush.safetensors` at ~0.8 via `LoraLoaderModelOnly` between the UNET and the sampler
(`{"class_type":"LoraLoaderModelOnly","inputs":{"lora_name":...,"strength_model":0.8,"model":["1",0]}}`),
then point the sampler's `model` at it. Ships in the stock template, off by default.

## Prompting for game textures

State view, lighting and exclusions explicitly — the defaults bake in shadows and props that make a
texture unusable:

> `top-down seamless tileable texture of <material>, <era/context>, <surface detail>, <palette>, flat overcast light, no shadows, no objects, photographic`

Tiling is a post-process, not a model capability — generate, then offset-and-feather the seam.
Source of truth for all of the above: the stock `image_krea2_turbo_t2i` template, readable at
`GET /templates/image_krea2_turbo_t2i.json` (the real nodes are inside `definitions.subgraphs`).
