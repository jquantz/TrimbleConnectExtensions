# Construction Sequencer: a Trimble Connect 3D Viewer extension

Metropolitan Timber · v1.0

This extension runs as a side panel inside the Trimble Connect for Browser 3D Viewer. You use it to:

1. **Record** an erection sequence by clicking objects in the order they will be installed (Phase 1).
2. **Fine-tune** that sequence from a CSV schedule. Rows are matched to objects by **GUID** first and then by **Mark** (Phase 2). If you turn on **Auto-assign on select**, clicking any object looks it up in the schedule and gives it the right sequence.
3. **Write** the Sequence ID, step number, phase and date into a Trimble Connect **property set** on each model object, so everyone on the project can see them in the Properties panel.
4. **Play** the build: future steps are hidden or ghosted, the current step is highlighted, and finished steps are coloured by phase.

---

## 1. Host the files

The extension is a static web page, so there is no build step and no server code. Put the whole folder on any **HTTPS** host. Some options:

- **GitHub Pages**: push the folder to a repo and turn on Pages. You get a URL like `https://<org>.github.io/tc-sequencer/`.
- An Azure Static Web App, an AWS S3 bucket behind CloudFront, Netlify, or your company web server.

Then edit `manifest.json` and replace `https://YOUR-HOST/tc-sequencer/` with your real URL in `url`, `icon` and `infoUrl`.

> To try it before hosting, run `python -m http.server` in the folder and open `http://localhost:8000/index.html?mock`. This starts a demo mode with a fake 2-storey timber frame and a fake property-set service.

## 2. Install it in Trimble Connect

1. Open a project in Trimble Connect for Browser and go to **Settings → Extensions** (some versions call it Apps & Capabilities).
2. Choose **Add custom extension** and paste the URL of your `manifest.json`.
3. Open a model in the **3D Viewer**. **Construction Sequencer** now appears in the viewer's extension side panel.

## 3. One-time property set setup (for writing the Sequence ID)

You need a Trimble Connect **Business Premium** (or higher) licence to create property sets. Do this once per project, or use a shared library:

1. In Trimble Connect, create a **property set library** (for example *Metropolitan Timber*).
2. In that library, create a **property set** called *Construction Sequence* with these fields:

   | Field | Type | Notes |
   |---|---|---|
   | `SequenceID` | Text | **Required.** Example: `L2-CLT-014` |
   | `SequenceNo` | Integer | Step order, used to sort |
   | `Phase` | Text | Example: `Level 2` |
   | `PlannedDate` | Text / Date | Optional, shown during playback |

3. In the extension, open **Write → Connect to property sets**. The first time, Connect asks you to let the extension use your session; click allow. Then pick the library and the property set. The field mapping fills itself in when your field names look like the ones above.

### Object link format (important, check this once)

A property set value is attached to a model object through a *link*. The default the extension uses is `frn:entity:{guid}`. To make sure it matches what Trimble Connect uses on your models:

1. In the 3D Viewer, select **one** object, open **Properties → Add properties**, add the *Construction Sequence* set and type any value.
2. In the extension, press **Write → Detect**. It reads that link and learns the exact format, for example `frn:entity:{guid}` or a version that includes the model ID. The format is saved for future writes.

After you write, select an object and open its Properties panel. The *Construction Sequence* set shows the value. If it doesn't show up right away, reload the model.

## 4. Workflow

### Phase 1: record by clicking
- **Record** tab: set the **Phase / prefix** (for example `L1`) and the **ID format** (`{phase}-{n:3}` produces `L1-001`). Press **Start recording**.
- Click objects in the 3D view in erection order. Each click becomes the next step.
- To put several objects in one step (for example a whole bay of joists or a multi-piece lift), Ctrl-click or box-select them together. You can also tick **Hold step** and click them one by one, then press **Next step ›**.
- If you click an object that already has a sequence, it is skipped. Tick **Re-sequence** if you want to move it.
- **Re-order by dragging** in the list:
  - Drag the **⋮⋮** grip (mouse, pen or touch) to move one object. If several rows are selected, they all move together.
  - Drag the **step number** to move the whole step.
  - Drop on the **top or bottom edge** of a row to make a new step before or after it, or on the **middle** of a row to join that step.
  - Click-recorded steps are renumbered automatically, so IDs always follow the order. IDs that came from a CSV, or that you typed yourself, are kept. A piece split off one of those steps gets a suffix, for example `L1-COL-01-2`.
