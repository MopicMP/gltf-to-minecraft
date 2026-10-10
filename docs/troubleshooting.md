# Why a model comes out wrong

The import report is the first place to look: every case below leaves a line in
it. The report can be saved to a file from its window.

## The figure is black or dark where it should be skin

**Cause:** the texture lost its alpha channel. A Minecraft-style figure has an
outer shell that is transparent wherever it is unused; without alpha that shell
becomes solid and hides the body. The report says *The material asks for
transparency, but the texture has no alpha channel*.

**What to do:** download the model through *File > Import > Import from
Sketchfab*: for a model uploaded from Blockbench it takes the author's original,
whose texture keeps its alpha (see *Some faces are black on a model from
Sketchfab*). A channel lost somewhere along the way cannot be recovered from the
file.

## The whole model wears one texture

**Cause:** the file itself points all of its geometry at a single material, and
the other images have nothing to land on. The report says *Colour textures no mesh
references: N of M*. Nothing in such a file tells which part each image belongs to.

## The model is a pile of blocks, or of thin plates

**Cause:** it is not made of boxes. Sculpted and scanned models have no cubes in
them. By default each such part is rebuilt from plates that follow its surface —
*Not boxes: N — rebuilt from plates* — which keeps the shape but multiplies the
cubes; with *Approximate with a bounding box* in the advanced settings each part
becomes one block instead.

**What to do:** choose models built from cubes. The Sketchfab search lists only
models tagged `blockbench` by default (*Made in Blockbench*) — those convert
whole.

## Some faces are black on a model from Sketchfab

**Cause:** Sketchfab's own conversion to glTF can drop a texture's transparency
together with the material's `alphaMode`: what was see-through — windows, the
unused sides of a cube — comes out solid black, and nothing in the file says it
was ever clear. Guessing it back from the colour would punch holes in real black.

**What to do:** for a model uploaded straight from Blockbench, the plugin's
Sketchfab search already downloads the author's original, which keeps the
transparency; the report then says *Downloaded: the author's original*. When
downloading by hand, pick *Original format* for such a model: it holds
Blockbench's own glTF and imports as is.

## An outline around a part is missing

**Cause:** the outline was an inside-out copy of the part on a one-sided material,
drawn only from behind. Minecraft draws cubes from both sides, where such a copy
would cover the part with a dark casing, so it is left out; the report says
*Outline shells left out: N*.

## The model lies on its side or faces the wrong way

**Cause:** the author worked with a different "up" axis, and the file does not
say which. **What to do:** use *Extra rotation around X* / *Extra rotation around
Y* in the import dialog.

## The model is tiny or huge

**Cause:** the scale is derived from texel density, and some models do not follow
that convention. The report lists the chosen factor and the alternatives.
**What to do:** pick another *Model size* in the dialog, or set a *Custom scale*
under *Advanced settings*.

## The import says the model, the archive or a texture is too large

**Cause:** the file is valid, but bigger than the import takes. The limits keep a
runaway file from hanging Blockbench; in practice they stop whole scenes (towns,
cathedrals of millions of vertices), almost never a figure.

| What | Limit |
|---|---|
| Nodes | 20,000 |
| Hierarchy depth | 256 levels |
| Links between nodes | 40,000 |
| Entries in one list of model data | 1,000,000 |
| Values of geometry and animation, all together | 4,000,000 |
| Archive | 64 MB, 4,096 files |
| One file, unpacked | 64 MB |
| Archive, unpacked in all | 128 MB |
| One colour texture | 8,192 on a side, 16,777,216 pixels |
| Colour textures, all together | 33,554,432 pixels |

- Only colour textures count. Normal and roughness maps are left out of the atlas
  anyway, so one too large is left out without stopping the import.
- Animations are read after the geometry and share its budget. Past it, the
  remaining animations are dropped with a line in the report, and the model
  itself still comes in.
- In *Import from Sketchfab* a model whose archive is over 64 MB is marked on its
  card, and its download is refused before it starts.

**What to do:** the message names the limit and what to change: simplify the
model or split it into parts, remove the files it does not need from the archive,
or reduce the textures, then export it again.

## The import stops on a damaged file

**Cause:** the file breaks the glTF format: a node hierarchy that loops back on
itself (*glTF node hierarchy contains a cycle*), data pointing past the end of its
buffer, an archive cut short. The message names what is broken. Smaller damage
does not stop the import: a broken animation channel is skipped with a line in
the report, and a PNG the plugin cannot read is handed to Blockbench's own
decoder.
**What to do:** export the model again from the editor it was made in, or
download it again.

## "This archive has no glTF model"

**Cause:** the archive holds only the author's source files (`.blend`, `.fbx`).
**What to do:** download the *glTF* (autoconverted) version instead of *Original*.
The plugin's own Sketchfab download requests it automatically.

## "GeckoLib plugin required"

GeckoLib was chosen as the format, and it comes from a plugin of its own:
**GeckoLib Models & Animations** on Blockbench 5, **GeckoLib Animation Utils** on
Blockbench 4. The old one does not install on Blockbench 5. *Open plugin list* in
the message opens the list on the right one. If it says the plugin is installed
but disabled, enable it there. The import dialog stays open behind the message,
so another format can be picked instead: Bedrock, Generic and Java need no plugin.

## A Java model shows up broken in the game

**Cause:** cubes turned on several axes, or past 45°, exist in Java models only
from Minecraft 1.21.11; any angle on one axis, from 1.21.6. An older game does
not show them as built. The import report says which version the model needs.

**What to do:** use that version or newer, or pick a model built from unturned
cubes.

## A Java model came out smaller than expected

**Cause:** a Java block or item model has to fit −16…32 on each axis — three
blocks. A larger model is shrunk to fit, and the report says by how much.

**What to do:** nothing, if the size is fine; the item's display settings in
Blockbench can scale it back up in hand or on the head. For a model that must
stay big, build into GeckoLib or Bedrock instead.

## A card says "probably not built from cubes"

**Cause:** the model's corners are shared, as on smooth and bevelled meshes. The
`blockbench` tag does not rule that out: anyone can set it, and Blockbench makes
meshes too.

**What to do:** expect slopes and curves to become boxes, or pick a model with the
cube icon. With no icon the counts cannot tell either way.

## The CPM export is over 30 kB

A local `.cpmmodel` holds 30 kB; animations take most of it. Transfer fewer
animations or lower the sampling rate. *File > Test ingame* in CPM works at any
size.

## "Cannot add the model"

Adding to the open project redraws the project texture with the model's beside
it, and three textures cannot be redrawn that way: one with **layers** (they would
be merged), an **animated** one (its frames would break), and one that **never
loaded**. Merge the layers into one, or build the model as a new project and copy
it over.

## The project texture file did not change

After adding to a GeckoLib or Bedrock project the texture in Blockbench holds both
pictures, but the file on disk does not until the texture itself is saved, from
the Textures panel. Saving the project alone keeps the picture inside the
project file.
