# Figma Canvas UI Structure & Workflows — Synthesized Reference (Task R3b)

Synthesized from ~26 full help.figma.com pages + ~37 web-search result files collected by agent R3, plus 6 targeted gap-fill searches (R3b). Reflects **current Figma UI ("UI3", post-2024 navigation bar redesign)**. Items not confirmed by raw data are marked **unverified**.

## 0. Top-level layout (current UI3)

A Figma Design file has **five regions** (help: "Explore design files"):
- **(A) Navigation bar** — left-most vertical bar: Figma menu, Files tab, Agents tab, Assets tab, Tools tab, Variables view, file notifications (bottom).
- **(B) Left sidebar** — dynamic panel whose content follows the selected navigation-bar tab (File tab = pages + layers; Assets; etc.). Resizable by dragging its right edge.
- **(C) Canvas** — main scrollable workspace.
- **(D) Right sidebar** — "properties panel": Design/Prototype tabs (edit access) or Comment/Properties tabs (view access); also share/present actions and the zoom/view-options menu at its top-right.
- **(E) Toolbar** — creation tools, Actions menu (quick actions), and mode switcher (Design ↔ Dev Mode, Present).

Important: the classic top menu bar (Figma/File/Edit/View/Object/Text/Plugins/Help) has been replaced by the **Figma menu (Main menu)** + **Actions menu** + **Edit file menu** in the current UI (see §5). Minimize UI: **⌘⇧\\ (Mac) / Ctrl⇧\\ (Win)** collapses navigation bar + both sidebars.

## 1. Left sidebar inventory

**Navigation bar tabs** (in order): Figma menu (top), **Files**, **Agents**, **Assets**, **Tools**, **Variables view**, file notifications (bottom).
- **Figma menu**: app commands, layer actions, file creation, file preferences (dark mode, etc.).
- **File tab** (shortcut **⌥1 / Alt 1**): Edit file menu (chevron next to file name: rename file, version history, color profile, move file), **Find/Replace** (search whole file for text, images, frames, components; bulk text replace), **Pages panel**, **Layers panel**, Minimize UI.
- **Assets tab** (**⌥2 / Alt 2**): local components + components from kits/libraries; search field; Libraries modal (**⌥3 / Alt 3**) with "Review library updates" blue-dot badge; grid/list view toggle; drag component → canvas creates an instance. Components grouped by heading, path shown as file > page > frame.
- **Tools tab**: plugins, widgets, shaders, Weave tools (search + filters, "Created by Figma" filter).
- **Variables view**: create/edit variables, modes, collections (moved out of right sidebar in UI3).
- **Agents tab**: Figma agent chat history; "New chat" button.

**Pages panel**: each page has its own canvas/prototypes; click page name to browse; right-click page > **Copy link to page**.

**Layers panel**:
- New layers added to **top** of list (or top of parent, or above current selection). Top layer = front (z-order); top-level frames are **bolded** and their names shown on canvas.
- Layer-type icons: Frame, Group, Component (purple), Instance, Text, Shape (varies), Image, Auto layout (varies by flow), Section, Animated GIF/video, Slot.
- Disclosure **arrow** next to frames/groups/components/sections expands/collapses children; **Collapse layers** button (top-right of panel) collapses all (keeps current selection expanded).
- **Rename**: double-click layer name, or right-click > Rename, or **⌘R / Ctrl+R** (opens Rename Layers modal; supports bulk rename rules).
- **Lock**: **⌘⇧L / Ctrl+Shift+L** (also right-click > Lock/Unlock; locked layers can only be selected via Select Layer menu, shown with padlock icon). Unlock all: **Ctrl⌥⇧L** (forum-reported).
- **Hide**: **⌘⇧H / Ctrl+Shift+H** (toggle visibility).
- **Highlight layers on hover** preference (Menu > Preferences > Highlight layers on hover); hovering a row highlights the object on canvas in blue.
- Selection in panel: ⇧+click = range; ⌘/Ctrl+click = individual layers.

## 2. Toolbar tools + shortcuts