- **Undo last step**, **Remove selected**, **Renumber** (closes gaps) and inline editing of any ID in the list are all available.

### Phase 2: fine-tune from a CSV schedule
- **Schedule** tab: drop in a CSV (`samples/schedule_template.csv` shows the layout):

  ```
  GUID,Mark,SequenceID,Order,Phase,PlannedDate
  ,C101,L1-COL-01,1,Level 1,2027-03-01
  ```

  - **GUID** can be in any format: an IFC 22-character GlobalId, a 36-character UUID, or Tekla's `ID…` format.
  - **Mark** is read from the object property listed in **⚙ Settings**. The default is Tekla's *Assembly/Cast unit Mark*, then `Mark` and `Tag`. Use **Show properties of selected object** to pick the right one for your models.
  - Rows that share a SequenceID become **one step** (one lift or pick).
  - **Order** sets the playback order. Without it, steps sort naturally by ID.
- **Apply to**: choose *Objects already in my sequence* to only re-label what you clicked, or *Every matching object in the loaded models* to sequence straight from the schedule.
- Press **Match**, check the report (rows that matched nothing, marks shared by several objects, objects missing from the CSV), then press **Apply**.
- **Auto-assign on select**: with a schedule loaded, selecting objects in the 3D view assigns their sequence immediately.

### Play
Use ▶ to play, step with ◀ and ▶|, or drag the slider. You can choose the speed, whether future steps are hidden or ghosted, how unsequenced objects look, and whether finished steps are coloured by phase.

### Export a video
- In the **Play** tab, set the playback options and position the camera in the 3D view, then choose a resolution (720p or 1080p) and a time per step, and press **Export MP4**.
- The extension steps through the sequence, captures the 3D view at every step, and makes an H.264 MP4. A caption band can show the Sequence ID, phase, date and progress. The video starts with a 1 s intro and holds the last step for 2 s.
- Leave the 3D view alone while it records. A preview opens when it's done, and the file downloads straight away. If your browser blocks the download inside Connect, right-click the preview and choose **Save Video As**.
- You need a current Chrome, Edge or Firefox. On older browsers it falls back to a WebM file.

### Write and share
- **Write changes** pushes only the objects you edited (shown with ● in the list). **Write selected** and **Rewrite all** are also available. Writes go in batches of 500.
- **Load sequence from property set** rebuilds the sequence from what's stored in Connect, so a teammate can open the same animation.
- **Download sequence CSV** exports GUID, IFC GUID, Mark, SequenceID, Step, Phase and Date. You can edit it in Excel and load it back, or use it to push the value into Tekla (for example as a UDA through an attribute import) or Revit as a native parameter.

Your work in progress is also saved automatically in your browser for each project.

## 5. Notes and limits

- **Marks aren't always unique.** Identical Tekla assemblies share a mark, so a mark-only CSV row tags *all* of them, and the Match report lists these cases. Use GUIDs when identical pieces need different sequences.
- **Assembly vs part selection.** If assembly selection is on in the viewer, one click selects every part of the assembly, and they all land in the same step.
- GUIDs come from the viewer's external object IDs. For IFC models these are stable across model versions, so a sequence carries over to the next revision.
- The property set service is reached in the project's region (North America, Europe or Asia-Pacific). Choose a different one in ⚙ if needed.

## Files

```
manifest.json        Extension manifest (edit the URLs)
index.html           Panel UI
css/app.css
js/app.js            UI and workflow
js/video.js          MP4 export (WebCodecs + vendored mp4-muxer, MIT)
js/vendor/           mp4-muxer library
js/tc.js             Workspace API wrapper (selection, properties, colour/visibility)
js/pset.js           Property Set + Organizer REST client
js/seqcore.js        Pure logic: GUID conversion, CSV, matching, steps (unit-tested)
js/mock.js           Local demo viewer (only loads with ?mock or outside Connect)
tools/build_demo.py  Bundles a single-file demo page into dist/demo.html
samples/schedule_template.csv
tests/seqcore.test.mjs   Run with: npm test
```
