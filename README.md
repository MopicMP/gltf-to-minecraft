# glTF to Minecraft

A Blockbench plugin that converts **glTF models — from an archive, a folder or
straight from Sketchfab — into cubes Minecraft can use**: GeckoLib and Bedrock
models with bones and animations, still Java block and item models, or a
Customizable Player Models skin.

It used to be called *GeckoLib Model Importer*. The name changed on the catalog
maintainer's remark: it imports nothing from GeckoLib, and almost nothing in it is
tied to GeckoLib — it is a converter from glTF, and GeckoLib is one of its outputs.

Minecraft cannot render arbitrary polygonal geometry. A glTF model opens fine in
Blockbench, but every element is a `Mesh`, and the game needs `Cube`. This plugin
does that conversion, and everything around it.

## What it does

- **Import a ZIP or a folder** with a glTF model and textures, and get a finished
  project in the format you pick: GeckoLib, Bedrock Entity, Generic Model or a
  still Java block/item model. Textures may be PNG, JPEG, GIF or WebP.
- **Add to the open project** instead of making a new one: a sword into the
  selected hand, a helmet onto a head. One undo takes it all back.
- **Browse Sketchfab** inside Blockbench, through the official Data API. Author
  and licence are shown on every card; only models the author allowed to be
  downloaded are listed, and by default only those made in Blockbench. The cards
  show triangle, animation and like counts, a filter keeps only animated models,
  results can be ordered by likes, views or date, and any model can be turned
  around in 3D before it is downloaded.
- **Several textures** are packed into one atlas, because GeckoLib and Bedrock
  want one.
- **Merged meshes** are split back into separate cubes automatically — many
  exporters emit 708 triangles where the model really has 59 boxes.
- **Rounded and bevelled parts** are rebuilt from thin plates that follow their
  surface, each cut to its outline by a baked texture — the way curves are built
  by hand in Blockbench. *Best quality* also lays strips along sharp slanted edges.
- **Animations** are carried over, both rotation and position channels.
- **Coplanar faces** are separated through the `Inflate` field, so the model does
  not flicker (z-fighting) while coordinates stay clean.
- **Customizable Player Models** are a second target: the same import, saved as a
  `.cpmproject`.

## Installation

**From the plugin list** — in Blockbench, *File → Plugins…*, the *Available* tab,
search for **glTF to Minecraft** and press *Install*. Updates arrive the same
way. The list takes a new version a little after it appears here.

**From this repository** — *File → Plugins…*, then *Load Plugin from URL* with

```
https://raw.githubusercontent.com/MopicMP/gltf-to-minecraft/main/plugin/gltf_to_minecraft.js
```

or download [`plugin/gltf_to_minecraft.js`](plugin/gltf_to_minecraft.js) and use
*Load Plugin from File*. Blockbench 4.9 or newer, desktop or web.

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
measured on it, and it lets the result be looked at. It is a Generic model, so the
CPM export needs no other plugin. Bones and parts carry the same tidied names in
the dialog and in the `.cpmproject` as in the outliner, and the dialog starts at
the top of the tidied tree rather than at the export wrapper. The report states the
encoded size against CPM's 30 kB budget for a local model, so an export too
heavy to keep off the CPM servers says so before it is saved.