Toolbar groups (help: "Access design tools from the toolbar"), left→right:
1. **Move tools** (dropdown): **Move** (default tool; shortcut V — *unverified in raw data, universally documented*), **Hand** (**H**; also hold **Space** to temporarily activate; touch-screen pan), **Scale** (**K**).
2. **Region tools** (dropdown): **Frame** (**F** or **A**), **Section** (**⇧S**), **Slice** (**S** — *third-party verified*; Slice = specify an export region; lives under Region tools per help "Export static designs").
3. **Shape tools** (dropdown; Rectangle default): Rectangle (**R**), Line (**L**), Arrow (**⇧L**), Ellipse (**O**), Polygon, Star, Image/video ("Place image", **⇧⌘K / Shift+Ctrl+K**). *Note: Figma uses a dropdown menu, not individual letter keys for each shape — only R, L, ⇧L, O have direct keys; Polygon/Star/Place image must be picked from the menu (raw data lists no keys for them).*
4. **Creation tools** (dropdown): **Pen** (**P**), **Pencil** (**⇧P**, freehand with smoothing).
5. **Text** (**T**; click = auto-width text, click-drag = fixed-size text).
6. **Comment tools** (dropdown): **Comment** (**C**), Annotation (Full seat), Measurement (Full seat).
7. **Actions menu** (quick actions, **⌘K / Ctrl+K**): AI tools (Make designs, Make prototypes, Rename layers, Replace content, Riffing and writing, Generate images/remove backgrounds), productivity actions, asset search, plugins/widgets.
8. **Dev Mode toggle** (**⇧D**), **Draw** (Figma Draw), **Present** button.

**Zoom/view options menu** (click the zoom percentage, top-right of right sidebar / right side of toolbar): zoom presets + custom %, **Pixel preview** (1x / 2x / Disabled), **Pixel grid**, **Snap to pixel grid**, **Layout guides**, **Multiplayer cursors**, **Property labels**, **Prototyping** (view-only), **Outlines > Show outlines / Include hidden layers / Include object bounds**.

## 3. Right sidebar (Properties panel)

Tabs: **Design** + **Prototype** (edit access) / **Comment** + **Properties** (view access). Property labels toggle via the zoom/view-options menu.

**Nothing selected (Design tab)**: file-local styles & variables, canvas background color, export entire page. (Page properties: page background + export.)

**Layer selected — property areas** (help order): Alignment, rotation, and position; Frame size and orientation (frame preset dropdown: Phone, Tablet, Desktop, Presentation, Watch, Paper, Social Media, Figma Community, Archive); Corner radius; Constraints; Layout guides; Component properties; Instance; Auto layout; Blend modes; Text; Fill; Stroke; Effects; Export settings. UI3 groups these under **Layout / Appearance / Auto layout / Constraints / Fills / Stroke / Selection colors / Effects / Export** chips (help: "Explore design files" property matrix).

