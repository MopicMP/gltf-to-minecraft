# Why a model comes out wrong

The import report is the first place to look: every case below leaves a line in
it. The report can be saved to a file from its window.

## The figure is black or dark where it should be skin

**Cause:** the texture lost its alpha channel. A Minecraft-style figure has an
outer shell that is transparent wherever it is unused; without alpha that shell
becomes solid and hides the body. The report says *Texture without an alpha
channel, though the material asks for transparency*.

**What to do:** download the model through *File > Import > Import from
Sketchfab*, which keeps the textures as they are. A channel lost somewhere along
the way cannot be recovered from the file.

## The whole model wears one texture

**Cause:** the file itself points all of its geometry at a single material, and
the other images have nothing to land on. The report says *Colour textures no mesh
references: N of M*. Nothing in such a file tells which part each image belongs to.

## The model is a pile of blocks

**Cause:** it is not made of boxes. Sculpted and scanned models have no cubes in
them; each object is replaced with its bounding box. The report gives the share:
*Not boxes: N — replaced with their bounding box*, and at 30% or more it says the
model is a poor fit.

**What to do:** choose models built from cubes. The Sketchfab search lists only
models tagged `blockbench` by default (*Made in Blockbench*) — those convert
whole.

## The model lies on its side or faces the wrong way

**Cause:** the author worked with a different "up" axis, and the file does not
say which. **What to do:** use *Extra rotation around X* / *Extra rotation around
Y* in the import dialog.

## The model is tiny or huge

**Cause:** the scale is derived from texel density, and some models do not follow
that convention. The report lists the chosen factor and the alternatives.
**What to do:** pick another *Model size* in the dialog, or set a *Custom scale*
under *Advanced settings*.

## "This archive has no glTF model"

**Cause:** the archive holds only the author's source files (`.blend`, `.fbx`).
**What to do:** download the *glTF* (autoconverted) version instead of *Original*.
The plugin's own Sketchfab download requests it automatically.

## "GeckoLib plugin required"

The project is built in the GeckoLib format, so the **GeckoLib Animation Utils**
plugin must be installed. Converting an already open model (*Filter > Convert
Meshes to Cubes*) works without it.

## The CPM export is over 30 kB

A local `.cpmmodel` holds 30 kB; animations take most of it. Transfer fewer
animations or lower the sampling rate. *File > Test ingame* in CPM works at any
size.
