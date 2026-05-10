# Maximize new box feature dimensions from parent box

## Description

When adding a new `BOX_FEATURE`, BGSD should initialize `FTR_COMPARTMENT_SIZE_XYZ` from the parent box dimensions instead of using the fixed `[40, 40, 15]` skeleton.

The default should maximize the available compartment size inside the parent box, subtracting the relevant wall/floor thickness so the generated feature starts as a valid full-size compartment.

Existing designs should not be rewritten. This applies only to newly inserted box features.

## Action Steps

1. Replace the hardcoded new-feature size in `src/App.svelte` with a helper that reads the parent `BOX_SIZE_XYZ` and wall-related keys.
2. Compute a positive, clamped `FTR_COMPARTMENT_SIZE_XYZ` using the parent box inner volume; fall back to the current skeleton only when parent dimensions are unavailable.
3. Add unit coverage for the sizing helper and a harness screenshot/script proving a newly added feature gets parent-derived dimensions.

## Scope

- BIT box features only.
- Do not change importer behavior for existing files.
- Do not change CTD defaults.

