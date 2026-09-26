# How it works

Minecraft renders boxes, not arbitrary polygons. Every game format — Java block
models, Bedrock geometry, GeckoLib `.geo.json`, OptiFine CEM — is a set of
cuboids. A glTF model opens fine in Blockbench, but every element is a `Mesh`,
and none of those formats can take it. This plugin rebuilds the model out of
`Cube`s.

The converter core does not depend on Blockbench, so most of what is described
here is covered by Node tests in [`tools/`](../tools).

## 1. Reading the model

**Archive or folder.** Unpacking a ZIP only fills a map of file name to bytes;
selecting the files of an unpacked folder fills the same map. Everything below
the reader is shared. Buffers and images are resolved by relative path, then by
bare file name — so a glTF that refers to `textures/foo.png` still finds `foo.png`
picked from a folder.

**Several `.gltf` files.** A Sketchfab folder usually holds the model and a twin
with no images at all. The one declaring the most images is chosen, and the
choice is written to the report. Taking whichever came first used to import an
untexturable model depending on the order of names.

**Primitive modes.** Triangles (`mode 4`), triangle strips (`5`) and fans (`6`)
are all read. Every second triangle of a strip is stored reversed and is turned
back. A strip jumps from face to face by repeating an index; such a *stitch*
draws nothing but reads its corners from two faces of the texture, so a triangle
with a repeated corner is dropped. On a real strip-encoded box, 20 of 32
triangles were stitches.

**The export wrapper.** Sketchfab wraps a model in
`Sketchfab_model → root → GLTF_SceneRootNode`. The outer node carries the model's
placement in the Sketchfab showcase (an arbitrary rotation and offset) and is
dropped; an axis conversion (a multiple of 90°) is kept. Dropping both used to
make models arrive lying down. Extra rotation around X and Y is available in the
dialog for the cases a file cannot settle.

## 2. From meshes to cubes

**Merged meshes** are split into connected components first: many exporters emit
one mesh of 708 triangles where the model really has 59 boxes.

**Box detection** (`solveBox`) tries all 24 orientations and picks the one with
the fewest UV violations, then the fewest mirrors, then the closest to identity.
All tolerances are relative to the object's size: models contain panels
0.001 px thick next to 8 px cubes.

Two float32 traps are avoided on purpose:

- a direction is never taken from a short edge — the axes come from the two
  longest edges, orthogonalised, and the third is their cross product;
- orthogonality is checked in units of length, not by angle, because the angle
  of a short edge is pure noise.

**Degenerate fragments** are dropped. **Objects that are not boxes** — wedges,
bevels, rounded shapes — are replaced with their bounding box, with the texture
laid out per face. The report states the approximated share; at 30% or more it
says the model is a poor fit.

## 3. Texture layout

**Per-face UV.** The project is switched off box UV, otherwise Blockbench would
recompute the layout itself. The direction in which `u` and `v` grow on each face
is **measured** from the running editor (`calibrateFaceDirs` puts an asymmetric
rectangle on a probe cube and reads its buffers); the table in the code is only a
fallback for Node. A mirror is written as a reversed rectangle (`x1 > x2`).

**Colour and auxiliary maps.** Normal, roughness, occlusion and emissive maps are
meaningless in Minecraft and are skipped.

**One texture per model.** GeckoLib takes one, so several colour images are packed
into an atlas (shelf packing into power-of-two sides) and each object's UV is
moved into its rectangle. Two things decide what goes in:

- an image **no primitive references** is left out. A file may declare one
  material per image and still point every primitive at the first one; the other
  images are then unreachable, and packing them only wastes the atlas — twelve
  such images made 512×256 where the model reads a single 32×32. The report names
  such images;
- an object that **names no image at all** gets the main image's rectangle.
  Without it, its UV were multiplied by the whole atlas and the model arrived in a
  stretched mix of every picture.

**Lost alpha.** A Minecraft-style figure has an outer shell that is transparent
wherever it is unused. If the texture has no alpha channel while the material
asks for transparency (`alphaMode` `BLEND` or `MASK`), that shell becomes a solid
slab and hides the body. The channel cannot be recovered, so the report says so.

## 4. Coordinates

**Scale.** A texel is meant to match a model pixel, so the scale comes from the
ratio of UV area to geometric area: the median of `sqrt(uv / geometry)`, halved,
because textures are usually drawn at twice the model's detail. The result is
checked against a sane size (4–256 px); otherwise it falls back to the bounds. It
can always be set by hand.

**Snapping.** Floating-point noise is cleaned (`4.99998 → 5`). Snapping to the
0.25 px grid is applied only to unrotated cubes that already sit on it: the grid
is coarser than small details — a 0.6 × 0.7 × 0.001 px pupil grew by a quarter and
lost its thickness — and a snapped rotated cube moved its vertices by up to
0.46 px.

**Coincident faces.** Two faces in one plane flicker (z-fighting). Instead of
moving coordinates, the smaller cube of the pair is grown slightly through
`inflate`, which keeps every coordinate clean.

## 5. Animations

Bones sit with zero rotation and the rest pose is baked into world coordinates.
A rotation keyframe is `R(t)·R0⁻¹`; an offset is conjugated by the parent's rest
rotation; the two are assembled as `T·R`. This combination was chosen out of
sixteen by comparing the resulting pose with the true one from glTF
(`tools/verify-animation.mjs`).

Keyframe values are cleaned before they are written: anything below 1e-4 becomes
zero, the rest is rounded to four digits. Blockbench parses keyframe values as
Molang, and a float32 zero such as `4.76e-8` in scientific notation broke the
parse and threw the whole bone — 220 of 1479 values on one model. Scale channels
are skipped: GeckoLib does not animate them.

## 6. Customizable Player Models

The CPM import runs the same conversion and then writes a `.cpmproject` itself —
a ZIP with `config.json`, `skin.png`, `description.json` and one JSON per
animation.

- **Roots are player parts** (`head`, `body`, `left_arm`, …), not the model's own
  bones; everything is hung under them. A root with any other name is what trips
  CPM's own Blockbench exporter (`Unknown root group`).
- **Axes:** `x = −x`, `y = 24 − y`, `z = z`; the basis is carried over by
  conjugation, and CPM composes element rotations in ZYX order. The `up` and
  `down` faces need their UV turned by 180°.
- **UV must be whole numbers** — but in the UV grid, not in image pixels. So the
  image is left alone and only the grid size is raised by as much as needed. The
  viewer's texture limit (256 by default) applies to the image, so it is not hit.
- **Alignment:** the model is shifted as a whole so its bones sit on the vanilla
  pivots; otherwise a limb swings about a pivot far outside itself. Height is not
  touched — the import already stands the model on the ground.
- **The head** is driven by the model when it has animations: in Minecraft the
  head is not a child of the body, and the vanilla look rotation would tear it
  off during a tilted pose.
- **Animations** are snapshots of every moving bone, sampled at a steady rate and
  computed from the world pose, because a bone's parent in CPM is often not its
  parent in glTF. A `v_<pose>_…` file replaces a vanilla pose, `g_…` is a gesture;
  anything unrecognised becomes a gesture.
- **Budget:** a local `.cpmmodel` has 30 kB. The report estimates the encoded size
  with the mod's own writers, so an export too heavy to keep off CPM's servers says
  so before it is saved.

The `.cpmproject` is read back by CPM's own rules in
[`tools/verify-cpm.mjs`](../tools/verify-cpm.mjs): structure, limits, the eight
corners of every box through the renderer's transform, and every animated pose.
