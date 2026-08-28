// BGSD
// Burning Banners layout: one tray for 17 x 17 x 6 mm counters and three
// trays for 26 x 26 x 3 mm counters within a 290 x 230 mm footprint.
include <../lib/counter_tray_designer_lib.1.scad>;
scene_1 = [
    [ TRAY,
        [ COUNTER_SET,
            [ COUNTER_SIZE_XYZ, [17, 17, 6] ],
        ],
    ],
    [ LID,
    ],
    [ G_DIMENSIONS_XY, [290, 230] ],
    [ TRAY,
        [ COUNTER_SET,
            [ COUNTER_SIZE_XYZ, [26, 26, 3] ],
        ],
        [ PRINT_COUNT_N, 3 ],
    ],
];
Make(scene_1);
