---
name: ml-engineering
description: Build and validate data and ML workflows including dataset inspection, feature engineering, classical ML, deep learning, evaluation, inference, GPU/CUDA and model serving. Use for ML or data-science implementation.
---

# ML Engineering

## Data first
- Inspect columns, dtypes, missingness, duplicates, cardinality and target distribution.
- Separate target from features before transformations.
- Check leakage and train/inference preprocessing parity.

## Experimentation
- Prefer a reproducible baseline before complex models.
- Fix or record random seeds where meaningful.
- Use metrics appropriate to the task and dataset.
- Compare models on the same split/CV protocol.
- Keep artifacts and dependencies minimal.

## Useful tools
- `dataset-inspect` for fast profiling.
- `ml-check` for environment and package capability checks.
- `gpu-check` for NVIDIA/CUDA/PyTorch visibility.
- `test` and `lint` for code validation.
- `benchmark` for measured inference/training hot paths.
- Hugging Face MCP for models, datasets, papers and Hub docs.
- Context7 for framework/library documentation.
- Exa for current research and implementation references.
- GitHub MCP for maintained implementation examples.

## Done
Verify data assumptions and execute a minimal reproducible experiment or test. State exact dataset/model/metric results and what remains unverified.