- **Alignment row** (top of Design panel): Align left / horizontal centers / right / top / vertical centers / bottom; shortcuts **⌥A / ⌥W / ⌥D / ⌥S / ⌥H / ⌥V** (Alt+A/W/D/S/H/V). ⇧+click an alignment control = align selection as group to parent frame. **Distribution**: Distribute horizontal/vertical spacing (≥2 layers; outermost layers pinned). **Tidy up**: "Tidy up vertical/horizontal selection" (1-D) or "Tidy up" (2-D grid); space-between value shown in selection field; smart selection pink modifiers.
- **Position**: X, Y (top-left of bounds; math equations supported: `+ - * / ^ ()`, e.g. `+10`, `*2`, `50%`), nudge with arrow keys (small nudge 1pt, ⇧+arrows = big nudge 10pt; configurable in Preferences > Nudge amount).
- **Rotation**: field at top of Design panel; canvas drag outside bounds; ⇧ = 15° increments; rotation origin via **⌥R / Alt R**. Flip horizontal **⇧H**, vertical **⇧V** (also right-click menu).
- **Dimensions**: W/H fields (scrub by dragging label; ⌥/Alt+hover field), dimension label under bounding box, **Lock aspect ratio** (chain icon in Layout/Auto layout section; ⌃ temporarily overrides while resizing; ⇧ temporarily enables), Resize to fit (**⌥⇧⌘R / Alt+Shift+Ctrl+R** or button in Layout section).
- **Per-axis resizing (auto layout children)**: W/H dropdowns per axis — **Fixed width/height**, **Hug contents** (auto layout frames only; double-click edge to set), **Fill container** (children only; ⌥+double-click edge), plus **Add min/max width/height** (icon gains two side lines when set; "Remove min and max" from dropdown). Resizing preview lines shown on hover.
- **Auto layout section**: flows **Vertical / Horizontal / Grid**; **Wrap** (horizontal flow); **Gap** (number or **Auto** → Between / Around / Evenly); **Padding** (uniform, per-side; ⌘+click padding field = edit all sides; on canvas ⌥ = opposite sides, ⌥⇧ = all sides, ⇧ = big nudge); **alignment box** (arrows = align, W/A/S/D = align to edge, **B** = toggle baseline alignment, **X** = toggle gap-between). Add auto layout **⇧A**; remove **⌥⇧A**; suggest **⌃⇧A** (Mac) / **Ctrl⌥⇧A** (Win).
- **Constraints** section: for children of regular frames (not auto layout children, unless "Ignore auto layout" — formerly absolute position).
- **Layer/appearance**: Blend modes, **Fill** (color/gradient/image; images are fills), **Stroke** (color, weight, align center/inner/outer, dashes, caps; Advanced stroke menu), **Effects** (shadows, blurs), **Selection colors** (mixed selection fills/strokes).
- **Export settings** at bottom; formats PNG, JPG, SVG, PDF.
- **Component/Instance section**: **Create component** button next to selection name (**⌥⌘K / Ctrl+Alt+K**); "Create multiple components" option menu; **Instance menu** (in Properties panel) → **Detach instance** (**⌥⌘B / Ctrl+Alt+B**); **Go to main component** (right-click; **⌃⌥⌘K / Ctrl+Alt+Shift+K**); **Create variant** (right sidebar); swap instances (swap via instance menu/assets; Alt+drag a component onto an instance to swap — *partially verified*); overrides (fills/text/instance properties) + **Reset instance**; Component configuration (description, docs link). Main component vs instance edit matrix: padding/gap ✓✓; reorder/add/delete layers main-only (instance delete = hide only).
- **Prototype tab**: flow starting point, Interaction Details modal (trigger/action/animation), scroll behavior, prototype settings; drag connections on canvas; **⇧E** toggles Design ↔ Prototype tabs.

## 4. Menu structure (current app; replaces classic menu bar)

Raw data does **not** document a classic 8-menu bar (Figma/File/Edit/View/Object/Text/Plugins/Help) — the current app exposes commands via:
- **Figma menu / Main menu** (top-left of navigation bar): app commands, layer actions, file creation, preferences. Verified sub-items:
  - **Preferences**: dark mode, Highlight layers on hover, Accessibility settings > Adapt content for screen readers, Snap to settings (Snap to geometry / Snap to objects / Snap to pixel grid), Nudge amount, Keyboard layout, Use old shortcuts for outlines, Ctrl+click opens right-click menus (behavior note), Property labels.
  - **View**: **Rulers** (toggle), **Mask outlines** (green outlines), **Automatically detect icons** (Dev Mode).
- **Edit file menu** (chevron next to file name): rename file, **Show Version History**, color profile, move file.
- **Main menu > Edit** (per Selection article "Go to the File menu and select Edit"): **Select All** with same Properties / Fill / Stroke / Effect / Text properties / Font / Instance.
- **Actions menu** (⌘K / Ctrl+K): see §2.7; also: Paste to replace, Detach instance, Rasterize selection, Flip H/V, Place image/video, Frame selection, Collapse layers, Rename selection/layers, Mark as ready for dev, Show/hide rulers, Show/hide layout guides, Show/hide UI, Use dark mode, Show version history, Save local copy, Export, Snap to pixel grid, Nudge amount, Keyboard shortcuts.
- **Right-click context menu** (canvas): Bring forward / Bring to front / Send backward / Send to back; Copy; Copy/Paste as… (Copy as PNG, Copy as code CSS/iOS/Android, Copy link, Copy properties, Copy text); Paste to replace; Paste here; Select Layer ▸ (nested layers list incl. locked with padlock); Create component; Detach instance; Go to main component / Main component ▸ Restore main component; Flatten; Outline stroke; Use as mask / Remove mask; Group selection; Wrap in new section; Remove guide (on guides).
- Classic menu-bar items (File > New design file ⌘N, Object/Text menu trees, Plugins menu, Help menu) — **unverified in raw data**; the current equivalent is Actions menu + Figma menu + Help and resources (bottom-right) > Keyboard shortcuts (**⌃⇧? / Ctrl+Shift+?** opens shortcuts panel along the bottom of the screen).

