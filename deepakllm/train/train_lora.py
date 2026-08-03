"""
QLoRA fine-tune for DeepakLLM.

    python train_lora.py --data ../dataset/training.jsonl --base <model-id>

NOT YET VERIFIED ON REAL HARDWARE. This is standard QLoRA boilerplate, written
to be read before it is run — every VLM wires its image tokens differently, and
the processor/collator section is where a new base will need adjusting. Treat a
first run as a dry run: check that loss actually falls before renting anything
by the hour.

Three choices here are deliberate and worth keeping:

  1. Train from the BASE checkpoint every time, never by stacking a new LoRA on
     the previous one. Stacked adapters drift, and each round quietly erodes
     what earlier rounds taught.
  2. Loss on the assistant turn only. Training on the prompt teaches the model
     to reproduce screenshots, which is not the job and wastes capacity.
  3. Keep a held-out split. Without it there is no way to tell a model that
     learned the task from one that memorised the training set.
"""

import argparse
import json
import os
import random
from pathlib import Path


def load_examples(path: Path):
    rows = []
    with path.open() as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def resolve_images(rows, root: Path):
    """Rewrite relative image paths against the bundle, and drop broken ones.

    The exporter writes paths relative to the dataset folder so the bundle can
    move between machines. A missing image is dropped rather than failing the
    run: a text-only example still teaches tool choice, which is most of the
    value before there is enough data for grounding anyway.
    """
    kept, dropped = [], 0
    for r in rows:
        ok = True
        for msg in r.get("messages", []):
            content = msg.get("content")
            if not isinstance(content, list):
                continue
            for part in content:
                if part.get("type") == "image":
                    p = (root / part["image"]).resolve()
                    if p.exists():
                        part["image"] = str(p)
                    else:
                        ok = False
        if ok:
            kept.append(r)
        else:
            dropped += 1
    return kept, dropped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="training.jsonl from the exporter")
    ap.add_argument("--base", required=True, help="base model id, e.g. a current Qwen VL")
    ap.add_argument("--out", default="../adapter")
    ap.add_argument("--epochs", type=float, default=2.0)
    ap.add_argument("--rank", type=int, default=16)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--batch", type=int, default=1)
    ap.add_argument("--accum", type=int, default=8)
    ap.add_argument("--val-split", type=float, default=0.1)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true", help="check the data, load nothing")
    args = ap.parse_args()

    data_path = Path(args.data).resolve()
    rows = load_examples(data_path)
    rows, dropped = resolve_images(rows, data_path.parent)

    if dropped:
        print(f"dropped {dropped} example(s) with missing screenshots")
    print(f"{len(rows)} usable examples")

    if len(rows) < 200:
        print("\nThis is far too little to train on. Tool-name adherence starts")
        print("improving around 2,000-5,000 examples; grounding needs ~10,000.")
        print("Keep using Jarvis with learning enabled and come back.\n")
        if not args.dry_run:
            return

    random.Random(args.seed).shuffle(rows)
    # Never let the holdout swallow the training set. On a tiny dataset the
    # rounded split took everything and left nothing to train on, which shows up
    # as an opaque trainer error rather than an obvious mistake.
    cut = min(len(rows) - 1, max(1, int(len(rows) * args.val_split))) if len(rows) > 1 else 0
    val, train = rows[:cut], rows[cut:]
    print(f"train {len(train)}  /  held out {len(val)}")

    if args.dry_run:
        print("\ndry run — data looks loadable, nothing was trained\n")
        return

    # Imported late so --dry-run works without a GPU stack installed.
    import torch
    from datasets import Dataset
    from transformers import AutoProcessor, AutoModelForVision2Seq, BitsAndBytesConfig
    from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
    from trl import SFTConfig, SFTTrainer

    quant = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )

    processor = AutoProcessor.from_pretrained(args.base, trust_remote_code=True)
    model = AutoModelForVision2Seq.from_pretrained(
        args.base,
        quantization_config=quant,
        torch_dtype=torch.bfloat16,
        device_map="auto",
        trust_remote_code=True,
    )
    model = prepare_model_for_kbit_training(model)

    # Attention projections only. Training the vision tower as well is the fast
    # route to forgetting how to see, and it is not what needs to change here —
    # the base already knows what a button looks like; what it does not know is
    # which tool to emit for one.
    lora = LoraConfig(
        r=args.rank,
        lora_alpha=args.rank * 2,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
    )
    model = get_peft_model(model, lora)
    model.print_trainable_parameters()

    cfg = SFTConfig(
        output_dir=args.out,
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch,
        gradient_accumulation_steps=args.accum,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        logging_steps=10,
        eval_strategy="epoch",
        save_strategy="epoch",
        bf16=True,
        gradient_checkpointing=True,
        report_to="none",
        # Loss on the reply only. The marker must match the base model's chat
        # template — check it, this is the single most common silent mistake.
        assistant_only_loss=True,
    )

    trainer = SFTTrainer(
        model=model,
        args=cfg,
        train_dataset=Dataset.from_list(train),
        eval_dataset=Dataset.from_list(val),
        processing_class=processor,
    )
    trainer.train()
    trainer.save_model(args.out)
    print(f"\nadapter saved to {os.path.abspath(args.out)}")
    print("next: merge it, convert to GGUF, then `ollama create deepakllm -f ../Modelfile`\n")


if __name__ == "__main__":
    main()
