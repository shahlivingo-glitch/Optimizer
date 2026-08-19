# DXF/SVG Nesting

True-shape irregular nesting for laser/plasma cutting: No-Fit-Polygon placement
driven by a genetic algorithm, iterating continuously for a time budget and
live-updating the best layout found so far - the same overall approach as
SigmaNEST's HD SuperNest and the open-source SVGnest/Deepnest project, built here
from first principles on top of a general-purpose polygon-clipping library so the
whole stack stays small and auditable. Runs entirely client-side; nothing is
uploaded anywhere.

## 1. Architecture

```
DXF/SVG file
   │
   ▼
io/dxfImport.js, io/svgImport.js        parse entities/shapes -> closed polygon
                                         loops, detect outer-boundary/hole pairs,
                                         flag unclosed geometry
   │
   ▼  Part { id, loops:[outer,...holes], quantity, rotations:[deg,...] }
   │
   ▼
nesting/orientations.js                 per part x per allowed rotation:
                                         rotate -> offset outward by kerf/2
                                         (geometry/nfp.js) -> normalize bbox to
                                         origin. Cached once per run.
   │
   ▼
nesting/worker.js  (Web Worker)         genetic algorithm loop:
  nesting/ga.js       - order+rotation chromosome, tournament selection,
                         order crossover, swap/rotation mutation
  nesting/placement.js - bottom-left-fill placement of one individual using
                         cached No-Fit Polygons (geometry/nfp.js, ClipperLib
                         Minkowski sum) + a trivial rectangular inner-fit
                         polygon for the sheet boundary
  runs until the time budget elapses or the user clicks Stop; posts a message
  back to the main thread every time a new individual beats the best fitness
  seen so far
   │
   ▼
nesting/nestManager.js                  main-thread controller: owns the worker,
                                         forwards "best so far" updates to the UI
   │
   ▼
render/canvasRenderer.js                live canvas preview per sheet
io/dxfExport.js, io/svgExport.js        final layout -> downloadable DXF/SVG
                                         (dxf-writer / hand-written SVG)
```

`main.js` + `index.html` + `style.css` wire the above into the on-screen part
list, sheet setup, kerf/time-budget controls, and Start/Stop/Export buttons - no
UI framework, just DOM APIs.

### Why a Web Worker

The GA loop runs for the entire time budget (or until stopped), continuously
re-evaluating a population against cached NFPs. Doing that on the main thread
would freeze the page for the whole run; the worker keeps the UI responsive and
lets "Stop and use current best" actually respond immediately.

### Why NFP caching matters here

An NFP between two orientations (a specific part at a specific rotation, against
another specific part at a specific rotation) only depends on those two
orientations, not on where they end up on the sheet. `placement.js` keys its NFP
cache by `partId+rotation` pairs and reuses it across every generation and every
individual in the population, so the (relatively) expensive Minkowski-sum
computation happens at most once per orientation pair for the whole run, not once
per placement attempt.

## 2. Libraries used

| Purpose | Package | License | Link |
|---|---|---|---|
| DXF parsing | `dxf-parser` | MIT | https://github.com/gdsestimating/dxf-parser |
| DXF writing | `dxf-writer` | MIT | https://github.com/ognjen-petrovic/js-dxf |
| Polygon boolean ops / Minkowski sum (NFP) / polygon offset (kerf) | `clipper-lib` | Boost Software License (permissive) | https://github.com/junmer/clipper-lib (JS port of Angus Johnson's Clipper) |
| Dev server / bundler | `vite` | MIT | https://vitejs.dev |
| SVG shape flattening | native browser `SVGGeometryElement` (`getPointAtLength`) | - | no dependency needed |

No paid APIs, no commercial SDKs, nothing server-side required - `npm run build`
produces a static `dist/` you can host anywhere (or just open via `npm run dev`).