## 5. Canvas interactions

- **Pan**: hold **Space** + drag; trackpad two-finger; arrow keys pan when nothing selected (⇧ = faster).
- **Zoom**: **⌘/Ctrl + scroll** (mouse wheel or Magic Mouse); trackpad pinch; zoom shortcuts: Zoom in **⇧+** / Zoom out **⇧−** / **Zoom to fit ⇧1** / **Zoom to selection ⇧2** / Zoom to 100% **⇧0** (*third-party verified*) / **+ or −** or **⌘+/⌘−**; default open = Zoom to fit; **⌘=/⌘−** or `+`/`-` keys.
- **Marquee select**: click-drag empty canvas; **⌘/Ctrl + drag** marquee selects nested layers; ⇧+click adds/removes. Select top-level frame ⇒ only top-level layers selected.
- **Deep select**: **⌘/Ctrl + click** nested object = select child (or top-level frame) directly; **double-click / Enter** descends one nesting level; Select Layer menu via right-click; Enter = select child, **⇧Enter** = select parent (**\** also = Select parent per keyboard-layout table), Tab / ⇧Tab = next/previous sibling.
- **Select matching layers** (multi-edit): **⌥⌘A / Alt+Ctrl+A**; ⇧+click matching objects (no need to double-click into nesting); ⇧+drag marquee = only matching objects added/removed; "Select matching layers" toolbar button. Select inverse: **⌘⇧A** (per article: "⌘A Shift / Ctrl A Shift").
- **Duplicate**: **⌘D / Ctrl+D** (top-level frame duplicates to the right; repeated ⌘D repeats spacing/rotation); **⌥/Alt + drag** duplicates (release click before modifier).
- **Measure**: select object, hold **⌥/Alt**, hover second object → red line + H/V distances; nested: **⌘⌥ / Ctrl+Alt**; guides redlines: with top-level frame selected, ⌥+drag from ruler shows pixel distance. In vector edit mode ⌥+hover between anchor points.
- **Pixel-snap**: Snap to pixel grid on by default behavior — hold **⌃/Ctrl** while dragging to temporarily disable snap-to-geometry/objects (and pixel grid in vector mode zoomed ≥400%); frames/sections/components always snap to pixel grid.
- **Frame draw + presets**: Frame tool F/A, click (100×100 default or last size), drag for custom, click-drag inside frame nests; preset list in right sidebar; quick-add **+** beside a frame duplicates it (⌥+**+** = blank same-size frame); resize ignoring child constraints: hold **⌘/Ctrl** while resizing; **Clip content** frame property hides overflow.
- **Paste behaviors**: paste into selected frame honors relative x/y (centers if it can't fit); **Paste over selection ⌘⇧V / Ctrl+Shift+V** (on top of frame, matches x/y; also used to paste copied PNG); **Paste to replace ⇧⌘R / Ctrl+Shift+R** (right-click; adopts replaced object's constraints); **Paste here** (right-click at cursor; auto layout → pastes on top of frame); multi-paste: copy objects, select multiple frames, ⌘V (objects repeat in copy order).
- **Scale tool (K) vs resize**: Scale resizes entire objects/layers proportionally (styles like stroke scale); Move-tool resize changes W/H only (*details per help "Scale layers while maintaining proportions"; snippet-verified for K*).
- **Guides**: enable rulers (Main menu > View > Rulers), drag from ruler; ⌥+drag from existing guide duplicates it; guides inside frames behave as objects.
- **Boolean ops** (menu; ≥2 layers): Union **⌥⇧U** / Subtract **⌥⇧S** / Intersect **⌥⇧I** / Exclude **⌥⇧E** (Alt+Shift+U/S/I/E on Windows); non-destructive; ungroup to revert.
- **Mask**: **⌃⌘M / Ctrl+Alt+M** (or right sidebar More options > Use as mask with one layer); mask sits below masked siblings; types Alpha / Vector / Luminance (dropdown in Mask section); remove via right-click > Remove mask.
- **Flatten**: **⌥⇧F / Alt+Shift+F** (destructive merge to vector; also flattens text to paths).
- **Outline stroke** (text→vector path): **⌘⌥O / Ctrl+Alt+O**.
- **Presentation view**: **Present** button in toolbar or **⌘⌥Return** (Mac) (Windows keys truncated in snippet — *partially verified*).
- **Multi-edit text**: select multiple text layers, press **Enter**, edit all at once.
- **Keyboard box selection** (accessibility): **⌥Space / Ctrl+Space**, arrows to move cursor, Return to select, Esc to close.

