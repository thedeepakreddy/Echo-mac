# model/

The GGUF lands here after training and conversion.

- `deepakllm-q4_k_m.gguf` — the model (~4.4GB for a 7B)
- `mmproj-deepakllm.gguf`  — the vision projector (~1GB)

The projector is easy to forget and its absence is not obvious: the model will
load, answer confidently, and be completely blind to the screen.

`Modelfile` in the parent folder expects these names.
