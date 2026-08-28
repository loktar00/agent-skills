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

Five rules, each learned by getting it wrong on a full 26-texture set and A/B-ing the fix. They
matter more than the wording of any individual prompt.

### 1. Steps, not adjectives, produce detail
At **8 steps** this model returns soft uniform micro-weave — limestone that reads as knitting,
cobbles that read as mesh. At **20 steps** the same prompt returns real blocks with mortar joints.
If a texture looks characterless, raise steps before rewriting the prompt. 1024² at 20 steps is
~15 s; still cheap enough to regenerate a whole set.

### 2. NEVER phrase a prompt as a negation
Diffusion conditions on what you name. Observed, repeatedly:

| Prompt said | Output was |
|---|---|
| "absolutely no parallel lines or stripes" | a diagonal lattice |
| "no vertical streaks" | vertical streaks |
| "muted grey-brown NOT orange" | orange |

Say what you want instead. This applies to the old advice "no shadows, no objects" too — write
"flat even ambient lighting, uniform brightness edge to edge" and "continuous surface".

### 3. Describe the MATERIAL, not the object or the marks
The single highest-value rule; it fixed four textures that had each resisted three attempts.

| Asked for | Got | Asked for instead | Got |
|---|---|---|---|
| "ruts and boot prints crossing at many angles" | a woven lattice | "dirty compacted snow mixed with wet brown earth, irregular mottled patches" | a churned road |
| "beams with lime plaster between them" | a rigid grid | "rough dark oak timber boarding, wide aged planks" | timber (let geometry make beams) |
| "dense spruce needles" | whole snow-covered trees | "close-up surface of needles pressed together" | a needle mat |
| "wreck metal" | a grid of separate panels | "continuous surface of rusted sheet steel, unbroken panel" | corroded steel |

Naming a countable object gets you a tiling grid *of* that object.

### 4. Do NOT anchor physical scale
"A 3 metre wide area", "individual stones 20 cm across", "shot from 3 metres away" — tried across
eight textures, made every one *more* abstract, not less. Dropped. Rule 1 is the real lever.

### 5. An albedo is what a surface IS, never how it was lit
Ask for flat even lighting explicitly. A baked vignette is invisible at 1:1 and **quilts** the
moment it tiles — one generation returned plaster with a 4×4 grid of vignettes inside a single
1024² tile, which rendered as a padded cell across every wall. Score it by blurring the luminance
at several radii and measuring p95−p05; a single large radius cannot see a repeating vignette grid.

## Judge textures TILED, never at 1:1

Every defect above is invisible in the raw PNG and obvious the moment it repeats. Always render a
3×3 tiled contact sheet before accepting a set. This is not optional — it is the only honest view.

## Seams: cross-fade the edges, do not blur them

Do **not** offset by half and paint a blurred copy over the seam. It removes the seam and bakes a
**smeared grey cross into the tile**, which then repeats as a visible grid of lines across every
wall — worse than the seam it fixes, and it shipped in all 26 of our textures before anyone noticed.

Cross-fade the opposing edge bands instead, so the outer rows match exactly — seamless by
construction, no blur anywhere:

```python
def fade(a, axis, feather=0.18):     # a = HxWx3 float array
    n = a.shape[axis]; b = max(4, int(n * feather))
    t = np.linspace(0.5, 1.0, b, dtype=np.float32)       # 0.5 at the edge -> 1.0 inside
    t = t.reshape((b,1,1) if axis == 0 else (1,b,1))
    out = a.copy()
    if axis == 0:
        head, tail = a[:b], a[n-b:]
        out[:b] = head*t + tail*(1-t); out[n-b:] = tail*t[::-1] + head*(1-t[::-1])
    else:
        head, tail = a[:, :b], a[:, n-b:]
        out[:, :b] = head*t + tail*(1-t); out[:, n-b:] = tail*t[:, ::-1] + head*(1-t[:, ::-1])
    return out
img = fade(fade(img, 1), 0)
```

Prompting for fine even detail (rule 3) keeps the cross-fade ghosting invisible.

## Alpha cut-outs without a matting model

For foliage, wire or netting cards when the install has no rembg/BiRefNet/SAM: generate the subject
on **flat black**, then key alpha from luminance. **Unpremultiply the colour** (`rgb / alpha`) or
every edge pixel keeps a black fringe when composited.

## Record the prompt with the texture

Prompts that live only in shell history cannot be reproduced or improved — we had to re-author 26 of
them. Keep a prompt table in version control and mirror it into the asset manifest.

Source of truth for all of the above: the stock `image_krea2_turbo_t2i` template, readable at
`GET /templates/image_krea2_turbo_t2i.json` (the real nodes are inside `definitions.subgraphs`).
