# BIT Parameter Frequency

Source: `examples.4.scad` (17 boxes, 35 features, 2 divider sets) + `starter.scad`.

| Parameter | Uses | Context |
|-----------|------|---------|
| `FTR_COMPARTMENT_SIZE_XYZ` | 35 | feature |
| `POSITION_XY` | 26 | feature, label |
| `FTR_SHAPE` | 20 | feature |
| `NAME` | 19 | element |
| `BOX_SIZE_XYZ` | 17 | element |
| `LBL_TEXT` | 15 | label |
| `LBL_SIZE` | 14 | label |
| `FTR_NUM_COMPARTMENTS_XY` | 9 | feature |
| `LBL_PLACEMENT` | 9 | label |
| `LID_SOLID_B` | 8 | lid |
| `FTR_SHAPE_VERTICAL_B` | 8 | feature |
| `LID_PATTERN_RADIUS` | 7 | lid |
| `FTR_SHAPE_AXIS` | 7 | feature |
| `ROTATION` | 6 | feature, label |
| `LID_PATTERN_THICKNESS` | 5 | lid |
| `FTR_PADDING_XY` | 4 | feature |
| `FTR_CUTOUT_SIDES_4B` | 4 | feature |
| `LID_PATTERN_N1` | 4 | lid |
| `LID_PATTERN_N2` | 4 | lid |
| `LID_PATTERN_ANGLE` | 4 | lid |
| `LID_PATTERN_ROW_OFFSET` | 4 | lid |
| `LID_PATTERN_COL_OFFSET` | 4 | lid |
| `FTR_PADDING_HEIGHT_ADJUST_XY` | 3 | feature |
| `BOX_STACKABLE_B` | 2 | element |
| `ENABLED_B` | 2 | element |
| `FTR_SHEAR` | 2 | feature |
| `FTR_MARGIN_FBLR` | 2 | feature |
| `FTR_FILLET_RADIUS` | 2 | feature |
| `LID_INSET_B` | 2 | lid |
| `DIV_TAB_TEXT` | 2 | divider |
| `G_TOLERANCE` | 1 | global |
| `G_DEFAULT_FONT` | 1 | global |
| `LID_HEIGHT` | 1 | lid |
| `LID_FIT_UNDER_B` | 1 | lid |
| `LID_LABELS_INVERT_B` | 1 | lid |
| `LID_LABELS_BG_THICKNESS` | 1 | lid |
| `LID_LABELS_BORDER_THICKNESS` | 1 | lid |
| `LBL_FONT` | 1 | label |
| `FTR_PEDESTAL_BASE_B` | 1 | feature |
| `FTR_CUTOUT_CORNERS_4B` | 1 | feature |
| `FTR_CUTOUT_TYPE` | 1 | feature |
| `FTR_CUTOUT_HEIGHT_PCT` | 1 | feature |
| `FTR_CUTOUT_DEPTH_PCT` | 1 | feature |
| `FTR_CUTOUT_WIDTH_PCT` | 1 | feature |
| `FTR_CUTOUT_BOTTOM_B` | 1 | feature |
| `DIV_TAB_TEXT_SIZE` | 1 | divider |
| `DIV_TAB_SIZE_XY` | 1 | divider |
| `DIV_TAB_CYCLE` | 1 | divider |
| `DIV_TAB_CYCLE_START` | 1 | divider |
| `DIV_FRAME_SIZE_XY` | 1 | divider |
| `DIV_FRAME_NUM_COLUMNS` | 1 | divider |
| `DIV_FRAME_COLUMN` | 1 | divider |

## Never used in examples

`PRINT_GROUP`, `BOX_NO_LID_B`, `BOX_WALL_THICKNESS`, `CHAMFER_N`, `DEBUG_B`, `FTR_CUTOUT_BOTTOM_PCT`, `FTR_CUTOUT_DEPTH_MAX`, `LBL_DEPTH`, `LBL_SPACING`, `LBL_IMAGE`, `LBL_AUTO_SCALE_FACTOR`, `LID_CUTOUT_SIDES_4B`, `LID_TABS_4B`, `LID_STRIPE_WIDTH`, `LID_STRIPE_SPACE`, `LID_SOLID_LABELS_DEPTH`, `DIV_THICKNESS`, `DIV_TAB_RADIUS`, `DIV_TAB_TEXT_FONT`, `DIV_TAB_TEXT_SPACING`, `DIV_TAB_TEXT_CHAR_THRESHOLD`, `DIV_TAB_TEXT_EMBOSSED_B`, `DIV_FRAME_TOP`, `DIV_FRAME_BOTTOM`, `DIV_FRAME_RADIUS`, `G_PRINT_LID_B`, `G_PRINT_BOX_B`, `G_PRINT_GROUP`, `G_ISOLATED_PRINT_BOX`, `G_VISUALIZATION_B`, `G_VALIDATE_KEYS_B`, `G_WALL_THICKNESS`, `G_TOLERANCE_DETENT_POS`, `G_FIT_TEST_B`, `G_DETENT_THICKNESS`, `G_DETENT_SPACING`, `G_DETENT_DIST_FROM_CORNER`, `G_DETENT_MIN_SPACING`, `G_LID_THICKNESS`, `G_COLORIZE_B`, `G_PREVIEW_NO_LABELS_B`

## Print Group Notes

In BIT 4.9.1, a box feature printed separately from its parent box emits feature-local rim/wall geometry. `FTR_MARGIN_FBLR` controls that rim explicitly; when omitted, BIT uses the box wall thickness as the default rim.
