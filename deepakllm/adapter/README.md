# adapter/

The LoRA lands here — `adapter_model.safetensors` plus `adapter_config.json`.

This is the small file that actually holds what the model learned from Jarvis.
Keep it even after producing a GGUF: when a better base model ships, you can
re-merge this onto it instead of retraining, and if you would rather retrain,
`../dataset/` is still the thing that makes that possible.
