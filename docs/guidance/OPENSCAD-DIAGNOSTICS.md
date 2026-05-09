# OpenSCAD Diagnostics

BGSD surfaces issues found by OpenSCAD in the toolbar diagnostics panel. Native OpenSCAD `ERROR:` and `WARNING:` output is always parsed, including parser errors, failed assertions, missing includes, and unknown modules.

BIT and CTD can also emit structured library diagnostics with `echo()` when a design is syntactically valid but a parameter combination should be called out to the user.

## Structured Echo Format

Use one `echo()` call per issue, and make the first string characters one of these prefixes:

```scad
echo("BGSD_WARNING: message");
echo("BGSD_ERROR: message");
echo("BGSD_INFO: message");
```

Severity:

| Prefix | Use for |
|--------|---------|
| `BGSD_WARNING:` | Suspicious or unsupported values where OpenSCAD can continue. |
| `BGSD_ERROR:` | Invalid values or impossible combinations that make the generated object unreliable. Prefer `assert()` when the render should stop. |
| `BGSD_INFO:` | Helpful context that should not make the toolbar show an issue count. Use sparingly. |

The prefix must be at the start of a single string argument. Avoid multi-argument `echo()` calls for diagnostics because OpenSCAD formats them differently and BGSD will not treat them as structured messages.

Recommended:

```scad
echo("BGSD_WARNING: LID_TYPE is set, but this box has no generated lid.");
echo(str("BGSD_ERROR: BOX_SIZE_XYZ z=", box_z, " must be greater than zero."));
```

Avoid:

```scad
echo("BGSD_WARNING", "LID_TYPE is set, but this box has no generated lid.");
echo("WARNING: LID_TYPE is set, but this box has no generated lid.");
```

## Optional Metadata

After the prefix, BIT and CTD may add simple bracketed metadata fields before the message:

```scad
echo("BGSD_WARNING [line=42] [code=BIT-LID-001] [key=LID_TYPE] [context=lid]: LID_TYPE is ignored when lids are disabled.");
echo("BGSD_WARNING [code=BIT-PHYSICAL] [keys=BOX_SIZE_XYZ,FTR_COMPARTMENT_SIZE_XYZ] [context=box:box_1]: compartment exceeds the usable box interior.");
```

Supported metadata fields:

| Field | Example | Meaning |
|-------|---------|---------|
| `line` | `42` | 1-based line number in the generated design SCAD that BGSD should mark as the diagnostic target. |
| `lines` | `42,48` | Multiple generated design SCAD line numbers to mark for one issue. |
| `code` | `BIT-LID-001` | Stable diagnostic identifier for docs, tests, and future filtering. |
| `key` | `LID_TYPE` | Primary parameter involved. |
| `keys` | `BOX_SIZE_XYZ,FTR_COMPARTMENT_SIZE_XYZ` | Multiple parameters involved in one issue. BGSD marks matching editable rows. |
| `context` | `lid` | Schema context, such as `element`, `feature`, `lid`, `label`, `divider`, `tray`, or `counter_set`. |

Metadata values should not contain spaces or `]`. Put user-facing explanation in the message after the colon.

`line` is the most precise field for BGSD markup. It should point at the design line the user can edit, not the BIT or CTD library line that emitted the `echo()`. If the library cannot identify a user-editable generated SCAD line, omit `line` rather than guessing and provide `key` / `keys` instead.

For cross-field validation, prefer one structured issue with `keys=...` so BGSD can mark every editable parameter involved. For example, a compartment that exceeds the box interior should target both `BOX_SIZE_XYZ` and `FTR_COMPARTMENT_SIZE_XYZ`.

When using `context` to narrow key matching, keep values token-safe. For named boxes, use `context=box:<name_with_spaces_replaced_by_underscores>`; BGSD converts underscores back to spaces for row targeting.

## Message Guidelines

- State the problem first, then the likely fix if it is short.
- Use schema parameter names exactly as BGSD shows them, such as `BOX_SIZE_XYZ` or `COUNTER_SIZE_XYZ`.
- Keep each message self-contained. The diagnostics panel may show messages outside the OpenSCAD console context.
- Do not emit the same warning from inside a loop for every generated primitive. Guard diagnostics so each design issue appears once per relevant object.
- Use stable `code` values once published. Renaming a code should be treated like a compatibility change.
- Include `[line=N]` whenever the issue is tied to a specific user-editable generated SCAD line. BGSD uses that line to mark the relevant editor row.
- Include `[keys=KEY_A,KEY_B]` for warnings caused by relationships between multiple parameters.

## Fatal Validation

For errors that should stop rendering, prefer native OpenSCAD assertions:

```scad
assert(box_z > 0, "BOX_SIZE_XYZ z must be greater than zero.");
```

BGSD parses OpenSCAD's native assertion error output and can show the file and line when OpenSCAD provides it. Use `BGSD_ERROR:` only when the library should report an invalid design while still allowing OpenSCAD to continue.
