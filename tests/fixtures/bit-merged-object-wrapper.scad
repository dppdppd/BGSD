// BGSD
include <dummy.scad>;
data = [
    [ G_LID_THICKNESS, 2 ],
    [ OBJECT_BOX, [
        [ NAME, "box 2" ],
        [ BOX_SIZE_XYZ, [50, 50, 20] ],
        [ BOX_FEATURE,
            [ FTR_COMPARTMENT_SIZE_XYZ, [40, 40, 15] ],
        ],
    ]],
];
Make(data);
