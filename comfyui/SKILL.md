---
name: comfyui
description: Drive a local ComfyUI instance headlessly from an agent — discover installed models and nodes, build API-format graphs, queue jobs, poll for results, and pull images/audio/video to disk. Includes the discovery protocol for learning a model you have never used (pull its template, never guess the graph) and the failure modes that fail SILENTLY. Use whenever generating textures, images, sound effects, music or video on ComfyUI, or when a ComfyUI job errors or returns garbage.
---

# Driving ComfyUI from an agent

ComfyUI is a node-graph generation server. You drive it over plain HTTP: POST a graph, poll for
completion, GET the artifact. No SDK, no auth on a LAN instance.

**Instance** (Jason's, verified): `http://192.168.1.182:8188` — Linux, 128 GB RAM, ComfyUI 0.30.0.
Override with `$COMFY_HOST` if given another. It is a SHARED box: check `/queue` before flooding it.

Model-specific graphs live in sibling adapter skills (`comfyui-krea2`, `comfyui-audio`, …). This
skill is the engine: mechanics, discovery, and debugging.

## 1. The one rule that matters

**API format ≠ UI format.** `POST /prompt` accepts ONLY the API format: a flat object keyed by node
id, each `{class_type, inputs}`, where a link is `["<source_node_id>", <output_index>]`.

```json
{"prompt": {
  "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "model.safetensors", "weight_dtype": "default"}},
  "4": {"class_type": "CLIPTextEncode", "inputs": {"text": "a cat", "clip": ["2", 0]}}
}}
```

Workflows saved from the UI (`/api/userdata?dir=workflows`) and built-in templates are the OTHER
format (`nodes[]` + `links[]` + optional `definitions.subgraphs`). You cannot POST them. You READ
them to learn the correct node types and settings, then hand-write the API graph.

## 2. Endpoint surface (all verified)

| Method | Path | Use |
|---|---|---|
| GET | `/system_stats` | liveness, version, RAM |
| GET | `/queue` | `{queue_running, queue_pending}` — check before submitting a batch |
| GET | `/object_info` | EVERY node type installed (large — filter it) |
| GET | `/object_info/{NodeClass}` | one node's exact inputs **and the enum of installed model files** |
| GET | `/api/workflow_templates` | `{module: [template names]}` |
| GET | `/templates/{name}.json` | the actual template graph (**note: `/templates/`, not `/api/templates/`**) |
| GET | `/api/userdata?dir=workflows&recurse=true` | the user's saved workflows |
| POST | `/prompt` | `{"prompt": <api graph>}` → `{"prompt_id": ...}` |
| GET | `/history/{prompt_id}` | status + outputs once finished |
| GET | `/view?filename=&subfolder=&type=output` | download the artifact bytes |
| POST | `/interrupt` | cancel the running job |

`/object_info/{Node}` is how you discover what is actually installed — the `required` inputs whose
value is `[[...list...]]` are enums of real filenames on that box. Never assume a checkpoint exists.

## 3. Discovery protocol — learning a model you have not used

Do NOT guess a graph from general knowledge of the model family. Model families that look alike use
different text encoders, VAEs and latent nodes, and guessing wastes far more time than looking.

1. **Find the template.** `GET /api/workflow_templates`, find one whose name matches the model
   (naming is `image_<model>_t2i`, `video_<model>_t2v`, `audio_<model>_t2a`). Fetch
   `GET /templates/<name>.json`.
2. **Read it, including subgraphs.** Modern templates wrap everything in a subgraph node whose
   `type` is a UUID; the real nodes are in `definitions.subgraphs[].nodes`, each with
   `widgets_values` in positional order. Parse both levels:
   ```python
   d = json.load(open("tpl.json"))
   for n in d.get("nodes", []): print(n["type"], n.get("widgets_values"))
   for s in d.get("definitions", {}).get("subgraphs", []):
       for n in s["nodes"]: print(n["type"], n.get("widgets_values"))
   ```
3. **Transcribe to API format** — loaders, encoders, latent node, sampler settings, VAE — then
   verify each filename against `/object_info/{Loader}`.
4. **Run once, small** (low steps, 768 px / 4 s audio) and LOOK at the artifact before batching.
5. If no template exists, fall back to a saved user workflow covering the same model, or probe
   node-by-node and record what you learned.

## 4. Failure modes (ranked by how much time they cost)

1. **Wrong VAE → silent garbage.** No error, no warning: you get a plausible-looking image of flat
   noise/fabric mush. If output is degenerate but the job "succeeded", the VAE is the first suspect.
   (Krea2 with FLUX's `ae.safetensors` produces exactly this; it needs `qwen_image_vae`.)
2. **Missing/incompatible text encoder → explicit error**, e.g.
   `"clip input is invalid: None"` (checkpoint has no CLIP — load one separately) or
   `"expects conditioning with 12x2560=30720 features but got 4096"` (wrong encoder family).
   `CLIPLoader`'s `type` enum tells you which families this build supports.
3. **Wrong latent node.** `EmptyLatentImage` vs `EmptySD3LatentImage` vs `EmptyLatentAudio` are not
   interchangeable.
4. **Errors are NOT in the HTTP response.** `POST /prompt` returns 200 with a `prompt_id` even for a
   graph that will fail. The failure appears later in `/history/{id}`:
   ```python
   st = h[pid]["status"]                      # status_str == "error"
   [m for m in st["messages"] if m[0] == "execution_error"]  # node_type + exception_message
   ```
   **Always read `status_str` before assuming success**, and treat "finished with no outputs" as an
   error to be diagnosed, not a retry.
5. **Polling too eagerly** — the id appears in `/history` only once queued/complete; poll every ~2 s
   with a timeout, and surface the elapsed time.
6. **A silent poll loop turns a failed submit into a fake hang.** If the request never reaches the
   server, `/history/{id}` simply never contains the id and a quiet loop waits out its whole timeout
   looking exactly like slow generation. A 600 s-per-image timeout across a five-image batch cost us
   **40 minutes of an agent turn** with nothing on screen, and the server was healthy the entire time
   (40 jobs in history, 0 errored). Three cheap defences, all of which you want:
   - **Print progress while polling** — elapsed plus queue depth, every ~10 s.
   - **Check `GET /queue`.** Empty queue plus nothing in `/history` means the job was never
     submitted. Fail immediately with that message; retrying identically will stall identically.
   - **Size the timeout to reality.** Normal 1024² generation is seconds, so ~180 s is generous.
     Long timeouts do not buy reliability, they buy invisible dead time.

   Diagnostic order when a generation "hangs": `/queue` (was it submitted?) → `/history/{id}`
   `status_str` (did it fail?) → only then suspect the server.

## 5. Job runner (working reference)

```python
def run(graph, host=HOST, timeout=600):
    pid = post(f"{host}/prompt", {"prompt": graph})["prompt_id"]
    t0 = time.time()
    while time.time() - t0 < timeout:
        h = json.load(urllib.request.urlopen(f"{host}/history/{pid}", timeout=30))
        if pid in h:
            st = h[pid].get("status", {})
            if st.get("status_str") == "error":
                for m in st.get("messages", []):
                    if m[0] == "execution_error":
                        raise RuntimeError(f"{m[1]['node_type']}: {m[1]['exception_message'][:300]}")
                raise RuntimeError("failed, no execution_error message")
            outs = h[pid].get("outputs", {})
            arts = [a for v in outs.values() for k in ("images", "audio", "gifs") for a in v.get(k, [])]
            if not arts:
                raise RuntimeError(f"finished with no artifact: {json.dumps(outs)[:300]}")
            return arts, time.time() - t0
        time.sleep(2)
    raise TimeoutError(pid)

def fetch(art, host=HOST):
    q = urllib.parse.urlencode({"filename": art["filename"],
                                "subfolder": art.get("subfolder", ""),
                                "type": art.get("type", "output")})
    return urllib.request.urlopen(f"{host}/view?{q}", timeout=120).read()
```

A fuller reference implementation with batching and seam-blending for tileable textures lives at
`D:\dev\orcho-game\tools\comfy_gen.py`.

## 6. Practical notes

- **Speed** on this box: krea2_turbo 1024² ≈ 6 s; Stable Audio 4 s clip ≈ 6 s. Batches of a dozen
  assets are a minute, so iterate on prompts freely.
- **Seamless tiling** is not a model feature. Generate, then offset by half and feather the cross
  seam (see `make_seamless` in the reference implementation). Prompting "seamless tileable" helps
  the content read right but does not guarantee edge continuity.
- **Game/asset prompting that works**: state the view ("top-down"), the lighting ("flat overcast,
  no shadows"), and exclusions ("no objects, no people"). Baked shadows and stray objects are what
  make a generated texture unusable.
- Save artifacts next to a `manifest.json` recording filename, size, colour space and intended
  tiling repeat — consumers (game code, other agents) should read the manifest, never guess names.
- Colour maps are sRGB; in three.js set `texture.colorSpace = SRGBColorSpace` and leave
  normal/roughness maps linear.