## 6. Consolidated shortcut table

| # | Action | Mac | Windows |
|---|--------|-----|---------|
| 1 | Move tool | V *(unverified in raw data)* | V *(unverified)* |
| 2 | Hand tool (hold) | H / hold Space | H / hold Space |
| 3 | Frame tool | F or A | F or A |
| 4 | Frame selection | ⌥⌘G | Ctrl+Alt+G |
| 5 | Group selection | ⌘G | Ctrl+G |
| 6 | Ungroup | ⌘⇧G (also ⌘Delete for frames) | Ctrl+⇧G (also Ctrl+Backspace) |
| 7 | Section tool | ⇧S | ⇧S |
| 8 | Slice tool | S *(third-party)* | S *(third-party)* |
| 9 | Rectangle / Line / Arrow / Ellipse | R / L / ⇧L / O | R / L / ⇧L / O |
| 10 | Pen / Pencil | P / ⇧P | P / ⇧P |
| 11 | Text tool | T | T |
| 12 | Comment tool | C | C |
| 13 | Show/hide comments | ⇧C | ⇧C |
| 14 | Scale tool | K | K |
| 15 | Place image/video | ⇧⌘K | Shift+Ctrl+K |
| 16 | Add / remove auto layout | ⇧A / ⌥⇧A | ⇧A / Alt+⇧A |
| 17 | Suggest auto layout | ⌃⇧A | Ctrl+Alt+⇧A |
| 18 | Create component | ⌥⌘K | Ctrl+Alt+K |
| 19 | Detach instance | ⌥⌘B | Ctrl+Alt+B |
| 20 | Go to main component | ⌃⌥⌘K | Ctrl+Alt+Shift+K |
| 21 | Copy / Paste | ⌘C / ⌘V | Ctrl+C / Ctrl+V |
| 22 | Duplicate | ⌘D | Ctrl+D |
| 23 | Copy as PNG | ⌘⇧C | Ctrl+Shift+C |
| 24 | Paste over selection | ⌘⇧V | Ctrl+Shift+V |
| 25 | Paste to replace | ⇧⌘R | Shift+Ctrl+R |
| 26 | Undo | ⌘Z | Ctrl+Z |
| 27 | Rename layer | ⌘R | Ctrl+R |
| 28 | Lock/unlock layer | ⌘⇧L | Ctrl+Shift+L |
| 29 | Hide/show layer | ⌘⇧H | Ctrl+Shift+H |
| 30 | Bring forward / to front | ⌘] / ⌘⌥] | Ctrl+] / Ctrl+⇧] |
| 31 | Send backward / to back | ⌘[ / ⌘⌥[ | Ctrl+[ / Ctrl+⇧[ |
| 32 | (alt) Bring to front / send to back | ] / [ | ] / [ |
| 33 | Align top/left/bottom/right | ⌥W / ⌥A / ⌥S / ⌥D | Alt+W / Alt+A / Alt+S / Alt+D |
| 34 | Align vertical/horizontal centers | ⌥V / ⌥H | Alt+V / Alt+H |
| 35 | Flip horizontal / vertical | ⇧H / ⇧V | Shift+H / Shift+V |
| 36 | Rotation origin | ⌥R | Alt+R |
| 37 | Select all | ⌘A | Ctrl+A |
| 38 | Select matching layers | ⌥⌘A | Alt+Ctrl+A |
| 39 | Select child / parent / siblings | Enter / ⇧Enter (also \) / Tab / ⇧Tab | same |
| 40 | Deep select (nested) | ⌘+click | Ctrl+click |
| 41 | Boolean union/subtract/intersect/exclude | ⌥⇧U / ⌥⇧S / ⌥⇧I / ⌥⇧E | Alt+Shift+U/S/I/E |
| 42 | Mask (use as / remove) | ⌃⌘M | Ctrl+Alt+M |
| 43 | Flatten | ⌥⇧F | Alt+Shift+F |
| 44 | Outline stroke | ⌘⌥O | Ctrl+Alt+O |
| 45 | Show outlines (outline mode) | ⌘⇧O (legacy pref: ⇧O) | Ctrl+Shift+O |
| 46 | Zoom in / out | ⇧+ / ⇧− (also +/− or ⌘+/⌘−) | same |
| 47 | Zoom to fit / to selection | ⇧1 / ⇧2 | ⇧1 / ⇧2 |
| 48 | Zoom to 100% | ⇧0 *(third-party)* | ⇧0 *(third-party)* |
| 49 | Pixel grid | ⌘' *(kbd-layout table also lists ⇧')* | Ctrl' |
| 50 | Snap to pixel grid | ⌘⇧' *(kbd-layout table also lists ⇧⌘')* | Ctrl+Shift+' |
| 51 | Layout guides | ⌃G / ⇧G (two help pages differ) | Ctrl+Shift+4 |
| 52 | Pixel preview | ⌃P | Ctrl+Alt+P |
| 53 | Show/hide UI (all panels) | ⌘\ | Ctrl+\ |
| 54 | Show left sidebar | ⇧⌘\ | Shift+Ctrl+\ |
| 55 | Multiplayer cursors | ⌥⌘\ | Ctrl+Alt+\ |
| 56 | File tab / Assets / Libraries | ⌥1 / ⌥2 / ⌥3 | Alt+1 / Alt+2 / Alt+3 |
| 57 | Actions menu (quick actions) | ⌘K | Ctrl+K |
| 58 | Shortcuts panel | ⌃⇧? | Ctrl+Shift+? |
| 59 | Dev Mode toggle | ⇧D | Shift+D |
| 60 | Design ↔ Prototype tab | ⇧E | Shift+E |
| 61 | Present (presentation view) | ⌘⌥Return | Ctrl+Alt+Enter *(Win keys truncated in source)* |
| 62 | Save to version history | ⌘⌥S | Ctrl+Alt+S |
| 63 | Export (from version view) | ⌘⇧E | Ctrl+Shift+E |
| 64 | Resize to fit (frame) | ⌥⇧⌘R | Alt+Shift+Ctrl+R |
| 65 | Cursor chat | / | / |
| 66 | Add code block | ` | ` |
| 67 | Quick insert (component) | ⇧I | Shift+I |
| 68 | Focus toolbar (keyboard a11y) | F6 | Ctrl+F6 |
| 69 | Keyboard box selection | ⌥Space | Ctrl+Space |
| 70 | Remove fill / remove stroke | ⌥/ / ⇧/ | Alt+, / Shift+, |
| 71 | Font size ↓/↑ | ⇧⌘< / ⇧⌘> | Shift+Ctrl+< / > |
| 72 | Font weight ↓/↑ | ⌥⌘< / ⌥⌘> | Alt+Ctrl+< / > |
| 73 | Letter spacing ↓/↑ | ⌘< / ⌘> | Ctrl+< / > |
| 74 | Line height ↓/↑ | ⇧⌥< / ⇧⌥> | Shift+Alt+< / > |
| 75 | Bold / italic (comment & text) | ⌘B / ⌘I | Ctrl+B / Ctrl+I |
| 76 | List indent (text) | ⌘[ / ⌘] | Ctrl+[ / Ctrl+] |
| 77 | Auto-layout alignment box keys | arrows; W/A/S/D edge; B baseline; X gap | same |
| 78 | Edit padding field (all sides) | ⌘+click padding input | Ctrl+click |

Notes: Mac ⌘=Cmd, ⌥=Option/Alt, ⌃=Control, ⇧=Shift. Rulers toggle shortcut not found in raw data (**Shift+R unverified**). Shortcuts are US QWERTY; other layouts remappable (Preferences > Keyboard layout).

## 7. Component workflows

- **Create component**: select layers → Create component button (right sidebar, next to selection name) / right-click > Create component / **⌥⌘K / Ctrl+Alt+K**. Purple component icon in Layers. Bulk: ⌥+click "Create multiple components" (one per frame/group/boolean/path). Delete main component leaves instances (restore via instance: "Restore Component" / "Go to main component in library" > Restore).
- **Variants**: select component → **Create variant** (right sidebar) → component set; variant properties edited next to property name; duplicate variants with ⌘D. (help: Create and use variants.)
- **Component properties**: variant, boolean (show/hide), instance swap, text properties; defaults set on main component/component set (help: Explore component properties).
- **Instances**: insert via Assets tab drag, component details modal (Insert instance), quick insert **⇧I** (Actions menu), duplicate ⌘D / ⌥+drag / copy-paste. Overrides: fills, text, exposed properties; reset to remove overrides; layer reorder/add/delete requires main component (instance delete = hide).
- **Swap**: swap instance via instance menu/assets; Alt+drag a component above an instance on canvas (release mouse then modifier) *(partially verified)*.
- **Detach instance**: Instance menu / right-click / **⌥⌘B / Ctrl+Alt+B** → becomes regular frame, link removed.
- **Libraries/assets**: publish components/styles/variables as library via Libraries modal (Assets tab > Libraries, ⌥3); blue dot = updates to review; drag from assets view to canvas.

## 8. Sections, comments, Dev Mode, history

- **Sections**: top-level canvas regions; create via toolbar/Section tool **⇧S**, drag over objects, or right-click selection > **Wrap in new section**; title via double-click; Fill/Stroke apply; Share button; **Mark as ready for dev** (→ Ready for dev → auto "Changed" status when edited, resolve with a reason); delete with contents (Delete) or without (**⌘Delete / Ctrl+Backspace**); double-click section icon in Layers to navigate; prototyping: connections to sections remember last visited frame.
- **Comments**: press **C** / toolbar; click canvas to pin; view/manage in Comment tab (view access: search, filter unread); **⇧C** hide/show; Esc exits comment mode; markdown (⌘B bold, ⌘I italic); resolve/delete; mobile long-press.
- **Dev Mode**: toolbar toggle / **⇧D**; paid plans, Full/Dev seat. Left sidebar: ready-for-dev assets, last-edited timestamps, sections prioritized. Inspect panel: layer name/type, **Compare changes** / Compare with main component, dev resource links (GitHub/Jira/Storybook), component info, **Explore component behavior** (component playground), **Code Connect** snippets, layer properties **Code ↔ List** toggle (CSS/iOS/Android + codegen plugins), applied styles/variables, downloadable assets (auto icon detection toggle: Main menu > View > Automatically detect icons), export (PNG/JPG/SVG/PDF). Annotations + measurements (Full/Dev seats). Statuses: Ready for dev (all paid), Completed (Org/Enterprise). Plugins tab; Figma for VS Code extension.
- **Version history**: file name menu > **Show Version History** (right sidebar); autosave checkpoint every 30 min; **Save to Version History ⌘⌥S / Ctrl+Alt+S** (title ≤25 chars, description ≤140); view/duplicate/restore/Copy link/Delete Version Info; restoring keeps all comments; 30-day limit on Starter/Drafts; browser restore: ⇧⌃⌥+click file (Mac) / Alt+Shift (Win) > Restore from version.

## 9. Sources (URLs actually used)

**Full pages (r3-page-*.json):**
1. https://help.figma.com/hc/en-us/articles/360039831974-Explore-the-navigation-bar-and-left-sidebar
2. https://help.figma.com/hc/en-us/articles/360039832014-Design-prototype-and-explore-layer-properties-in-the-rig (right sidebar)
3. https://help.figma.com/hc/en-us/articles/360041064174-Access-design-tools-from-the-toolbar
4. https://help.figma.com/hc/en-us/articles/23570416033943-Use-the-actions-menu-in-Figma-Design
5. https://help.figma.com/hc/en-us/articles/15297425105303-Explore-design-files
6. https://help.figma.com/hc/en-us/articles/360040449873-Select-layers-and-objects
7. https://help.figma.com/hc/en-us/articles/360041539473-Frames-in-Figma-Design
8. https://help.figma.com/hc/en-us/articles/4409078832791-Copy-and-paste-objects
9. https://help.figma.com/hc/en-us/articles/360039956914-Adjust-alignment-rotation-position-and-dimensions
10. https://help.figma.com/hc/en-us/articles/360040451373-Guide-to-auto-layout
11. https://help.figma.com/hc/en-us/articles/360038662654-Guide-to-components-in-Figma
12. https://help.figma.com/hc/en-us/articles/360039150173-Create-and-insert-component-instances
13. https://help.figma.com/hc/en-us/articles/360038663154-Create-components-to-reuse-in-designs
14. https://help.figma.com/hc/en-us/articles/360038665754-Detach-an-instance-from-the-component
15. https://help.figma.com/hc/en-us/articles/360039957534-Boolean-operations
16. https://help.figma.com/hc/en-us/articles/360040450253-Masks
17. https://help.figma.com/hc/en-us/articles/30101373312279-Flatten-layers
18. https://help.figma.com/hc/en-us/articles/9771500257687-Organize-your-canvas-with-sections
19. https://help.figma.com/hc/en-us/articles/360040449713-Add-guides-to-the-canvas-or-frames
20. https://help.figma.com/hc/en-us/articles/5724448965527-View-layer-outlines-in-Figma-Design
21. https://help.figma.com/hc/en-us/articles/360041065034-Adjust-your-zoom-and-view-options
22. https://help.figma.com/hc/en-us/articles/360039956434-Guide-to-text-in-Figma-Design
23. https://help.figma.com/hc/en-us/articles/360039956974-Measure-distances-between-layers
24. https://help.figma.com/hc/en-us/articles/15023124644247-Guide-to-Dev-Mode
25. https://help.figma.com/hc/en-us/articles/360038006754-View-a-file-s-version-history
26. https://help.figma.com/hc/en-us/articles/360039825314-Guide-to-comments-in-Figma
27. https://help.figma.com/hc/en-us/articles/360040450133-Shape-tools
28. https://help.figma.com/hc/en-us/articles/360040328653-Use-Figma-products-with-a-keyboard
29. https://help.figma.com/hc/en-us/articles/5665442977431-Select-keyboard-layout
30. https://help.figma.com/hc/en-us/articles/360040451453-Scale-layers-while-maintaining-proportions (snippet, r3-toolbar.json)

**Gap-fill searches (R3b):**
31. https://help.figma.com/hc/en-us/articles/360040450213-Vector-networks (Pen = P)
32. https://help.figma.com/hc/en-us/articles/4402723791511-Sketch-on-the-canvas-with-the-pencil-tool (Pencil = ⇧P)
33. https://help.figma.com/hc/en-us/articles/360041596573-Lock-and-unlock-layers (⌘⇧L)
34. https://help.figma.com/hc/en-us/articles/360039958934-Rename-Layers (⌘R/Ctrl+R)
35. https://help.figma.com/hc/en-us/articles/360040318013-Play-your-prototypes (Present ⌘⌥Return)
36. https://help.figma.com/hc/en-us/articles/1500004414962-Group-objects-in-FigJam (⌘G / ⌘⇧G)
37. https://help.figma.com/hc/en-us/articles/360040028114-Export-static-designs-from-Figma (Slice in Region tools)
38. https://blog.logrocket.com/ux-design/slice-tool-figma (Slice = S, third-party)
39. https://help.figma.com/hc/en-us/articles/360041068574-Add-comments-to-files, /360041547593-View-and-manage-comments (C, ⇧C, ⌘B/⌘I)
40. https://help.figma.com/hc/en-us/articles/360047239073-Convert-text-to-vector-paths (Outline stroke ⌘⌥O)
41. https://help.figma.com/hc/en-us/articles/360040314193-Guide-to-prototyping-in-Figma (⇧E tabs)
42. https://www.topcoder.com/thrive/articles/top-shortcuts-for-figma (⇧0 zoom 100%, third-party)

*(Note: r3-page-cheatsheet.json — figma.com/figma-keyboard-shortcuts/ — returned a 404 page; no data used from it.)*