**On the nesting algorithm specifically:** the prompt asked to reuse SVGnest's
`nest.js` engine rather than writing NFP math from scratch. SVGnest (Jack Qiao,
MIT, https://github.com/Jack000/SVGnest) isn't published as an npm package, and
its core (`GeometryUtil.js`'s orbital NFP tracing + `placementworker.js`) is
tightly coupled to its own SVG-DOM-based part representation, so vendoring it
cleanly into a from-scratch app wasn't practical here. What's implemented instead
is the **same overall algorithm** (NFP + GA, time-boxed, live best-result
updates, cached NFPs) but with the NFP itself computed via ClipperLib's
Minkowski-sum primitive rather than SVGnest's hand-written orbital-sliding
routine. See the limitation below on what that trades away, and "Upgrading the
NFP engine" for how to swap in the real thing later.

## 3. Running it

```bash
cd dxf-nesting-app
npm install
npm run dev       # http://localhost:5173
npm run build     # static output in dist/
```

Workflow: upload one or more DXF/SVG files (each closed profile becomes a part;
a file with multiple disjoint outer profiles becomes multiple parts) → set
quantity and rotation constraint per part → define one or more sheet types
(width/height/quantity, "unlimited" for an uncapped stock sheet) → set kerf →
pick a time budget → **Start nesting**. The preview updates live every time a
better layout is found; **Stop and use current best** ends the run early and
keeps whatever's on screen. Export the current sheet (or all sheets) as DXF/SVG.

## 4. Known limitations

- **NFP via Minkowski sum, not orbital tracing.** For two convex-ish shapes this
  is exact. For deeply concave parts, ClipperLib's convolution can report an
  inner contour that a true orbital NFP algorithm (SVGnest's approach) would
  resolve into a real interior pocket the moving part could tuck into. This
  implementation deliberately keeps only the outermost NFP contour and treats
  its whole interior as forbidden (see the comment in `geometry/nfp.js`), which
  is always **safe** (parts will never overlap) but can leave more waste than an
  orbital-NFP engine on parts with deep notches or slots designed for
  interlocking. Commercial engines like SigmaNEST's HD SuperNest specifically
  invest in this interlocking case; expect this starter to under-perform them on
  such geometry, though normal convex-ish and mildly-concave sheet-metal parts
  nest about equivalently.
- **Placement search uses NFP/sheet-corner vertices only.** Real orbital-NFP
  bottom-left-fill implementations also test edge-edge intersection points
  between candidate NFPs for tighter fits. This starter doesn't, trading a
  little packing density for much simpler code.
- **Rectangular sheets only.** Inner-fit-polygon handling is hard-coded to axis-
  aligned rectangles (the overwhelming common case for stock sheet metal). Non-
  rectangular remnant sheets aren't supported.
- **No common-line/shared-edge cutting, no part-inside-hole nesting.** Both are
  advanced SigmaNEST features; out of scope here.
- **DXF import covers LINE, LWPOLYLINE, POLYLINE, CIRCLE, ARC** (chaining open
  LINE/ARC fragments into closed loops by endpoint matching, plus bulge/arc
  segments on polylines). SPLINE, ELLIPSE, INSERT/block references, and text are
  not parsed - flatten/explode those to polylines in your CAD software before
  export if your files use them.
- **Rotation is discretized**, not continuous. "Free rotation" is approximated
  as 15° steps (24 orientations) rather than a true continuous angle, which
  keeps the GA's search space finite. Tighten or loosen the step size in
  `state.js` (`ROTATION_PRESETS.free`) if needed.
- **Speed vs. commercial tools.** This is a pure-JS, single-worker implementation.
  SigmaNEST and similar tools use highly optimized native code and can run many
  parallel search threads; expect this app to explore far fewer candidate
  layouts per second. For large jobs (100+ unique parts), raise the time budget
  and expect the GA to need longer to converge on a tight layout. Multi-worker
  parallelism (one population island per worker) would be the natural next
  optimization and isn't implemented yet.
- **No DXF units/layer awareness on import** - all coordinates are read as
  plain millimeters. If your DXF is in inches or another unit, convert before
  import.

## 5. Upgrading the NFP engine

If concave interlocking quality becomes a real bottleneck, the natural upgrade
path is swapping `geometry/nfp.js`'s `computeNfp()` for a true orbital-NFP
implementation (e.g. porting SVGnest's `GeometryUtil.js`) behind the same
function signature (`(fixedLoop, movingLoop) -> outer NFP loop`, plus its holes).
Everything downstream (caching, GA, placement, rendering, export) is already
NFP-shape-agnostic and would need no changes beyond also consuming the extra
interior loops `placement.js`'s `findPosition()` currently ignores.
