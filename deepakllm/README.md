# DeepakLLM

A local model that learns to drive a Mac by watching Claude and Gemini do it
inside J.A.R.V.I.S, then does the same work offline, instantly, for free.

**This folder is self-contained. Copy it anywhere.** Nothing in it imports
Jarvis, and the client has no dependencies at all.

```
deepakllm/
  README.md          you are here
  Modelfile          Ollama definition — system prompt and sampling
  tools.json         the 95-tool vocabulary the model speaks   (npm run toolspec)
  dataset/           portable training snapshot                (npm run dataset -- --export)
    training.jsonl     chat-format examples, relative image paths
    screens/           the screenshots those examples reference
    manifest.json      counts, and what was dropped and why
  train/
    train_lora.py      QLoRA fine-tune
    requirements.txt
  adapter/           the LoRA lands here after training — the part that is yours
  model/             the GGUF lands here — the part that is portable
  client/
    deepakllm.mjs      standalone client, zero dependencies
    example.mjs        working example + smoke test
```

## What is "the DeepakLLM file"?

There isn't one file, there are four, and they are not equally important:

| File | Size (7B) | Keep it? |
|---|---|---|
| `dataset/` | grows | **Yes — above everything else.** |
| `adapter/adapter_model.safetensors` | 40–200MB | Yes. Re-merge onto a newer base later. |
| `model/deepakllm-q4_k_m.gguf` | ~4.4GB | Yes, this is what you copy to another machine. |
| `model/mmproj-*.gguf` | ~1GB | Yes. Without it a vision model is blind but still answers. |

**Back up `dataset/` first.** Fine-tuned models have a shelf life of months —
a better base ships and your adapter is worse than a fresh run on it. The
dataset is unreproducible and retrains onto anything, forever.

## Collecting data

Set `"learning": { "enabled": true }` in the Jarvis `config.json` and use Jarvis
normally. Every action a teacher brain takes becomes an example.

```bash
npm run dataset                 # how much is there, and is it enough yet
npm run dataset -- --export     # snapshot into dataset/, paths made relative
npm run toolspec                # regenerate tools.json after adding tools
```

The live journal stays in `~/.jarvis/trajectories`; export takes a snapshot.
Re-export after adding tools or collecting more.

Volume needed, measured against the failure it fixes:

- **2,000–5,000** — the model stops inventing tool names
- **10,000+** — coordinate grounding actually improves

## Training

```bash
cd train
pip install -r requirements.txt
python train_lora.py --data ../dataset/training.jsonl --base <base-model-id> --dry-run
python train_lora.py --data ../dataset/training.jsonl --base <base-model-id>
```

Pick a **current** base. Do not use Qwen2-VL — it predates GUI grounding. Use
the newest Qwen VL, or a base already pretrained for desktop control (UI-TARS,
OS-Atlas, Aguvis), which saves tens of thousands of examples of grounding work.

`train_lora.py` has **not been run on real hardware yet.** Always `--dry-run`
first, and confirm loss actually falls before paying for GPU hours.

Then merge, convert to GGUF, and:

```bash
ollama create deepakllm -f Modelfile
```

## Using it in another project

Once it is in Ollama it is just an HTTP endpoint — no Jarvis, no Python, any
language:

```js
import { DeepakLLM, loadTools } from "./client/deepakllm.mjs";

const llm = new DeepakLLM({
  model: "deepakllm",
  tools: await loadTools("./tools.json"),
});

await llm.run("open safari", {
  execute: async (tool, args) => {
    // YOUR safety checks go here. The model deciding an action is fine
    // is not the same as it being fine.
    return await myTools[tool](args);
  },
});
```

Ollama also exposes an OpenAI-compatible route at `/v1/chat/completions`, so any
OpenAI SDK works by changing `base_url` and nothing else.

Run `node client/example.mjs llama3.2:3b` to see the whole loop work against a
model you already have.

## The one thing that will bite you

The model learns three things, and they do **not** travel equally:

- emitting well-formed tool calls — fully portable
- macOS GUI grounding — portable to anything driving a Mac
- **Jarvis's specific tool names — not portable**

Drop it into a project whose tool is called `clickElement` and it will keep
emitting `click_ui_element` forever, because that is what it was rewarded for.
Either pass a `rename` map to the client, or reuse this `tools.json` as your
standard vocabulary across projects — do the second and the model is
plug-and-play everywhere.

The client also recovers from two small-model habits automatically: calls
written as prose instead of structured output, and near-miss tool names
(`update_hand_gesture_params` → `toggle_hand_gestures`, an observed real
failure).

## Never train on its own output

A model trained on what it produced compounds its own mistakes until it
collapses. Every recorded row carries a `source`, and the exporter drops
`deepakllm` rows. If you point Jarvis's `ollama.model` at the student, it is
tagged automatically — but if you serve it some other way, keep that tag
honest. It is the difference between a model that improves and one that rots.
