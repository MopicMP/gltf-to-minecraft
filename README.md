# glTF to Minecraft

A Blockbench plugin that converts **glTF models — from an archive, a folder or
straight from Sketchfab — into cubes Minecraft can use**: a GeckoLib model or a
Customizable Player Models skin, with bones, textures and animations.

It used to be called *GeckoLib Model Importer*. The name changed on the catalog
maintainer's remark: it imports nothing from GeckoLib, and almost nothing in it is
tied to GeckoLib — it is a converter from glTF, and GeckoLib is one of its outputs.

Minecraft cannot render arbitrary polygonal geometry. A glTF model opens fine in
Blockbench, but every element is a `Mesh`, and the game needs `Cube`. This plugin
does that conversion, and everything around it.

## What it does

- **Import a ZIP or a folder** with a glTF model and textures, and get a finished
  GeckoLib project. Textures may be PNG, JPEG, GIF or WebP.
- **Browse Sketchfab** inside Blockbench, through the official Data API. Author
  and licence are shown on every card; only models the author allowed to be
  downloaded are listed, and by default only those made in Blockbench.
- **Several textures** are packed into one atlas, because GeckoLib wants one.
- **Merged meshes** are split back into separate cubes automatically — many
  exporters emit 708 triangles where the model really has 59 boxes.
- **Animations** are carried over, both rotation and position channels.
- **Coplanar faces** are separated through the `Inflate` field, so the model does
  not flicker (z-fighting) while coordinates stay clean.
- **Customizable Player Models** are a second target: the same import, saved as a
  `.cpmproject`.

## Customizable Player Models

File → Import → *Import glTF as Customizable Player Model* runs the same
import and then asks the three things a player skin needs and a GeckoLib model
does not: the height in player pixels, which bone belongs to which part of the
player, and what each animation becomes — a vanilla pose (`walking`, `sneaking`,
`sleeping`…) or a gesture. Then it saves a `.cpmproject`.

The size is a separate question and not the one the import ran at: CPM measures
in player pixels, 32 of them head to toe, while a downloaded model arrives in
whatever units its author used, so one number cannot serve both formats.

The bone mapping is offered rather than decided. A guess by name is filled in,
and on a model already rigged like a player it needs no corrections; on anything
else a silent guess would be worse than none.

A Blockbench project is created alongside the export — the UV convention is
measured on it, and it lets the result be looked at. The report states the
encoded size against CPM's 30 kB budget for a local model, so an export too
heavy to keep off the CPM servers says so before it is saved.

Details: [How it works — Customizable Player Models](docs/how-it-works.md#6-customizable-player-models).

## What it cannot do

Wedges, bevels and rounded shapes do not exist in Minecraft. Such objects are
replaced with their bounding box, with the texture laid out per face. The import
report states exactly which share of the model was approximated; at 30% or more
it says plainly that the model is a poor fit.

Coordinates are cleaned of floating-point noise (`4.99998` becomes `5`), but a
model that was not built on a 0.25 px grid keeps its exact numbers. Snapping such
a model would grow small details by a quarter and flatten thin overlays — a pupil
of 0.6 × 0.7 × 0.001 px became 0.75 × 0.75 × 0 and disappeared into the head.

## Requirements

The **GeckoLib Animation Utils** plugin: its format is what projects are built
into. The plugin checks for it before importing. Converting an already-open model
from meshes to cubes (Filter menu) works without it.

Downloading from Sketchfab needs a personal API token, available in the Sketchfab
profile settings under *Password & API*. Searching works without one.

## Usage

**Search:** File → Import → *Import from Sketchfab*.

The **Made in Blockbench** box is ticked by default: only models tagged
`blockbench` are listed. They are built from cubes to begin with and convert
whole, while most of Sketchfab is sculpts that leave only a pile of bounding
boxes. Measured on the live API for "girl": without the filter 0 of 24 results
carry the tag, with it 24 of 24, on the second page as well. The box can be
unticked.

**Import:** File → Import → *Import glTF as GeckoLib Model*, or
the tile on the start screen.

**A folder works in place of an archive.** In the same picker you can select the
files of an already unpacked folder — the model, its `.bin` and the textures —
instead of a `.zip`. Below the parser there is no difference: unpacking an
archive does nothing but fill a map of file name to bytes, and selecting files
fills the same map. So it is one menu entry, not two, and a folder needs no
JSZip, which means it also works in builds that have none.

When a folder holds several `.gltf` files — a Sketchfab export ships a twin with
no textures next to the model — the one declaring the most images is chosen.
It used to be whichever came first, which depended on the order of names.

The dialog offers five settings: model size, centring, extra rotation around X
and Y, and whether to transfer animations. Everything else lives behind the
**Advanced settings** checkbox — those are levers for diagnosing breakage, and
they are best changed one at a time.

**Install:** Blockbench → File → Plugins → *Load Plugin from File* →
[`plugin/gltf_to_minecraft.js`](plugin/gltf_to_minecraft.js).

## Testing without Blockbench

The converter core does not depend on Blockbench, so it can be exercised from
Node. This catches maths errors without opening the editor:

```bash
node tools/verify-conversion.mjs model/model.obj    # box detection and UV layout
node tools/verify-gltf.mjs        model/model.obj    # glTF parsing against a baseline
node tools/verify-snap.mjs                           # grid snapping and its cost
node tools/verify-coplanar.mjs                       # coplanar face separation
node tools/verify-images.mjs                         # PNG/JPEG/GIF/WebP headers
node tools/verify-cpm.mjs                            # .cpmproject: structure, limits, geometry
node tools/verify-strips.mjs                         # triangle strips and fans, on real models
node tools/verify-search-filter.mjs --live           # Sketchfab filters, against the live API
node tools/smoke-plugin.mjs                          # the whole import path
node tools/survey-models.mjs                         # what the import makes of every model in test/model
```

`smoke-plugin` substitutes Blockbench objects (`Cube`, `Group`, `Animation`,
`THREE`, `JSZip`…) and runs the entire import on several archives: PNG, JPEG with
an unreadable image, an image nobody refers to, objects naming no image, a
texture without the alpha its material asks for, and the same model as loose
folder files. It also checks that every entry sits in File > Import. The CPM
export runs after them, down the same path but saving a `.cpmproject`. It catches what
`node --check` misses — reading a `const` before its declaration, typos in names,
calls to functions that do not exist.

## Documentation

- [How it works](docs/how-it-works.md) — reading glTF, turning meshes into cubes,
  texture layout, coordinates, animations and the CPM export.
- [Why a model comes out wrong](docs/troubleshooting.md) — the common symptoms,
  what causes them and what to do.

## Licence

MIT, see [LICENSE](LICENSE).

Imported models keep their own licence. Most Sketchfab models require attribution,
so the import report always prints the author and the licence from the archive.
