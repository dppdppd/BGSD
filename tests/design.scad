// BGSD
include <counter_tray_designer_lib.1.scad>;
scene_1 = [
    [ G_DIMENSIONS_XY, [200, 270] ],
    [ COUNTER_SET,
        [ COUNTER_SIZE_XYZ, [13.3, 13.3, 3] ],
    ],
];
Make(scene_1);