Details: [How it works — Customizable Player Models](docs/how-it-works.md#6-customizable-player-models).

## What it cannot do

Wedges, bevels and rounded shapes do not exist in Minecraft. Such parts are
rebuilt from thin turned plates that follow their surface, each cut to its outline
by a baked texture, so wherever the model is used it needs cutout transparency, as
the report says. Up close their slanted edges show fine steps; *Best quality*
straightens them with strips along sharp edges, at 1.5 to 2 times the cubes. A
model made mostly of such parts gets many times more cubes than it has objects.
The advanced settings can instead replace each with its bounding box, skip them,
or cancel the import. Details: [How it works — Parts that are not boxes](docs/how-it-works.md#9-parts-that-are-not-boxes).

Coordinates are cleaned of floating-point noise (`4.99998` becomes `5`), but a
model that was not built on a 0.25 px grid keeps its exact numbers. Snapping such
a model would grow small details by a quarter and flatten thin overlays — a pupil
of 0.6 × 0.7 × 0.001 px became 0.75 × 0.75 × 0 and disappeared into the head.

## Requirements

Bedrock, Generic and Java models, and the CPM export, need nothing beyond
Blockbench.

The GeckoLib format comes from a plugin of its own: **GeckoLib Models &
Animations** on Blockbench 5, **GeckoLib Animation Utils** on Blockbench 4 (it
does not install on 5). The import dialog offers GeckoLib either way; when it is
chosen and missing, the plugin names whichever of the two installs on your build
and opens the plugin list on it, while the dialog stays open for another choice.

Downloading from Sketchfab needs a personal API token, available in the Sketchfab
profile settings under *Password & API*. Searching works without one.

## Usage

**Search:** File → Import → *Import from Sketchfab*.

The **Made in Blockbench** box is ticked by default: only models tagged
`blockbench` are listed. They are mostly built from cubes and convert whole,
while most of Sketchfab is sculpts that leave only a pile of bounding
boxes. Measured on the live API for "girl": without the filter 0 of 24 results
carry the tag, with it 24 of 24, on the second page as well. The box can be
unticked.

The **Animated** box, off by default, leaves only models with at least one
animation: 24 of 24 with it, 3 to 13 of 24 without, depending on the query. Every
card shows the model's triangle count and number of animations, with the meaning
in the tooltip; both come with the search results, so they cost no extra request.

The tag is no guarantee: anyone can set it by hand, and Blockbench makes meshes
too. So a card also says whether the model looks **built from cubes**, from the
same two counts. Sketchfab counts vertex positions, and a separate cube has 8 of
them to 12 triangles — exactly 2:3. A cube icon means exactly that ratio; a
warning icon means shared corners (below 0.6 vertices per triangle), which is how
smooth and bevelled models look. Measured on 144 tagged models, with every
preview looked at: all 24 looked at of the 84 at exactly 2:3 were cubes, and
most of the 21 below 0.6 were cars with round wheels, bevelled houses and smooth
figures. In between there is no icon, because there it is mixed.

**Order.** The list next to the boxes puts the results in order: *Relevance*
(Sketchfab's own), *Most liked*, *Most viewed* or *Newest*. The choice is
remembered. Each order was checked on the live API, both pages of it: the second
carries on where the first stopped, with no model twice. There is no order by
downloads — the results carry no download count, and the API takes
`sort_by=-downloadCount` without complaint and returns the newest models instead,
so offering it would have been a quiet lie.

**Look before downloading.** The 3D button on a card's picture opens
Sketchfab's own viewer inside the search window: the model can be turned, and
its animations played, before anything is downloaded. *Import* beside it
downloads it as a click on the card does, *Open on Sketchfab* opens its page in
the browser, and *Results* goes back to the list. A click on the card itself
still imports at once.

**The author's original, when it is Blockbench's.** Sketchfab keeps two archives
of a model: its own conversion to glTF and the file the author uploaded. A model
uploaded straight from Blockbench has Blockbench's own glTF as its original, and
the conversion can spoil it — it was seen dropping a texture's transparency, so a
fifth of a model's faces came out black, and it wraps every model in extra
nodes. So for such models the original is downloaded; for any other, or when the
original holds no glTF, the conversion is, as before. The report says when the
original was taken.

**Import:** File → Import → *Import glTF Model*, or the tile on the start
screen.

**Format.** The first field of the import dialog is what to build into:

| Format | For | Bones and animations |
|---|---|---|
| GeckoLib | Java mods using GeckoLib | yes |
| Bedrock Entity | Bedrock add-ons | yes |
| Generic Model | converting further with *File → Convert Project*, or exporting glTF/OBJ | yes |
| Java Block/Item | resource packs | no, the model is still |

The last choice is remembered. Without GeckoLib installed the dialog starts on
Bedrock.

A **Java block or item model** has no bones and does not animate, so the model
arrives still. It also has a box to stay in: every element within −16…32 on each
axis, the block and one block around it. The model is moved into that box — with
centring on, it stands on the block the way block models do — and shrunk only if
it is larger than the box. Which Minecraft can show it depends on its cube
rotations: one axis in 22.5° steps works everywhere, any angle on one axis needs
1.21.6, and cubes turned on several axes or past 45° need 1.21.11. The report
says which one the model needs, and the project's Java format is raised to it.

**Adding to the open project.** With a project open in one of these formats, the
dialog offers *Add to the open project*. The model then takes that project's
format and arrives as one folder: into the selected folder, standing on its
pivot, so a sword put into a hand turns with it; to the top level when nothing
is selected. Its folders never take a name the project already has, and its
animations are left out unless *Add its animations too* is ticked, in which case
they carry the model's name in front of theirs.

The texture joins the project's the way the format allows:

| Format | The model's texture |
|---|---|
| GeckoLib, Bedrock Entity | drawn beside the project texture, which grows to hold both |
| Generic Model | added as a texture of its own, with its own UV size |
| Java Block/Item | added as a texture of its own, its UV fitted to the project's UV size |

The first two allow one texture per model. UV count pixels, so the old texture
stays in its corner and every UV already made keeps reading the same pixels; a
texture painted at twice its UV size gets the model's drawn twice as large too. A
texture with layers is refused, since redrawing it would merge them. The whole
import is one undo step, closed only once the texture is drawn.

**A folder works in place of an archive.** In the same picker you can select the
files of an already unpacked folder — the model, its `.bin` and the textures —
instead of a `.zip`. Below the parser there is no difference: unpacking an
archive does nothing but fill a map of file name to bytes, and selecting files
fills the same map. So it is one menu entry, not two, and a folder needs no
JSZip, which means it also works in builds that have none.

When a folder holds several `.gltf` files — a Sketchfab export ships a twin with
no textures next to the model — the one declaring the most images is chosen.
It used to be whichever came first, which depended on the order of names.

**The outliner is tidied.** Every glTF node used to become a folder, and a
Sketchfab export nests them deep: three wrapper nodes on top, then every cube in
a node of its own, inside another node holding its mesh. Folders that hold one
thing or nothing and carry no animation are dropped — on the local collection
1691 folders became 217 — which changes no shape, since bones stand unrotated.
Every animated folder stays. A cube takes its author's name (`cube`, not
`_gltfNode_2`), and Sketchfab's `_N` numbering is taken off when every name
carries it. *Keep every glTF node as a folder* under Advanced settings turns this
off.

Besides the format, the dialog offers five settings: model size, centring,
extra rotation around X and Y, and whether to transfer animations. Everything else lives behind the
**Advanced settings** checkbox — those are levers for diagnosing breakage, and
they are best changed one at a time.

**Install:** Blockbench → File → Plugins, search for *glTF to Minecraft*. A
version from this repository installs through *Load Plugin from File* →
[`plugin/gltf_to_minecraft.js`](plugin/gltf_to_minecraft.js).

## Questions people ask

### How do I import a Sketchfab model into Blockbench?

Install the plugin, then *File → Import → Import from Sketchfab*. Search, click a
card, and the model is downloaded and converted into cubes. Searching is free;
downloading needs a free Sketchfab API token, from *Settings → Password & API* on
Sketchfab. Only models their author allows to be downloaded are listed.

### How do I convert a glTF or GLB model into a Minecraft model?

*File → Import → Import glTF Model*, then pick a `.zip`, or the `.gltf`/`.glb`
file together with its `.bin` and textures. Choose what to build into —
GeckoLib, Bedrock Entity, Generic Model or a Java block/item model — and the model
arrives as cubes, with bones, textures and animations where the format has them.

### How do I turn a 3D model into a GeckoLib entity or a Bedrock mob?

Import it as above and choose *GeckoLib* (Java mods) or *Bedrock Entity*
(add-ons). The bones keep their hierarchy and animations are carried over, so the
project can be exported from Blockbench as it is. GeckoLib needs its Blockbench
plugin, which the dialog points to.

### How do I make a block or item model for a resource pack from a glTF?

Choose *Java Block/Item* in the import dialog. The model is fitted into the box
Minecraft allows, and the report says which Minecraft version its cube rotations
need.

### Can I use a 3D model as a Customizable Player Models skin?

Yes: *File → Import → Import glTF as Customizable Player Model* runs the same
import, asks for the height and which bone is which part of the player, and saves
a `.cpmproject`. See [Customizable Player Models](#customizable-player-models).

### Blockbench opens my glTF as meshes. How do I get cubes?

Blockbench's own glTF import keeps every element a mesh, which Minecraft formats
cannot take. This plugin rebuilds the model out of cubes instead: boxes stay
boxes, and rounded or bevelled parts become thin turned plates.

### Are animations kept?

Yes, for GeckoLib, Bedrock Entity and Generic Model: rotation and position
channels are carried over. Java block and item models do not animate, so the
model arrives still.

### Why do some faces come out black, or the whole model wear one texture?

Usually the file lost something on its way — a texture's transparency, or which
part uses which material. The report says so when it can tell;
[troubleshooting](docs/troubleshooting.md) lists the causes and what to do.

### Is it free?

Yes, under the MIT licence. Imported models keep their own licences; for a model
from Sketchfab the report prints its author and licence, so the credit is not lost.

## Testing without Blockbench

The converter core does not depend on Blockbench, so it can be exercised from
Node. This catches maths errors without opening the editor:

```bash
node tools/verify-conversion.mjs model/model.obj    # box detection and UV layout
node tools/verify-gltf.mjs        model/model.obj    # glTF parsing against a baseline
node tools/verify-snap.mjs                           # grid snapping and its cost
node tools/verify-coplanar.mjs                       # coplanar face separation
node tools/verify-images.mjs                         # PNG/JPEG/GIF/WebP headers
node tools/verify-import-limits.mjs                  # hostile input limits and valid controls
node tools/verify-cpm.mjs                            # .cpmproject: structure, limits, geometry
node tools/verify-java-fit.mjs                       # Java models: the box and the Minecraft version
node tools/verify-outliner.mjs                       # the outliner: folders dropped, none animated lost
node tools/verify-per-face-textures.mjs              # a texture per face, and faces with none
node tools/verify-rounded.mjs                        # parts that are not boxes: plates, strips, texel, culling
node tools/verify-quirks.mjs                         # file quirks: hair-thin panels, specular-glossiness, outline shells
node tools/verify-add-to-project.mjs                 # adding to an open project: texture placement, names
node tools/verify-strips.mjs                         # triangle strips and fans, on real models
node tools/verify-search-filter.mjs --live           # Sketchfab filters and orders, against the live API
node tools/smoke-plugin.mjs                          # the whole import path
node tools/survey-models.mjs                         # what the import makes of every model in test/model
```

`smoke-plugin` substitutes Blockbench objects (`Cube`, `Group`, `Animation`,
`THREE`, `JSZip`…) and runs the entire import on several archives: PNG, JPEG with
an unreadable image, an image nobody refers to, objects naming no image, a
texture without the alpha its material asks for, and the same model as loose
folder files. Then it builds the same model into Bedrock, Generic and Java, and
checks the Java one against the box and its format version. It adds the model to
open projects of every format — into a folder, beside a texture painted at twice
its UV size, into an empty one — and refuses a layered texture. It also checks that
every entry sits in File > Import, and what happens without GeckoLib on
Blockbench 4 and 5. The CPM export runs after them, down the same path but saving
a `.cpmproject`. It catches what
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
so the import report always prints the author and the licence from the archive —
or, for the author's original, which carries none, from the model's page.
