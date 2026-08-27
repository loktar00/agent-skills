#!/usr/bin/env python3
"""Generate game textures on the local ComfyUI box (krea2_turbo, FLUX family) and save them into
assets/textures/. Optionally makes them seam-free with an offset-blend pass.

Usage:
  python tools/comfy_gen.py --name snow_ground --prompt "..." [--size 1024] [--steps 8] [--tile]
  python tools/comfy_gen.py --batch textures.json
"""
import argparse
import io
import json
import pathlib
import time
import urllib.parse
import urllib.request

HOST = "http://192.168.1.182:8188"
ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "assets" / "textures"

UNET = "krea2_turbo_fp8_scaled.safetensors"
# Krea2 is NOT FLUX-family: it wants a 12-layer Qwen3-VL stack (12 x 2560 = 30720 features),
# loaded through CLIPLoader with type "krea2". T5+CLIP (4096) is rejected by the sampler.
CLIP = "qwen3vl_4b_fp8_scaled.safetensors"
CLIP_TYPE = "krea2"
VAE = "qwen_image_vae.safetensors"   # per the image_krea2_turbo_t2i template; FLUX's ae.safetensors yields mush


def graph(prompt, size, steps, seed, cfg=1.0):
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": UNET, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": CLIP, "type": CLIP_TYPE}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VAE}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 0]}},
        "5": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["4", 0]}},
        "6": {"class_type": "EmptyLatentImage",
              "inputs": {"width": size, "height": size, "batch_size": 1}},
        "7": {"class_type": "KSampler",
              "inputs": {"seed": seed, "steps": steps, "cfg": cfg, "sampler_name": "euler",
                         "scheduler": "simple", "denoise": 1.0, "model": ["1", 0],
                         "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["6", 0]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "foy", "images": ["8", 0]}},
    }


def post(path, payload):
    req = urllib.request.Request(HOST + path, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=60))


def generate(name, prompt, size=1024, steps=8, seed=None, tile=False, timeout=600):
    seed = seed if seed is not None else abs(hash(name)) % (2**31)
    pid = post("/prompt", {"prompt": graph(prompt, size, steps, seed)})["prompt_id"]
    t0 = time.time()
    while time.time() - t0 < timeout:
        h = json.load(urllib.request.urlopen(f"{HOST}/history/{pid}", timeout=30))
        if pid in h:
            outs = h[pid].get("outputs", {})
            imgs = [i for v in outs.values() for i in v.get("images", [])]
            if not imgs:
                raise SystemExit(f"{name}: finished with no image: {json.dumps(h[pid])[:300]}")
            im = imgs[0]
            q = urllib.parse.urlencode({"filename": im["filename"], "subfolder": im.get("subfolder", ""),
                                        "type": im.get("type", "output")})
            data = urllib.request.urlopen(f"{HOST}/view?{q}", timeout=120).read()
            OUT.mkdir(parents=True, exist_ok=True)
            dest = OUT / f"{name}.png"
            if tile:
                data = make_seamless(data)
            dest.write_bytes(data)
            return dest, round(time.time() - t0, 1)
        time.sleep(2)
    raise SystemExit(f"{name}: timed out after {timeout}s")


def make_seamless(png_bytes):
    """Offset by half, then feather the cross seam so the texture tiles without a visible edge."""
    from PIL import Image, ImageFilter
    im = Image.open(io.BytesIO(png_bytes)).convert("RGB")
    w, h = im.size
    off = Image.new("RGB", (w, h))
    off.paste(im.crop((w // 2, h // 2, w, h)), (0, 0))
    off.paste(im.crop((0, h // 2, w // 2, h)), (w // 2, 0))
    off.paste(im.crop((w // 2, 0, w, h // 2)), (0, h // 2))
    off.paste(im.crop((0, 0, w // 2, h // 2)), (w // 2, h // 2))
    blur = off.filter(ImageFilter.GaussianBlur(6))
    mask = Image.new("L", (w, h), 0)
    band = max(8, w // 24)
    for x in range(w // 2 - band, w // 2 + band):
        for y in range(h):
            mask.putpixel((x, y), int(255 * (1 - abs(x - w / 2) / band)))
    for y in range(h // 2 - band, h // 2 + band):
        v = int(255 * (1 - abs(y - h / 2) / band))
        for x in range(w):
            if v > mask.getpixel((x, y)):
                mask.putpixel((x, y), v)
    off.paste(blur, (0, 0), mask)
    buf = io.BytesIO()
    off.save(buf, "PNG")
    return buf.getvalue()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name")
    ap.add_argument("--prompt")
    ap.add_argument("--batch")
    ap.add_argument("--size", type=int, default=1024)
    ap.add_argument("--steps", type=int, default=8)
    ap.add_argument("--tile", action="store_true")
    a = ap.parse_args()
    jobs = json.loads(pathlib.Path(a.batch).read_text()) if a.batch else [
        {"name": a.name, "prompt": a.prompt, "tile": a.tile}]
    for j in jobs:
        dest, secs = generate(j["name"], j["prompt"], j.get("size", a.size),
                              j.get("steps", a.steps), j.get("seed"), j.get("tile", a.tile))
        print(f"{j['name']}: {dest.name} in {secs}s")


if __name__ == "__main__":
    main()
