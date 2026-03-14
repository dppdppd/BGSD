// BGSD
include <boardgame_insert_toolkit_lib.4.scad>;
scene_1 = [
    [ OBJECT_BOX, [
        [ NAME, "box 1" ],
        [ BOX_SIZE_XYZ, [500, 500, 200] ],
        [ BOX_LID,
        ],
    ]],
];
Make(scene_1);